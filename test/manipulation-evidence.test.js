const test = require("node:test");
const assert = require("node:assert/strict");
const { MANIPULATION_VERSION, deriveManipulationEvidence } = require("../manipulation-evidence");

function observation(at, liquidityUsd, trades) {
  return {
    observedAt: new Date(at).toISOString(),
    liquidityUsd,
    rawPayload: { tradeObservations: trades || [] }
  };
}

function trade(at, entityId, side, extra = {}) {
  return { observedAt: new Date(at).toISOString(), entityId, side, amountUsd: 100, ...extra };
}

test("Phase 3A is fail-closed when trade coverage is absent", () => {
  const result = deriveManipulationEvidence([observation(Date.parse("2026-09-06T00:00:00Z"), 10000)]);
  assert.equal(result.version, MANIPULATION_VERSION);
  assert.equal(result.sampleStatus, "UNKNOWN");
  assert.equal(result.flags.washTrading, null);
  assert.equal(result.flags.burstActivity, null);
  assert.equal(result.smartMoneyStatus, "UNKNOWN");
  assert.ok(result.qualityReasons.some(reason => reason.code === "TRADE_LEVEL_COVERAGE_UNAVAILABLE"));
});

test("Phase 3A detects round trips, bursts, coordination, and keeps smart-money unverified", () => {
  const start = Date.parse("2026-09-06T00:00:00Z");
  const trades = [];
  for (let index = 0; index < 12; index += 1) {
    trades.push(trade(start + index * 5_000, index % 3 === 0 ? "a" : `wallet-${index % 3}`, index % 2 ? "SELL" : "BUY", {
      slot: index < 6 ? "slot-1" : `slot-${index}`,
      clusterId: index % 3 === 0 ? "cluster-a" : null,
      funder: index % 3 === 0 ? "funder-a" : null
    }));
  }
  const result = deriveManipulationEvidence([
    observation(start, 10000, trades),
    observation(start + 60 * 60_000, 6500, trades)
  ]);
  assert.equal(result.sampleStatus, "SUFFICIENT");
  assert.equal(result.flags.washTrading, true);
  assert.equal(result.flags.circularActivity, true);
  assert.equal(result.flags.burstActivity, true);
  assert.equal(result.flags.coordinatedActivity, true);
  assert.equal(result.flags.poolDrain, true);
  assert.equal(result.poolDrainStatus, "FLAGGED");
  assert.equal(result.smartMoneyStatus, "UNVERIFIED");
  assert.equal(result.metrics.liquidityChangePercent, -35);
});

test("future trades are excluded from an as-of evidence snapshot", () => {
  const start = Date.parse("2026-09-06T00:00:00Z");
  const result = deriveManipulationEvidence([
    observation(start, 10000, [trade(start, "wallet-1", "BUY")]),
    observation(start + 60_000, 10000, Array.from({ length: 20 }, (_, index) => trade(start + 60_000 + index, "wallet-2", "BUY")))
  ], { asOf: new Date(start).toISOString() });
  assert.equal(result.sampleSize, 1);
  assert.equal(result.flags.washTrading, null);
});