import type { StoredCapture, StoredCard, StoredChatTurn, StoredDocument, StoredKaleidoscopeEdge, TuntaStore } from "./types";

/**
 * IDB → SQLite 一次性迁移（计划 §Task1.4）。
 * 硬规则 1：绝不删除 IndexedDB 数据，旧库保留到 Phase 4 结束后由人工清理。
 * 可断点续传：按表分段，每张表完成后立刻写进度；SW 被杀后重跑会跳过已完成的表。
 */

export const MIGRATION_KEY = "tunta:migration-state";

const TABLES = ["captures", "documents", "cards", "chat_history", "kaleidoscope_edges"] as const;
export type MigrationTable = (typeof TABLES)[number];

export interface MigrationState {
  startedAt?: string;
  /** 已完成的表 → 写入行数。断点续传的依据。 */
  done?: Partial<Record<MigrationTable, number>>;
  /** 迁移期间跳过的孤儿卡片数（sourceId 对应的 document 不存在，外键约束不允许）。 */
  skippedOrphanCards?: number;
  migratedAt?: string;
  counts?: Partial<Record<MigrationTable, number>>;
  lastError?: string;
}

export async function readMigrationState(): Promise<MigrationState> {
  const raw = await chrome.storage.local.get(MIGRATION_KEY);
  return (raw[MIGRATION_KEY] as MigrationState | undefined) ?? {};
}

async function writeMigrationState(state: MigrationState): Promise<void> {
  await chrome.storage.local.set({ [MIGRATION_KEY]: state });
}

export async function isMigrated(): Promise<boolean> {
  return Boolean((await readMigrationState()).migratedAt);
}

interface TableSpec {
  read(store: TuntaStore): Promise<unknown[]>;
  write(store: TuntaStore, rows: unknown[]): Promise<void>;
  count(store: TuntaStore): Promise<number>;
}

const BATCH_SIZE = 200;

const SPECS: Record<MigrationTable, TableSpec> = {
  captures: {
    read: (store) => store.listCaptures(),
    write: async (store, rows) => {
      for (const row of rows as StoredCapture[]) await store.putCapture(row);
    },
    count: async (store) => (await store.listCaptures()).length,
  },
  documents: {
    read: (store) => store.listDocuments(),
    write: async (store, rows) => {
      for (const row of rows as StoredDocument[]) await store.putDocument(row);
    },
    count: async (store) => (await store.listDocuments()).length,
  },
  cards: {
    read: (store) => store.listCards(),
    write: async (store, rows) => {
      const cards = rows as StoredCard[];
      for (let i = 0; i < cards.length; i += BATCH_SIZE) {
        await store.putCards(cards.slice(i, i + BATCH_SIZE));
      }
    },
    count: async (store) => (await store.listCards()).length,
  },
  chat_history: {
    read: (store) => store.listChatTurns(),
    write: async (store, rows) => {
      for (const row of rows as StoredChatTurn[]) await store.putChatTurn(row);
    },
    count: async (store) => (await store.listChatTurns()).length,
  },
  kaleidoscope_edges: {
    read: (store) => store.listKaleidoscopeEdges(),
    write: async (store, rows) => {
      const edges = rows as StoredKaleidoscopeEdge[];
      for (let i = 0; i < edges.length; i += BATCH_SIZE) {
        await store.putKaleidoscopeEdges(edges.slice(i, i + BATCH_SIZE));
      }
    },
    count: async (store) => (await store.listKaleidoscopeEdges()).length,
  },
};

/**
 * 执行迁移。已完成时立即返回 true；任何一张表校验失败都中止并保持 IDB 为准（返回 false）。
 * 幂等：所有写入都是 upsert，中途被杀后整表重跑是安全的。
 */
export async function runMigration(source: TuntaStore, target: TuntaStore): Promise<boolean> {
  const state = await readMigrationState();
  if (state.migratedAt) return true;

  if (!state.startedAt) {
    state.startedAt = new Date().toISOString();
    state.done = {};
    await writeMigrationState(state);
  }
  state.done ??= {};

  try {
    // documents 必须先于 cards（外键）；TABLES 的顺序已保证
    for (const table of TABLES) {
      if (state.done[table] !== undefined) continue;

      const spec = SPECS[table];
      let rows = await spec.read(source);

      if (table === "cards") {
        // 外键保护：IDB 里可能存在 document 已丢失的孤儿卡片，SQLite 不允许写入
        const knownSources = new Set((await source.listDocuments()).map((doc) => doc.sourceId));
        const orphans = (rows as StoredCard[]).filter((card) => !knownSources.has(card.sourceId));
        if (orphans.length > 0) {
          console.warn(`[tunta] 迁移跳过 ${orphans.length} 张孤儿卡片（document 缺失）`);
          state.skippedOrphanCards = orphans.length;
          rows = (rows as StoredCard[]).filter((card) => knownSources.has(card.sourceId));
        }
      }

      await spec.write(target, rows);

      const written = await spec.count(target);
      if (written !== rows.length) {
        state.lastError = `表 ${table} 行数校验失败：期望 ${rows.length}，实际 ${written}`;
        await writeMigrationState(state);
        console.error(`[tunta] 迁移中止，保持 IndexedDB 为准：${state.lastError}`);
        return false;
      }

      state.done[table] = written;
      delete state.lastError;
      await writeMigrationState(state);
    }

    state.migratedAt = new Date().toISOString();
    state.counts = { ...state.done };
    await writeMigrationState(state);
    console.info("[tunta] IDB → SQLite 迁移完成:", state.counts);
    return true;
  } catch (cause) {
    state.lastError = cause instanceof Error ? cause.message : String(cause);
    await writeMigrationState(state);
    console.error("[tunta] 迁移失败，保持 IndexedDB 为准:", cause);
    return false;
  }
}
