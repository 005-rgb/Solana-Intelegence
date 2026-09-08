const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderCache } = require("../cache/provider-cache");
const { CACHE_STATUSES } = require("../cache/cache-policy");
const { buildCacheKey } = require("../cache/cache-key");

function key(endpoint = "https://demo.test/pair?a=1") {
  return {
    cacheKey: buildCacheKey({ providerId: "demo", capability: "PAIR_MARKET", chain: "solana", endpoint }),
    providerId: "demo",
    capability: "PAIR_MARKET"
  };
}

test("provider cache returns fresh entries without another provider request", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = createProviderCache({ now: () => now });
  const input = key();
  const first = await cache.getOrFetch(input, { fetch: async () => { calls += 1; return { value: 1 }; } });
  const second = await cache.getOrFetch(input, { fetch: async () => { calls += 1; return { value: 2 }; } });
  assert.equal(calls, 1);
  assert.deepEqual(second.value, { value: 1 });
  assert.equal(first.cacheStatus, CACHE_STATUSES.FRESH);
  assert.equal(cache.stats().hits, 1);
});

test("concurrent identical requests share one promise and caller abort does not cancel the owner", async () => {
  let release;
  let calls = 0;
  const cache = createProviderCache();
  const input = key();
  const pending = new Promise(resolve => { release = resolve; });
  const owner = cache.getOrFetch(input, { fetch: async () => { calls += 1; await pending; return { ok: true }; } });
  const controller = new AbortController();
  const follower = cache.getOrFetch(input, { signal: controller.signal, fetch: async () => { calls += 1; return { ok: false }; } });
  controller.abort();
  release();
  await assert.rejects(follower, error => error.code === "REQUEST_ABORTED");
  assert.deepEqual((await owner).value, { ok: true });
  assert.equal(calls, 1);
  assert.equal(cache.stats().coalesced, 1);
});

test("stale entries are returned when refresh fails and failure is short-lived", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = createProviderCache({ now: () => now, failedTtlMs: 10_000 });
  const input = key();
  await cache.set(input, { value: "last-known-good" }, { sourceObservedAt: now });
  now += 16_000;
  const stale = await cache.getOrFetch(input, {
    fetch: async () => { calls += 1; throw Object.assign(new Error("429"), { code: "RATE_LIMITED" }); }
  });
  const blocked = await cache.getOrFetch(input, {
    fetch: async () => { calls += 1; return { value: "should-not-run" }; }
  });
  assert.equal(calls, 1);
  assert.equal(stale.cacheStatus, CACHE_STATUSES.STALE_BUT_USABLE);
  assert.equal(stale.staleFallback, true);
  assert.deepEqual(blocked.value, { value: "last-known-good" });
  assert.equal(blocked.cacheStatus, CACHE_STATUSES.FAILED);
});

test("older observations cannot overwrite newer cache entries", async () => {
  let now = 10_000;
  const cache = createProviderCache({ now: () => now });
  const input = key();
  await cache.set(input, { version: 2 }, { sourceObservedAt: 2_000 });
  await cache.set(input, { version: 1 }, { sourceObservedAt: 1_000 });
  assert.deepEqual((await cache.get(input)).payload, { version: 2 });
});

test("cache keys include provider, capability, chain, endpoint and normalized parameters", () => {
  const base = buildCacheKey({ providerId: "demo", capability: "PAIR_MARKET", chain: "solana", endpoint: "https://demo.test/a", params: { x: 1 } });
  assert.notEqual(base, buildCacheKey({ providerId: "other", capability: "PAIR_MARKET", chain: "solana", endpoint: "https://demo.test/a", params: { x: 1 } }));
  assert.notEqual(base, buildCacheKey({ providerId: "demo", capability: "DISCOVERY", chain: "solana", endpoint: "https://demo.test/a", params: { x: 1 } }));
  assert.notEqual(base, buildCacheKey({ providerId: "demo", capability: "PAIR_MARKET", chain: "ethereum", endpoint: "https://demo.test/a", params: { x: 1 } }));
  assert.notEqual(base, buildCacheKey({ providerId: "demo", capability: "PAIR_MARKET", chain: "solana", endpoint: "https://demo.test/b", params: { x: 1 } }));
});