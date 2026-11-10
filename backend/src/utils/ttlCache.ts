import { LRUCache } from "lru-cache";

/**
 * Small TTL + LRU front for expensive or hot reference reads (catalog lists,
 * dashboard aggregates). Values are fresh for `ttlMs`; concurrent `load()`
 * calls for the same key share ONE in-flight fetch instead of stampeding the
 * database. Writers call `invalidate`/`clear` so the admin UI never reads its
 * own writes as stale.
 */
export interface TtlCache<V> {
  /** Return the cached value for `key`, or run `fetcher` once and cache it. */
  load(key: string, fetcher: () => Promise<V>): Promise<V>;
  /** Drop one entry (after a write that changes it). */
  invalidate(key: string): void;
  /** Drop every entry (after a write whose effect spans keys). */
  clear(): void;
}

export function createTtlCache<V extends {}>(ttlMs: number, max = 64): TtlCache<V> {
  const cache = new LRUCache<string, V>({ ttl: ttlMs, max });
  const inflight = new Map<string, Promise<V>>();

  return {
    load(key, fetcher) {
      const hit = cache.get(key);
      if (hit !== undefined) return Promise.resolve(hit);

      const running = inflight.get(key);
      if (running) return running;

      const p = fetcher()
        .then((value) => {
          cache.set(key, value);
          return value;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, p);
      return p;
    },
    invalidate(key) {
      cache.delete(key);
      inflight.delete(key);
    },
    clear() {
      cache.clear();
      inflight.clear();
    },
  };
}
