const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHECKPOINTS,
  labelDecisionAtCheckpoint
} = require("../outcome-labeling");
const {
  splitWalkForward,
  evaluateOutcomes
} = require("../evaluation");

const SIGNAL = "2026-09-01T00:00:00.000Z";
const signalMs = Date.parse(SIGNAL);
const at = minutes => new Date(signalMs + minutes * 60_000).toISOString();

function decision(overrides = {}) {
  return {
    id: "decision-phase6",
    mint: "phase6-mint",
    pairAddress: "phase6-pair",
    observedAt: SIGNAL,
    decisionVersion: "phase4-v1",
    scorecard: { phase4a: { thesis: { state: "VALIDATING" } } },
    ...overrides
  };
}

function observation(minutes, priceUsd, rawPayload = {}) {
  return {
    id: `observation-${minutes}`,
    mint: "phase6-mint",
    pairAddress: "phase6-pair",
    observedAt: at(minutes),
    priceUsd,
    liquidityUsd: 25_000,
    rawPayload
  };
}

test("Phase 6 uses only observations at or after signal time and computes MFE, MAE, and drawdown", () => {
  const label = labelDecisionAtCheckpoint(
    decision(),
    [
      observation(-1, 999),
      observation(0, 100),
      observation(10, 120),
      observation(30, 90),
      observation(60, 110, {
        executionSafety: {
          checks: [{ side: "sell", status: "PASS", slippageBps: 45 }]
        }
      })
    ],
    CHECKPOINTS.find(item => item.key === "T+1H"),
    at(61)
  );
  assert.equal(label.completionState, "FOUND");
  assert.equal(label.entryPrice, 100);
  assert.equal(label.exitPrice, 110);
  assert.equal(label.forwardReturnPercent, 10);
  assert.equal(label.mfePercent, 20);
  assert.equal(label.maePercent, -10);
  assert.equal(label.drawdownPercent, -25);
  assert.equal(label.tradabilityState, "TRADABLE");
  assert.equal(label.slippageBps, 45);
  assert.equal(label.executableReturnPercent, 9.25);
  assert.equal(label.thesisOutcome, "INVALIDATED");
});

test("Phase 6 keeps future checkpoints not due and missing coverage censored", () => {
  const notDue = labelDecisionAtCheckpoint(
    decision(),
    [observation(0, 100)],
    CHECKPOINTS.find(item => item.key === "T+1H"),
    at(30)
  );
  assert.equal(notDue.completionState, "NOT_DUE");

  const censored = labelDecisionAtCheckpoint(
    decision(),
    [observation(0, 100)],
    CHECKPOINTS.find(item => item.key === "T+1M"),
    at(32),
    { maxObservationLagMs: 30 * 60 * 1000, priceEntryDefinition: "ENTRY", priceExitDefinition: "EXIT" }
  );
  assert.equal(censored.completionState, "CENSORED");
  assert.equal(censored.censoringReason, "NO_OBSERVATION_WITHIN_WINDOW");
  assert.equal(censored.forwardReturnPercent, null);
  assert.equal(censored.tradabilityState, "UNKNOWN");
});

test("Phase 6 does not claim execution when sell evidence or catalyst evidence is absent", () => {
  const label = labelDecisionAtCheckpoint(
    decision({ scorecard: { phase4a: { thesis: { state: "THESIS_CONFLICT" } } } }),
    [observation(0, 100), observation(60, 95)],
    CHECKPOINTS.find(item => item.key === "T+1H"),
    at(61)
  );
  assert.equal(label.tradabilityState, "UNKNOWN");
  assert.equal(label.executableReturnPercent, null);
  assert.equal(label.thesisOutcome, "INVALIDATED");
  assert.equal(label.catalystOutcome, "UNKNOWN");
});

test("Phase 6A keeps embargoed walk-forward boundaries separate", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    checkpoint: "T+1H",
    signalTime: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    completionState: "FOUND",
    score: index,
    forwardReturnPercent: index > 6 ? 10 : -10,
    mint: `mint-${index}`
  }));
  const split = splitWalkForward(rows, 24 * 60 * 60 * 1000);
  assert.ok(split.training.length > 0);
  assert.ok(split.validation.length > 0);
  assert.ok(split.temporalHoldout.length > 0);
  const validationStart = Date.parse(split.validation[0].signalTime);
  const trainingEnd = Date.parse(split.training.at(-1).signalTime);
  assert.ok(validationStart - trainingEnd >= 24 * 60 * 60 * 1000);
});

test("Phase 6A gates claims, bootstraps token blocks, and keeps calibration inapplicable", () => {
  const rows = Array.from({ length: 32 }, (_, index) => ({
    checkpoint: "T+1H",
    signalTime: new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 4))).toISOString(),
    completionState: "FOUND",
    score: index,
    forwardReturnPercent: index % 2 ? 8 : -3,
    maePercent: -2,
    mint: `mint-${index % 8}`,
    discoveryClass: index % 2 ? "BOOSTED" : "NON_BOOSTED"
  }));
  const report = evaluateOutcomes(rows, {
    minimumSample: 30,
    minimumWindowDays: 8,
    bootstrapReplicates: 30
  });
  assert.equal(report.claimStatus, "INSUFFICIENT_SAMPLE_OR_TIME_WINDOW");
  assert.equal(report.efficacyClaimAllowed, false);
  assert.equal(report.calibration.status, "NOT_APPLICABLE_SCORE_IS_NOT_PROBABILITY");
  assert.equal(report.uncertainty.precisionAt10.unit, "TOKEN_BLOCK");
  assert.equal(report.discoveryBias.BOOSTED.discoveryClass, "BOOSTED");
  assert.equal(report.discoveryBias.NON_BOOSTED.discoveryClass, "NON_BOOSTED");
});