import { IdbStore } from "./idb-store";
import type { TuntaStore } from "./types";

export * from "./types";

let instance: TuntaStore | null = null;

/** 默认返回 IdbStore。Phase 1 迁移完成后由 migrate 切换为 SqliteStore。 */
export function getStore(): TuntaStore {
  if (!instance) {
    instance = new IdbStore();
  }
  return instance;
}

/** 测试与 Phase 1 灰度用。 */
export function setStore(s: TuntaStore): void {
  instance = s;
}
