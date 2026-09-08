const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderCache } = require("../cache/provider-cache");
const { CACHE_STATUSES } = require("../cache/cache-policy");
const { buildCacheKey } = require("../cache/cache-key");
const { prisma, readProviderCacheEntry, writeProviderCacheEntry } = require("../db");

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

test("recreated cache reads persistent lineage without calling the provider", async () => {
  const persisted = new Map();
  const store = {
    async get(cacheKey) {
      const entry = persisted.get(cacheKey);
      return entry ? JSON.parse(JSON.stringify(entry)) : null;
    },
    async set(entry) {
      persisted.set(entry.cacheKey, JSON.parse(JSON.stringify(entry)));
      return entry;
    }
  };
  const input = key("https://demo.test/persistent");
  const first = createProviderCache({ store });
  await first.set(input, { value: "persisted" }, {
    sourceObservedAt: 20_000,
    sourceRequestId: "request-20",
    responseHash: "response-20",
    slot: "200"
  });

  const recreated = createProviderCache({ store });
  let calls = 0;
  const result = await recreated.getOrFetch(input, {
    fetch: async () => {
      calls += 1;
      return { value: "unexpected" };
    }
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.value, { value: "persisted" });
  assert.equal(result.entry.sourceRequestId, "request-20");
  assert.equal(result.entry.responseHash, "response-20");
  assert.equal(result.entry.slot, "200");
});

test("persistent store latest-write-wins survives out-of-order cache writers", async () => {
  const persisted = new Map();
  const store = {
    async get(cacheKey) {
      const entry = persisted.get(cacheKey);
      return entry ? JSON.parse(JSON.stringify(entry)) : null;
    },
    async set(entry) {
      await new Promise(resolve => setTimeout(resolve, entry.sourceObservedAt === 10_000 ? 10 : 0));
      const existing = persisted.get(entry.cacheKey);
      if (!existing || Number(entry.sourceObservedAt) >= Number(existing.sourceObservedAt)) {
        persisted.set(entry.cacheKey, JSON.parse(JSON.stringify(entry)));
      }
      return persisted.get(entry.cacheKey);
    }
  };
  const input = key("https://demo.test/race");
  const older = createProviderCache({ store });
  const newer = createProviderCache({ store });
  await Promise.all([
    older.set(input, { version: "older" }, { sourceObservedAt: 10_000 }),
    newer.set(input, { version: "newer" }, { sourceObservedAt: 20_000 })
  ]);
  const recreated = createProviderCache({ store });
  assert.deepEqual((await recreated.get(input)).payload, { version: "newer" });
});

test("Prisma-backed cache survives recreation and rejects an older database writer", {
  skip: !process.env.DATABASE_URL
}, async () => {
  const now = Date.now();
  const cacheKey = `${key("https://demo.test/prisma-integration").cacheKey}:integration`;
  const entry = {
    cacheKey,
    providerId: "integration-test",
    capability: "PAIR_MARKET",
    chain: "solana",
    payload: { value: "newer" },
    payloadHash: "newer-hash",
    sourceObservedAt: now,
    cachedAt: now,
    expiresAt: now + 60_000,
    staleUntil: now + 120_000,
    status: CACHE_STATUSES.FRESH,
    sourceRequestId: "integration-request-newer",
    responseHash: "integration-response-newer",
    slot: "200",
    configHash: "integration-test"
  };
  try {
    await writeProviderCacheEntry(entry);
    await writeProviderCacheEntry({
      ...entry,
      payload: { value: "older" },
      payloadHash: "older-hash",
      sourceObservedAt: now - 1_000,
      sourceRequestId: "integration-request-older"
    });
    const recreated = createProviderCache({
      now: () => now,
      store: { get: readProviderCacheEntry, set: writeProviderCacheEntry }
    });
    const result = await recreated.get(cacheKey);
    assert.deepEqual(result.payload, { value: "newer" });
    assert.equal(result.sourceRequestId, "integration-request-newer");
    assert.equal(result.responseHash, "integration-response-newer");
    assert.equal(result.slot, "200");
  } finally {
    await prisma.providerCacheEntry.deleteMany({ where: { cacheKey } });
  }
});

test("cache keys include provider, capability, chain, endpoint and normalized parameters", () => {
  const base = buildCacheKey({ providerId: "demo", capability: "PAIR_MARKET", chain: "solana", endpoint: "https://demo.test/a", params: { x: 1 } });
  assert.notEqual(base, buildCacheKey({ providerId: "other", capability: "PAIR_MARKET", chain: "solana", endpoint: "https://demo.test/a", params: { x: 1 } }));
  assert.notEqual(base, buildCacheKey({ providerId: "demo", capability: "DISCOVERY", chain: "solana", endpoint: "https://demo.test/a", params: { x: 1 } }));
  assert.notEqual(base, buildCacheKey({ providerId: "demo", capability: "PAIR_MARKET", chain: "ethereum", endpoint: "https://demo.test/a", params: { x: 1 } }));
  assert.notEqual(base, buildCacheKey({ providerId: "demo", capability: "PAIR_MARKET", chain: "solana", endpoint: "https://demo.test/b", params: { x: 1 } }));
});