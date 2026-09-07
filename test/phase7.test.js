const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONFIGURATION_HASH,
  PHASE7_VERSION,
  buildPhase7Report,
  evaluateChampionPromotion,
  rollbackRollout,
  summarizeMonitoring
} = require("../phase7");

const run = (offset, overrides = {}) => ({
  startedAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + offset).toISOString(),
  finishedAt: new Date(Date.parse("2026-09-01T00:00:00.000Z") + offset + 1_000).toISOString(),
  status: "SUCCESS",
  durationMs: 1_000,
  providerFreshnessMs: 10_000,
  rpcFreshnessMs: 10_000,
  manual: false,
  ...overrides
});

test("Phase 7 measures operational SLOs from persisted scan runs", () => {
  const report = summarizeMonitoring([
    run(0),
    run(15_000),
    run(30_000, { durationMs: 25_000, status: "PARTIAL" })
  ], { now: Date.parse("2026-09-01T00:01:00.000Z") });
  assert.equal(report.version, PHASE7_VERSION);
  assert.equal(report.metrics.totalScanRuns, 3);
  assert.equal(report.metrics.scheduledStartAdherence, 1);
  assert.equal(report.metrics.scanP95LatencyMs, 22_600);
  assert.equal(report.metrics.partialScanRate, 0.333333);
  assert.equal(report.readiness, "DEGRADED");
  assert.equal(report.incidentClass, "APPLICATION");
});

test("Phase 7 stays fail-closed when no operational evidence exists", () => {
  const report = buildPhase7Report({
    evaluation: { minimumRequirements: { met: false } },
    now: Date.parse("2026-09-01T00:00:00.000Z")
  });
  assert.equal(report.configurationHash, CONFIGURATION_HASH);
  assert.equal(report.monitoring.readiness, "NOT_READY");
  assert.equal(report.acceptanceGate.status, "BLOCKED");
  assert.equal(report.safety.walletExecutionEnabled, false);
  assert.ok(report.acceptanceGate.failedChecks.includes("outcomesMeasured"));
});

test("Phase 7 promotion requires measured challenger evidence and SLOs", () => {
  const monitoring = summarizeMonitoring([run(0), run(15_000)], {
    now: Date.parse("2026-09-01T00:01:00.000Z")
  });
  const blocked = evaluateChampionPromotion({
    baseline: { completeness: 0.9, precisionAt10: 0.4, maePercent: -8 },
    candidate: { completeness: 0.95, precisionAt10: 0.45, maePercent: -11, sampleSize: 40, securityRejectionBehaviorPreserved: true, reasonsExplainable: true },
    monitoring
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.ok(blocked.failedChecks.includes("maximumAdverseExcursion"));
  const eligible = evaluateChampionPromotion({
    baseline: { completeness: 0.9, precisionAt10: 0.4, maePercent: -8 },
    candidate: { completeness: 0.95, precisionAt10: 0.45, maePercent: -8.5, sampleSize: 40, securityRejectionBehaviorPreserved: true, reasonsExplainable: true },
    monitoring
  });
  assert.equal(eligible.status, "ELIGIBLE");
});

test("Phase 7 rollback is explicit, baseline-safe, and preserves evidence policy", () => {
  const result = rollbackRollout({
    mode: "ACTIVE_RESEARCH",
    championVersion: "challenger-v2",
    challengerVersion: "challenger-v3",
    promotionEvidence: { secret: "not persisted" }
  }, "provider_error", Date.parse("2026-09-01T00:00:00.000Z"));
  assert.equal(result.mode, "BASELINE");
  assert.equal(result.challengerVersion, null);
  assert.equal(result.rollbackReason, "provider_error");
  assert.equal(result.rollbackAt, "2026-09-01T00:00:00.000Z");
});