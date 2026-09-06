const test = require("node:test");
const assert = require("node:assert/strict");
const { FEATURE_VERSION, deriveFeatureSnapshot } = require("../radar-features");

const start = Date.parse("2026-09-06T00:00:00.000Z");

function observation(offsetMinutes, overrides = {}) {
  const price = 1 + (offsetMinutes / 100);
  return {
    mint: "feature-mint",
    pairAddress: "pair-1",
    observedAt: new Date(start + offsetMinutes * 60_000).toISOString(),
    providerUpdatedAt: new Date(start + offsetMinutes * 60_000 - 30_000).toISOString(),
    priceUsd: price,
    liquidityUsd: 10_000 + offsetMinutes * 10,
    volume: { m5: 100, h24: 1_000 },
    transactions: { h24: { buys: 60, sells: 40 } },
    makers: { h24: 100 + offsetMinutes },
    concentration: { top_1_account_percent: 12 },
    rawPayload: {
      security: {
        rpcEvidence: { observedAt: new Date(start + offsetMinutes * 60_000 - 15_000).toISOString() }
      }
    },
    ...overrides
  };
}

test("feature snapshot is deterministic and compares only persisted history", () => {
  const history = [];
  for (let minute = 0; minute <= 60; minute += 5) history.push(observation(minute));
  history[history.length - 1].volume.m5 = 200;
  const future = observation(65, { priceUsd: 99, liquidityUsd: 99_999 });

  const result = deriveFeatureSnapshot([...history, future], {
    asOf: new Date(start + 60 * 60_000).toISOString()
  });
  const repeat = deriveFeatureSnapshot(history, {
    asOf: new Date(start + 60 * 60_000).toISOString()
  });

  assert.equal(result.featureVersion, FEATURE_VERSION);
  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(result, repeat);
  assert.equal(result.features.volumeAcceleration, 2);
  assert.equal(result.features.buySellImbalance, 0.2);
  assert.equal(result.features.concentrationPenalty, 12);
  assert.equal(result.freshness.historySamples, 13);
  assert.equal(result.freshness.marketDataAgeMs, 30_000);
  assert.equal(result.freshness.securityDataAgeMs, 15_000);
});

test("insufficient history stays explicit instead of becoming zero", () => {
  const result = deriveFeatureSnapshot([observation(0)], {
    asOf: new Date(start).toISOString()
  });

  assert.equal(result.status, "PARTIAL");
  assert.equal(result.completeness, 38);
  assert.equal(result.features.priceAcceleration, null);
  assert.equal(result.features.volatility, null);
  assert.ok(result.qualityReasons.includes("PRICE_ACCELERATION_HISTORY_INSUFFICIENT"));
  assert.ok(result.qualityReasons.includes("MANIPULATION_UNKNOWN_SAMPLE"));
});

test("missing flow counts and provider freshness remain unknown", () => {
  const result = deriveFeatureSnapshot([
    observation(0, {
      transactions: null,
      providerUpdatedAt: null,
      rawPayload: {}
    }),
    observation(60, {
      transactions: null,
      providerUpdatedAt: null,
      rawPayload: {}
    })
  ]);

  assert.equal(result.features.buySellImbalance, null);
  assert.equal(result.freshness.marketDataAgeMs, null);
  assert.equal(result.freshness.securityDataAgeMs, null);
  assert.ok(result.qualityReasons.includes("FLOW_TRANSACTION_COUNTS_UNKNOWN"));
  assert.ok(result.qualityReasons.includes("CONCENTRATION_UNKNOWN") === false);
});