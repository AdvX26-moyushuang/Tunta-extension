/**
 * 扩展内部消息（popup / workspace / background 之间）。
 *
 * - capture-submitted：状态镜像（badge 提示）
 * - run-pipeline：local（插件独立）模式下触发 background SW 执行收藏流水线
 *   （快照 -> 卡片 -> embedding）；background 必须确认已接单，状态经本地库轮询可见
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

interface TuntaMessageAck {
  accepted: true;
}

export async function sendMessage(message: TuntaMessage): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    throw new Error(`扩展 runtime 不可用，消息未发送：${message.type}`);
  }
  const response = (await chrome.runtime.sendMessage(message)) as TuntaMessageAck | undefined;
  if (response?.accepted !== true) {
    throw new Error(`background 未确认消息：${message.type}`);
  }
}
