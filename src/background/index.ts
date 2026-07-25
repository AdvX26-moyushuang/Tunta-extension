import { resumeStuckPipelines, runPipeline } from "@/local/pipeline";
import type { TuntaMessage } from "@/shared/messages";

const RESUME_ALARM = "tunta:resume-pipelines";

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
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 1 });
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
