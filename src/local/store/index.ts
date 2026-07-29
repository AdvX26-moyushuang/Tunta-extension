import { IdbStore } from "./idb-store";
import { isMigrated } from "./migrate";
import { SqliteStore } from "./sqlite-store";
import type { TuntaStore } from "./types";

export * from "./types";

let instance: TuntaStore | null = null;
let resolved: Promise<TuntaStore> | null = null;

/** 迁移标记只读一次；标记存在走 SQLite，否则维持 IndexedDB（迁移完成前的默认）。 */
function resolveStore(): Promise<TuntaStore> {
  if (!resolved) {
    resolved = isMigrated()
      .then((migrated) => (migrated ? new SqliteStore() : new IdbStore()))
      .catch(() => new IdbStore());
  }
  return resolved;
}

/** 懒解析代理：保持同步签名，业务层调用点不感知迁移切换。 */
function lazyStore(): TuntaStore {
  return new Proxy({} as TuntaStore, {
    get(_target, prop: string) {
      return (...args: unknown[]) =>
        resolveStore().then((store) => {
          const method = store[prop as keyof TuntaStore] as (...a: unknown[]) => unknown;
          return method.apply(store, args);
        });
    },
  });
}

/** 默认按迁移状态在 IdbStore / SqliteStore 间切换（Phase 1）。 */
export function getStore(): TuntaStore {
  if (!instance) {
    instance = lazyStore();
  }
  return instance;
}

/** 测试与 Phase 1 灰度用。 */
export function setStore(s: TuntaStore): void {
  instance = s;
  resolved = Promise.resolve(s);
}

/** 迁移完成后由 migrate 调用，让后续调用直接走新实现。 */
export function resetStoreResolution(): void {
  instance = null;
  resolved = null;
}
