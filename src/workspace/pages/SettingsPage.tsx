/**
 * 设置页：插件独立模式的 provider 配置。
 *
 * - 卡片 / 问答：Anthropic-compatible provider（默认 DeepSeek 端点）
 * - 语义检索（可选）：OpenAI-compatible embedding provider
 * - API key 只存本机（chrome.storage.local）；保存时按 origin 申请 host permission
 * - 「测试连接」做最小开销的真实调用，失败原因直接展示（Fail fast）
 */
import { useCallback, useEffect, useState } from "react";
import { getApi } from "@/shared/api";
import {
  DEFAULT_SETTINGS,
  ensureOriginPermission,
  loadSettings,
  saveSettings,
  type LocalSettings,
} from "@/local/settings";
import { testChatConnection, testEmbeddingConnection } from "@/local/provider";

type TestState = { status: "idle" | "testing" | "ok" | "fail"; message: string };

const IDLE_TEST: TestState = { status: "idle", message: "" };

export function SettingsPage({ onToast, onSaved }: { onToast: (message: string) => void; onSaved: () => void }) {
  const [settings, setSettings] = useState<LocalSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [chatTest, setChatTest] = useState<TestState>(IDLE_TEST);
  const [embeddingTest, setEmbeddingTest] = useState<TestState>(IDLE_TEST);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  const updateChat = useCallback((patch: Partial<LocalSettings["chat"]>) => {
    setSettings((current) => (current ? { ...current, chat: { ...current.chat, ...patch } } : current));
    setChatTest(IDLE_TEST);
  }, []);

  const updateEmbedding = useCallback((patch: Partial<LocalSettings["embedding"]>) => {
    setSettings((current) => (current ? { ...current, embedding: { ...current.embedding, ...patch } } : current));
    setEmbeddingTest(IDLE_TEST);
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      // provider 域名需要 host permission 才能从扩展发请求；逐个申请
      const granted = await ensureOriginPermission(settings.chat.baseUrl);
      if (settings.embedding.enabled) {
        await ensureOriginPermission(settings.embedding.baseUrl);
      }
      await saveSettings(settings);
      onSaved();
      onToast(granted ? "设置已保存。" : "设置已保存，但未获得 provider 域名权限，调用可能失败。");
    } catch (cause) {
      onToast(`保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setSaving(false);
    }
  }, [settings, onSaved, onToast]);

  const runChatTest = useCallback(async () => {
    if (!settings) return;
    setChatTest({ status: "testing", message: "正在调用 provider…" });
    try {
      const latency = await testChatConnection(settings.chat);
      setChatTest({ status: "ok", message: `连接成功（${latency}ms）` });
    } catch (cause) {
      setChatTest({ status: "fail", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [settings]);

  const runEmbeddingTest = useCallback(async () => {
    if (!settings) return;
    setEmbeddingTest({ status: "testing", message: "正在调用 embedding provider…" });
    try {
      const latency = await testEmbeddingConnection(settings.embedding);
      setEmbeddingTest({ status: "ok", message: `连接成功（${latency}ms）` });
    } catch (cause) {
      setEmbeddingTest({ status: "fail", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [settings]);

  const clearLibrary = useCallback(async () => {
    // 二次确认：清空不可撤销，provider 设置与 API key 保留
    const confirmed = window.confirm(
      "确定清空本机知识库？\n\n收藏记录、原文快照、卡片与问答历史都会被删除，不可恢复。provider 设置与 API key 保留。",
    );
    if (!confirmed) return;
    setClearing(true);
    try {
      await getApi().clearLibrary();
      onSaved(); // 刷新顶栏状态 chips（卡片数归零）
      onToast("知识库已清空。provider 设置保留。");
    } catch (cause) {
      onToast(`清空失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setClearing(false);
    }
  }, [onSaved, onToast]);

  if (!settings) {
    return (
      <div className="page">
        <div className="page-body">加载设置中…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
        <p>配置本地模型，数据不出这台机器。</p>
      </div>

      <div className="page-body">
        <div className="settings-grid">
          <section className="settings-section">
            <h2>卡片 / 问答 provider</h2>
            <p className="settings-hint">Anthropic-compatible 端点（默认 DeepSeek / deepseek-v4-flash）。未配置时收藏会在「生成卡片」阶段明确失败。</p>
            <label className="settings-field">
              <span>名称</span>
              <input value={settings.chat.provider} onChange={(event) => updateChat({ provider: event.target.value })} />
            </label>
            <label className="settings-field">
              <span>Base URL</span>
              <input
                value={settings.chat.baseUrl}
                onChange={(event) => updateChat({ baseUrl: event.target.value })}
                placeholder={DEFAULT_SETTINGS.chat.baseUrl}
              />
            </label>
            <label className="settings-field">
              <span>模型</span>
              <input value={settings.chat.model} onChange={(event) => updateChat({ model: event.target.value })} />
            </label>
            <label className="settings-field">
              <span>API key</span>
              <input
                type="password"
                value={settings.chat.apiKey}
                onChange={(event) => updateChat({ apiKey: event.target.value })}
                placeholder="sk-…"
                autoComplete="off"
              />
            </label>
            <div className="settings-actions">
              <button type="button" className="btn" onClick={() => void runChatTest()} disabled={chatTest.status === "testing"}>
                测试连接
              </button>
              {chatTest.message && (
                <span className={`test-result ${chatTest.status}`}>{chatTest.message}</span>
              )}
            </div>
          </section>

          <section className="settings-section">
            <h2>语义检索 embedding（可选）</h2>
            <p className="settings-hint">OpenAI-compatible 端点（默认 SiliconFlow）。不启用时检索为纯关键词（FTS）。</p>
            <label className="settings-field settings-checkbox">
              <input
                type="checkbox"
                checked={settings.embedding.enabled}
                onChange={(event) => updateEmbedding({ enabled: event.target.checked })}
              />
              <span>启用语义检索（卡片生成后为卡片补充向量）</span>
            </label>
            {settings.embedding.enabled && (
              <>
                <label className="settings-field">
                  <span>Base URL</span>
                  <input
                    value={settings.embedding.baseUrl}
                    onChange={(event) => updateEmbedding({ baseUrl: event.target.value })}
                    placeholder={DEFAULT_SETTINGS.embedding.baseUrl}
                  />
                </label>
                <label className="settings-field">
                  <span>模型</span>
                  <input
                    value={settings.embedding.model}
                    onChange={(event) => updateEmbedding({ model: event.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>API key</span>
                  <input
                    type="password"
                    value={settings.embedding.apiKey}
                    onChange={(event) => updateEmbedding({ apiKey: event.target.value })}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                </label>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void runEmbeddingTest()}
                    disabled={embeddingTest.status === "testing"}
                  >
                    测试连接
                  </button>
                  {embeddingTest.message && (
                    <span className={`test-result ${embeddingTest.status}`}>{embeddingTest.message}</span>
                  )}
                </div>
              </>
            )}
          </section>

          <section className="settings-section">
            <h2>本机数据</h2>
            <p className="settings-hint">
              收藏记录、原文快照、卡片与问答历史都保存在浏览器 IndexedDB。清空后不可恢复；
              provider 设置与 API key 保留。
            </p>
            <button type="button" className="btn btn-danger" onClick={() => void clearLibrary()} disabled={clearing}>
              {clearing ? "清空中…" : "清空知识库"}
            </button>
          </section>
        </div>

        <div className="settings-save">
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存设置"}
          </button>
          <span className="settings-hint">保存时会为 provider 域名申请访问权限（浏览器弹窗确认）。</span>
        </div>
      </div>
    </div>
  );
}
