import type { CaptureFailure } from "@/shared/api/contracts";
import { generateCardsForDocument } from "./cards";
import { chunkBlocks } from "./chunk";
import { linkSourceIntoGraph } from "./kaleidoscope";
import {
  getStore,
  type StoredCapture,
  type StoredDocument,
} from "./store";
import { buildParserOutput, isXiaohongshuUrl, toCaptureParseWarnings } from "./parser";
import { callEmbedding, ProviderError } from "./provider";
import { isChatConfigured, isEmbeddingConfigured, loadSettings, type LocalSettings } from "./settings";
import { expandListCaptures } from "./expand";
import { executeSnapshotOnTab, SnapshotError, type SnapshotData } from "./snapshot";

const TAB_LOAD_TIMEOUT_MS = 45_000;

/**
 * 续跑阈值必须大于任何单阶段的最长耗时（页面加载 45s、provider 90s），
 * 否则调用还活着就会被重复触发——running 是内存态 Set，SW 一重启就拦不住。
 */
const STUCK_THRESHOLD_MS = 180_000;

/** 自动续跑的次数上限。兜底不该是无限的：用尽后写 failed，让用户看见它放弃了。 */
const MAX_RESUME_ATTEMPTS = 3;

export const PIPELINE_STALLED = "PIPELINE_STALLED";

function nowIso(): string {
  return new Date().toISOString();
}

function waitTabLoaded(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new SnapshotError("FETCH_TIMEOUT", `页面加载超时（${Math.round(timeoutMs / 1000)}s）。`));
    }, timeoutMs);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(() => undefined);
  });
}


async function snapshotForUrl(url: string, tabId?: number): Promise<SnapshotData> {
  if (tabId == null && isXiaohongshuUrl(url)) {
    throw new SnapshotError(
      "XHS_ACTIVE_TAB_REQUIRED",
      "小红书 local 抓取不打开隐藏后台页：请在目标笔记页点击插件主动收藏。",
      true,
    );
  }
  let targetTabId = tabId ?? null;
  let created = false;
  if (targetTabId == null) {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id == null) throw new SnapshotError("FETCH_TAB_FAILED", "无法打开后台标签页抓取页面。");
    targetTabId = tab.id;
    created = true;
    try {
      await waitTabLoaded(targetTabId, TAB_LOAD_TIMEOUT_MS);
    } catch (cause) {
      await chrome.tabs.remove(targetTabId).catch(() => undefined);
      throw cause;
    }
  }
  try {
    return await executeSnapshotOnTab(targetTabId, url);
  } catch (cause) {
    if (cause instanceof SnapshotError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/Cannot access|permission|No tab|cannot be scripted/i.test(message)) {
      throw new SnapshotError("FETCH_NO_PERMISSION", `没有该页面的访问权限或标签页已关闭：${message}`);
    }
    throw new SnapshotError("FETCH_SNAPSHOT_FAILED", `页面快照失败：${message}`);
  } finally {
    if (created && targetTabId != null) {
      await chrome.tabs.remove(targetTabId).catch(() => undefined);
    }
  }
}


function toFailure(cause: unknown): CaptureFailure {
  if (cause instanceof SnapshotError) {
    return { code: cause.code, message: cause.message, stage: "fetch", recoverable: cause.recoverable };
  }
  if (cause instanceof ProviderError) {
    const stage = cause.code.startsWith("CARDS") || cause.code.startsWith("PROVIDER") ? "generate" : "unknown";
    return { code: cause.code, message: cause.message, stage, recoverable: true };
  }
  return {
    code: "PIPELINE_UNKNOWN",
    message: cause instanceof Error ? cause.message : String(cause),
    stage: "unknown",
    recoverable: true,
  };
}















const running = new Set<string>();

/**
 * 列表展开产生的子收藏在父流水线里串行排队。排队期间它们是 idle 且 updatedAt 不动，
 * 续跑扫描会误判成卡住——既会重复触发，又会白白烧掉 attempts 配额。
 * 两个 Set 都是内存态，SW 一重启就清空：那时父循环也没了，子收藏确实该被续跑。
 */
const queued = new Set<string>();

async function save(capture: StoredCapture): Promise<StoredCapture> {
  const next = { ...capture, updatedAt: nowIso() };
  await getStore().putCapture(next);
  return next;
}

/** chunk 批量 embed 的单次输入上限：长视频 30~80 个 chunk 分 2~3 次请求，不撞 provider 限制。 */
const CHUNK_EMBED_BATCH = 32;

/**
 * embed 阶段主体（计划 §Task2.3）：cards 与原文 chunks 都写 embeddings 表。
 * 写入前查表去重：同一 source 重跑流水线不会重复烧 embedding 配额。
 */
async function embedSourceContent(settings: LocalSettings, sourceId: string): Promise<void> {
  const model = settings.embedding.model;
  const createdAt = nowIso();

  // cards：缺向量的补 embed；已有 card.embedding 的只回填 embeddings 表（视为当前模型，换模型盘点走 listEmbeddingModels）
  const embeddedCards = new Set(await getStore().listEmbeddedOwnerIds("card", model));
  const cards = (await getStore().listCardsBySource(sourceId)).filter((card) => !embeddedCards.has(card.cardId));
  const pending = cards.filter((card) => !card.embedding?.length);
  if (pending.length > 0) {
    const vectors = await callEmbedding(settings.embedding, pending.map((card) => `${card.title}\n${card.body}`));
    // retrieve 的向量路径暂仍读 card.embedding，双写到 Task2.3b 切换后移除
    await getStore().putCards(pending.map((card, index) => ({ ...card, embedding: vectors[index] })));
    pending.forEach((card, index) => { card.embedding = vectors[index]; });
  }
  await getStore().putEmbeddings(
    cards
      .filter((card) => card.embedding?.length)
      .map((card) => ({ ownerKind: "card" as const, ownerId: card.cardId, model, vector: card.embedding as number[], createdAt })),
  );

  // chunks：先持久化 chunk 本体再分批 embed；重新聚合后消失的旧 chunk 向量一并清掉
  const doc = await getStore().getDocument(sourceId);
  if (!doc) return;
  const chunks = chunkBlocks(sourceId, doc.parserOutput.blocks);
  const currentIds = new Set(chunks.map((chunk) => chunk.chunkId));
  const stale = (await getStore().listChunksBySource(sourceId)).filter((chunk) => !currentIds.has(chunk.chunkId));
  if (stale.length > 0) await getStore().deleteEmbeddings("chunk", stale.map((chunk) => chunk.chunkId));
  await getStore().replaceChunksForSource(sourceId, chunks.map((chunk) => ({ ...chunk, createdAt })));

  const embeddedChunks = new Set(await getStore().listEmbeddedOwnerIds("chunk", model));
  const pendingChunks = chunks.filter((chunk) => !embeddedChunks.has(chunk.chunkId));
  for (let start = 0; start < pendingChunks.length; start += CHUNK_EMBED_BATCH) {
    const batch = pendingChunks.slice(start, start + CHUNK_EMBED_BATCH);
    const vectors = await callEmbedding(settings.embedding, batch.map((chunk) => chunk.text));
    await getStore().putEmbeddings(
      batch.map((chunk, index) => ({ ownerKind: "chunk" as const, ownerId: chunk.chunkId, model, vector: vectors[index], createdAt })),
    );
  }
}

async function execute(captureId: string, tabId?: number): Promise<void> {
  let capture = await getStore().getCapture(captureId);
  if (!capture || capture.status === "done" || capture.archived) return;
  const settings = await loadSettings();

  try {
    
    if (!capture.stage) {
      capture = await save({ ...capture, status: "fetching", failure: null });
      const snapshot = await snapshotForUrl(capture.url, tabId);
      const output = await buildParserOutput({
        originalUrl: capture.url,
        finalUrl: snapshot.finalUrl,
        title: snapshot.title,
        platform: snapshot.platform,
        contentType: snapshot.contentType,
        blocks: snapshot.blocks,
        jobId: `job:${capture.captureId}`,
        author: snapshot.author ?? null,
        publishedAt: snapshot.publishedAt ?? null,
        
        warnings: snapshot.warnings,
      });
      const doc: StoredDocument = {
        sourceId: output.source.source_id,
        url: output.source.original_url,
        title: output.source.title ?? capture.url,
        platform: output.source.platform,
        contentHash: output.parse.content_hash ?? "",
        parserOutput: output,
        createdAt: nowIso(),
      };
      await getStore().putDocument(doc);
      capture = await save({
        ...capture,
        status: "parsing",
        stage: "snapshot",
        sourceId: doc.sourceId,
        title: doc.title,
        parseWarnings: toCaptureParseWarnings(output.parse.warnings),
        ...(snapshot.listLinks?.length ? { expandLinks: snapshot.listLinks } : {}),
      });
    }

    

    if (capture.stage === "snapshot" && capture.expandLinks && capture.expandLinks.length > 0) {
      const { createdIds, skipped } = await expandListCaptures({ links: capture.expandLinks, intent: capture.intent });
      await save({
        ...capture,
        stage: "embed",
        status: "done",
        curationNote: `列表页：已展开为 ${createdIds.length} 个子收藏（页面共检测到 ${capture.expandLinks.length} 个链接，已在库跳过 ${skipped} 个），子收藏各自独立抓取与策展`,
      });
      

      for (const childId of createdIds) queued.add(childId);
      try {
        for (const childId of createdIds) {
          queued.delete(childId);
          await runPipeline(childId);
        }
      } finally {
        for (const childId of createdIds) queued.delete(childId);
      }
      return;
    }

    
    if (capture.stage === "snapshot") {
      const doc = capture.sourceId ? await getStore().getDocument(capture.sourceId) : undefined;
      if (!doc) {
        throw new ProviderError("本地文档缺失，无法生成卡片。", "STORE_DOCUMENT_MISSING");
      }
      capture = await save({ ...capture, status: "parsing" });
      const curation = await generateCardsForDocument(settings, doc);
      await getStore().replaceCardsForSource(doc.sourceId, curation.cards);
      
      if (curation.source.title || curation.source.summary) {
        await getStore().putDocument({
          ...doc,
          curatedTitle: curation.source.title ?? doc.curatedTitle,
          summary: curation.source.summary ?? doc.summary,
        });
      }
      if (!curation.assessment.worthKeeping) {
        
        console.info(`[tunta] AI 策展判定不卡片化（${capture.captureId}）：${curation.assessment.reason}`);
      }
      capture = await save({
        ...capture,
        stage: "cards",
        title: curation.source.title ?? capture.title,
        
        curationNote: curation.assessment.worthKeeping ? capture.curationNote : `AI 策展：${curation.assessment.reason}`,
      });
    }

    
    if (capture.stage === "cards") {
      if (isEmbeddingConfigured(settings) && capture.sourceId) {
        try {
          await embedSourceContent(settings, capture.sourceId);
        } catch (cause) {
          console.warn("[tunta] embedding 阶段失败（卡片保留 FTS 检索能力）:", cause);
        }
      }
      capture = await save({ ...capture, stage: "embed" });
    }

    
    if (capture.stage === "embed") {
      if (isChatConfigured(settings) && capture.sourceId) {
        try {
          const linked = await linkSourceIntoGraph(settings, capture.sourceId);
          console.info(`[tunta] 万花筒关联完成（${capture.captureId}）：${linked} 条关系边`);
        } catch (cause) {
          console.warn("[tunta] 万花筒关联失败（收藏不受影响）:", cause);
        }
      }
      capture = await save({ ...capture, stage: "graph" });
    }

    await save({ ...capture, status: "done", failure: null, attempts: 0 });
  } catch (cause) {
    const failure = toFailure(cause);
    const current = await getStore().getCapture(captureId);
    if (current) await save({ ...current, status: "failed", failure });
    console.warn(`[tunta] pipeline 失败（${captureId}）:`, failure);
  }
}


export async function runPipeline(captureId: string, options?: { tabId?: number }): Promise<void> {
  if (running.has(captureId)) return;
  running.add(captureId);
  try {
    await execute(captureId, options?.tabId);
  } finally {
    running.delete(captureId);
  }
}


export async function resumeStuckPipelines(): Promise<void> {
  const captures = await getStore().listCaptures();
  const cutoff = Date.now() - STUCK_THRESHOLD_MS;
  const stuck = captures.filter(
    (capture) =>
      (capture.status === "idle" || capture.status === "fetching" || capture.status === "parsing") &&
      !capture.archived &&
      !running.has(capture.captureId) &&
      !queued.has(capture.captureId) &&
      Date.parse(capture.updatedAt) < cutoff,
  );
  for (const capture of stuck) {
    const attempts = (capture.attempts ?? 0) + 1;
    if (attempts > MAX_RESUME_ATTEMPTS) {
      await save({
        ...capture,
        status: "failed",
        failure: {
          code: PIPELINE_STALLED,
          message: `流水线连续 ${MAX_RESUME_ATTEMPTS} 次续跑仍停在「${capture.status}」，已停止自动重试。请检查 provider 与网络链路后手动重试。`,
          stage: capture.status === "parsing" ? "generate" : "fetch",
          recoverable: true,
        },
      });
      console.warn(`[tunta] pipeline 续跑次数耗尽（${capture.captureId}），标记为失败`);
      continue;
    }

    await save({ ...capture, attempts });
    void runPipeline(capture.captureId);
  }
}
