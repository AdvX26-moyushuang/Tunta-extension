import { resumeStuckPipelines, runPipeline } from "@/local/pipeline";
import { resetStoreResolution } from "@/local/store";
import { IdbStore } from "@/local/store/idb-store";
import { runMigration } from "@/local/store/migrate";
import { SqliteStore } from "@/local/store/sqlite-store";
import type { TuntaMessage } from "@/shared/messages";

const RESUME_ALARM = "tunta:resume-pipelines";

/** IDB → SQLite 迁移：幂等、可断点续传，完成后刷新 getStore() 的解析缓存。 */
function ensureMigration(): void {
  void runMigration(new IdbStore(), new SqliteStore())
    .then((ok) => {
      if (ok) resetStoreResolution();
    })
    .catch((cause) => console.warn("[tunta] 迁移执行异常:", cause));
}

function setBadge(text: string, color = "#425cff"): void {
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setBadgeText({ text });
}

async function runWithBadge(captureId: string, tabId?: number): Promise<void> {
  setBadge("…");
  await runPipeline(captureId, { tabId });
  setTimeout(() => setBadge(""), 2000);
}

chrome.runtime.onInstalled.addListener(() => {
  setBadge("");
  void chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 1 });
  ensureMigration();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 1 });
  ensureMigration();
  void resumeStuckPipelines().catch((cause) => console.warn("[tunta] 续跑扫描失败:", cause));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM) {
    void resumeStuckPipelines().catch((cause) => console.warn("[tunta] 续跑扫描失败:", cause));
  }
});

chrome.runtime.onMessage.addListener((raw: TuntaMessage) => {
  if (raw?.type === "tunta:capture-submitted") {
    setBadge("…");
    setTimeout(() => setBadge(""), 8000);
    return;
  }
  if (raw?.type === "tunta:run-pipeline") {
    void runWithBadge(raw.captureId, raw.tabId).catch((cause) => {
      console.warn("[tunta] pipeline 执行异常:", cause);
      setBadge("!", "#d83a3a");
      setTimeout(() => setBadge(""), 4000);
    });
  }
});
