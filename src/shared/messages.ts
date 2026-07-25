/**
 * 扩展内部消息（popup / workspace / background 之间）。
 *
 * - capture-submitted：状态镜像（badge 提示）
 * - run-pipeline：local（插件独立）模式下触发 background SW 执行收藏流水线
 *   （快照 -> 卡片 -> embedding）；fire-and-forget，状态经 IndexedDB 轮询可见
 */

export interface CaptureSubmittedMessage {
  type: "tunta:capture-submitted";
  captureId: string;
}

export interface RunPipelineMessage {
  type: "tunta:run-pipeline";
  captureId: string;
  /** popup 收藏当前页面时传入，快照直接在该标签页执行 */
  tabId?: number;
}

export type TuntaMessage = CaptureSubmittedMessage | RunPipelineMessage;

export function sendMessage(message: TuntaMessage): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
  // fire-and-forget：消息只是提示，不作为数据通道
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}
