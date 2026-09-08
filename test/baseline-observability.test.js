const test = require("node:test");
const assert = require("node:assert/strict");
const { createBaselineObservability } = require("../baseline-observability");
const { buildBaselineFixtures } = require("../fixtures/provider-resilient-baseline");

test("M0 baseline observability keeps bounded provider, scan, freshness, cache, and queue metrics", () => {
  let clock = Date.parse("2026-09-08T00:00:00.000Z");
  const metrics = createBaselineObservability({ now: () => clock });
  metrics.recordProviderRequest({ providerId: "dexscreener", capability: "DISCOVERY", status: "SUCCESS", attempt: 1, latencyMs: 120 });
  metrics.recordProviderRequest({ providerId: "dexscreener", capability: "DISCOVERY", status: "RATE_LIMITED", attempt: 2, latencyMs: 240 });
  metrics.recordScanStarted();
  clock += 500;
  metrics.recordScanOutcome({ status: "SUCCESS", durationMs: 500, providerFreshnessMs: 2_000, rpcFreshnessMs: 300 });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.version, "m0-observability-v1");
  assert.equal(snapshot.provider.requests, 2);
  assert.equal(snapshot.provider.retries, 1);
  assert.deepEqual(snapshot.provider.byStatus, { SUCCESS: 1, RATE_LIMITED: 1 });
  assert.equal(snapshot.scan.started, 1);
  assert.deepEqual(snapshot.scan.byStatus, { SUCCESS: 1 });
  assert.equal(snapshot.freshness.lastKnownGoodAgeMs, 0);
  assert.equal(snapshot.cache.status, "ACTIVE");
  assert.equal(snapshot.cache.enabled, true);
  assert.equal(snapshot.queue.status, "NOT_IMPLEMENTED");
});

test("M0 baseline fixture is deterministic, bounded, and network-free", () => {
  const fixtures = buildBaselineFixtures();
  assert.deepEqual(fixtures.sizes.map(fixture => fixture.tokens.length), [10, 100, 1000]);
  assert.equal(fixtures.sizes[1].watchlist.length, 100);
  assert.equal(fixtures.failureModes.rateLimited.status, 429);
  assert.equal(fixtures.failureModes.timeout.errorCode, "TIMEOUT");
  assert.deepEqual(fixtures.failureModes.malformed.body, { unexpected: true });
  assert.equal(fixtures.sizes[0].network, "none");
  assert.ok(fixtures.sizes.every(fixture => fixture.tokens.every(token => token.source === "m0-fixture")));
});