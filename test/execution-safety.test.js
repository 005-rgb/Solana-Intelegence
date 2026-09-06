const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EXECUTION_SAFETY_VERSION,
  evaluateExecutionSafety,
  extractSellExecutionEvidence,
  summarizeExecutionSafety
} = require("../execution-safety");

const now = Date.parse("2026-09-06T00:00:00.000Z");

function quote(overrides = {}) {
  return {
    status: "PASS",
    routeAvailable: true,
    minimumReceived: 100,
    priceImpactPercent: 0.8,
    estimatedSlippageBps: 50,
    transferFee: 0,
    transferHook: "PASS",
    accountCreationRequired: false,
    simulationStatus: "PASS",
    quoteAt: new Date(now - 1_000).toISOString(),
    ...overrides
  };
}

function evidence(overrides = {}) {
  const sizes = ["100", "500", "1000"];
  return {
    version: EXECUTION_SAFETY_VERSION,
    buy: Object.fromEntries(sizes.map(size => [size, quote()])),
    sell: Object.fromEntries(sizes.map(size => [size, quote()])),
    ...overrides
  };
}

test("execution safety qualifies only complete fresh buy and sell evidence", () => {
  const result = evaluateExecutionSafety(evidence(), { now });
  assert.equal(result.status, "ACTIONABLE_RESEARCH");
  assert.equal(result.actionable, true);
  assert.equal(result.reasons.length, 0);
});

test("missing sell evidence remains unknown and never passes", () => {
  const result = evaluateExecutionSafety(evidence({ sell: {} }), { now });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.actionable, false);
  assert.ok(result.reasons.includes("SELL_QUOTE_UNKNOWN"));
  assert.ok(result.reasons.includes("SELL_SIMULATION_UNKNOWN"));
});

test("failed sell simulation is a hard rejection", () => {
  const sell = Object.fromEntries(["100", "500", "1000"].map(size => [size, quote({ simulationStatus: "FAILED" })]));
  const result = evaluateExecutionSafety(evidence({ sell }), { now });
  assert.equal(result.status, "REJECTED");
  assert.ok(result.reasons.includes("SELL_SIMULATION_FAILED"));
});

test("stale quotes and unresolved transfer behavior cannot become actionable", () => {
  const stale = Object.fromEntries(["100", "500", "1000"].map(size => [size, quote({
    quoteAt: new Date(now - 60_000).toISOString(),
    transferFee: null,
    transferHook: null,
    accountCreationRequired: null
  })]));
  const result = evaluateExecutionSafety(evidence({ buy: stale, sell: stale }), { now });
  assert.equal(result.status, "UNKNOWN");
  assert.ok(result.reasons.includes("QUOTE_STALE"));
  assert.ok(result.reasons.includes("TRANSFER_FEE_UNKNOWN"));
  assert.ok(result.reasons.includes("ACCOUNT_CREATION_UNKNOWN"));
});

test("execution safety summary reconciles classifications and multi-label reasons", () => {
  const summary = summarizeExecutionSafety([
    { details: { executionEvidence: evidence() } },
    { details: { executionEvidence: evidence({ sell: {} }) } }
  ], { now });
  assert.equal(summary.recordsChecked, 2);
  assert.equal(summary.actionableResearch, 1);
  assert.equal(summary.unknown, 1);
  assert.ok(summary.reasons.some(reason => reason.code === "SELL_QUOTE_UNKNOWN"));
});

test("sell-route extraction preserves explicit slippage, fees, and invalidation evidence", () => {
  const result = extractSellExecutionEvidence({
    source: "JUPITER_QUOTE",
    evidence: {
      sell: {
        "100": {
          status: "PASS",
          routeAvailable: true,
          estimatedSlippageBps: 42,
          feeBps: 31,
          feeAmount: 1200,
          feeMint: "USDC",
          quoteAt: new Date(now - 1_000).toISOString(),
          invalidationCodes: []
        }
      }
    }
  });
  assert.equal(result.state, "TRADABLE");
  assert.equal(result.slippageBps, 42);
  assert.equal(result.feeBps, 31);
  assert.equal(result.feeAmount, 1200);
  assert.equal(result.feeMint, "USDC");
  assert.deepEqual(result.invalidationCodes, []);

  const failed = extractSellExecutionEvidence({
    evidence: { sell: { "100": { status: "FAILED", routeAvailable: false } } }
  });
  assert.equal(failed.state, "UNTRADABLE");
  assert.ok(failed.invalidationCodes.includes("SELL_ROUTE_UNAVAILABLE"));
});