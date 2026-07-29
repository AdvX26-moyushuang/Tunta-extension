import { articleAdapter } from "./adapters/article";
import { bilibiliAdapter } from "./adapters/bilibili";
import { xiaohongshuAdapter } from "./adapters/xiaohongshu";
import type { SnapshotData, SourceAdapter } from "./adapters/types";

export { SnapshotError, type SnapshotData } from "./adapters/types";

/** 平台适配注册表：按序匹配，article 永远排最后作为兜底。 */
const adapters: SourceAdapter[] = [bilibiliAdapter, xiaohongshuAdapter, articleAdapter];

export async function executeSnapshotOnTab(tabId: number, originalUrl: string): Promise<SnapshotData> {
  const adapter = adapters.find((candidate) => candidate.match(originalUrl)) ?? articleAdapter;
  return adapter.extract({ tabId, originalUrl });
}
