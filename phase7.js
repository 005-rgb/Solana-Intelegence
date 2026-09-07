const crypto = require("crypto");

const PHASE7_VERSION = "phase7-v1";
const ROLLOUT_MODES = Object.freeze(["BASELINE", "SHADOW", "CANDIDATE", "ACTIVE_RESEARCH"]);
const PHASE7_CONFIG = Object.freeze({
  version: PHASE7_VERSION,
  schedulerIntervalMs: 15_000,
  scheduleGraceMs: 5_000,
  maxLastKnownGoodAgeMs: 15 * 60 * 1000,
  maxProviderFreshnessMs: 5 * 60 * 1000,
  maxRpcFreshnessMs: 5 * 60 * 1000,
  maxPartialRate: 0.2,
  maxTimeoutRate: 0.1,
  maxScanP95Ms: 20_000,
  minimumPromotionSample: 30,
  minimumPrecisionImprovement: 0.02,
  maximumMaeDeteriorationPercent: 2,
  minimumCompleteness: 0.8
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const CONFIGURATION_HASH = crypto.createHash("sha256").update(stable(PHASE7_CONFIG)).digest("hex");

function finite(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

function percentile(values, percentileValue) {
  const sorted = values.filter(value => finite(value) != null).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return Number(sorted[lower].toFixed(3));
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)).toFixed(3));
}

function slo(name, value, target, met, unit = null, reason = null) {
  return {
    name,
    value,
    target,
    unit,
    status: met == null ? "UNKNOWN" : met ? "PASS" : "FAIL",
    reason
  };
}

function normalizeRuns(scanRuns) {
  return (Array.isArray(scanRuns) ? scanRuns : [])
    .map(run => ({
      ...run,
      startedMs: timestamp(run.startedAt),
      finishedMs: timestamp(run.finishedAt),
      durationMs: finite(run.durationMs),
      status: String(run.status || "UNKNOWN").toUpperCase(),
      manual: Boolean(run.manual),
      timedOut: Boolean(run.timedOut),
      providerFreshnessMs: finite(run.providerFreshnessMs ?? run.providerAgeMs),
      rpcFreshnessMs: finite(run.rpcFreshnessMs)
    }))
    .filter(run => run.startedMs != null)
    .sort((a, b) => a.startedMs - b.startedMs);
}

function summarizeMonitoring(scanRuns, {
  now = Date.now(),
  databaseReady = true,
  schedulerRunning = true,
  alertMetrics = {}
} = {}) {
  const runs = normalizeRuns(scanRuns);
  const eligible = runs.filter(run => run.status !== "SKIPPED");
  const completed = eligible.filter(run => ["SUCCESS", "FILTERED", "PARTIAL", "FAILED"].includes(run.status));
  const successful = eligible.filter(run => run.status === "SUCCESS");
  const partial = eligible.filter(run => run.status === "PARTIAL" || run.status === "FILTERED");
  const timeouts = eligible.filter(run => run.timedOut || run.status === "TIMEOUT");
  const durations = eligible.map(run => run.durationMs).filter(value => value != null);
  const providerFreshness = eligible.map(run => run.providerFreshnessMs).filter(value => value != null);
  const rpcFreshness = eligible.map(run => run.rpcFreshnessMs).filter(value => value != null);
  const scheduled = runs.filter(run => !run.manual);
  const intervals = scheduled.slice(1).map((run, index) => run.startedMs - scheduled[index].startedMs);
  const onSchedule = intervals.filter(interval => interval <= PHASE7_CONFIG.schedulerIntervalMs + PHASE7_CONFIG.scheduleGraceMs).length;
  const latestSuccess = successful.at(-1);
  const latestRun = runs.at(-1);
  const lastKnownGoodAgeMs = latestSuccess?.finishedMs != null ? Math.max(0, now - latestSuccess.finishedMs) : null;
  const providerAgeMs = providerFreshness.at(-1) ?? null;
  const rpcAgeMs = rpcFreshness.at(-1) ?? null;

  const metrics = {
    scheduledStartAdherence: ratio(onSchedule, intervals.length),
    scanCompletionRate: ratio(successful.length, eligible.length),
    scanP50LatencyMs: percentile(durations, 0.5),
    scanP95LatencyMs: percentile(durations, 0.95),
    scanP99LatencyMs: percentile(durations, 0.99),
    providerFreshnessAgeMs: providerAgeMs,
    rpcFreshnessAgeMs: rpcAgeMs,
    // A persisted ScanRun proves the database accepted the audit record even
    // when the provider scan itself failed. A database failure produces no
    // reliable run row and must remain an explicit unknown/not-ready state.
    databasePersistenceSuccessRate: databaseReady ? (eligible.length ? 1 : null) : 0,
    lastKnownGoodAgeMs,
    partialScanRate: ratio(partial.length, eligible.length),
    timeoutRate: ratio(timeouts.length, eligible.length),
    alertCreationLatencyMs: finite(alertMetrics.creationLatencyMs),
    alertDedupeCorrectness: finite(alertMetrics.dedupeCorrectness),
    totalScanRuns: runs.length,
    eligibleScanRuns: eligible.length,
    successfulScanRuns: successful.length,
    latestRunStatus: latestRun?.status || "NOT_RUN"
  };

  const checks = {
    scheduledStartAdherence: metrics.scheduledStartAdherence == null ? null : metrics.scheduledStartAdherence >= 0.8,
    scanCompletionRate: metrics.scanCompletionRate == null ? null : metrics.scanCompletionRate >= 0.8,
    scanP95Latency: metrics.scanP95LatencyMs == null ? null : metrics.scanP95LatencyMs <= PHASE7_CONFIG.maxScanP95Ms,
    providerFreshness: metrics.providerFreshnessAgeMs == null ? null : metrics.providerFreshnessAgeMs <= PHASE7_CONFIG.maxProviderFreshnessMs,
    rpcFreshness: metrics.rpcFreshnessAgeMs == null ? null : metrics.rpcFreshnessAgeMs <= PHASE7_CONFIG.maxRpcFreshnessMs,
    databasePersistence: databaseReady && metrics.databasePersistenceSuccessRate != null && metrics.databasePersistenceSuccessRate >= 0.8,
    lastKnownGood: metrics.lastKnownGoodAgeMs == null ? null : metrics.lastKnownGoodAgeMs <= PHASE7_CONFIG.maxLastKnownGoodAgeMs,
    partialScanRate: metrics.partialScanRate == null ? null : metrics.partialScanRate <= PHASE7_CONFIG.maxPartialRate,
    timeoutRate: metrics.timeoutRate == null ? null : metrics.timeoutRate <= PHASE7_CONFIG.maxTimeoutRate
  };
  const sloResults = [
    slo("scheduled-start adherence", metrics.scheduledStartAdherence, 0.8, checks.scheduledStartAdherence, "ratio"),
    slo("scan completion rate", metrics.scanCompletionRate, 0.8, checks.scanCompletionRate, "ratio"),
    slo("scan p95 latency", metrics.scanP95LatencyMs, PHASE7_CONFIG.maxScanP95Ms, checks.scanP95Latency, "ms"),
    slo("provider freshness age", metrics.providerFreshnessAgeMs, PHASE7_CONFIG.maxProviderFreshnessMs, checks.providerFreshness, "ms"),
    slo("RPC freshness age", metrics.rpcFreshnessAgeMs, PHASE7_CONFIG.maxRpcFreshnessMs, checks.rpcFreshness, "ms"),
    slo("database persistence success", metrics.databasePersistenceSuccessRate, 0.8, checks.databasePersistence, "ratio"),
    slo("last-known-good age", metrics.lastKnownGoodAgeMs, PHASE7_CONFIG.maxLastKnownGoodAgeMs, checks.lastKnownGood, "ms"),
    slo("partial scan rate", metrics.partialScanRate, PHASE7_CONFIG.maxPartialRate, checks.partialScanRate, "ratio"),
    slo("timeout rate", metrics.timeoutRate, PHASE7_CONFIG.maxTimeoutRate, checks.timeoutRate, "ratio")
  ];
  const failures = sloResults.filter(item => item.status === "FAIL").map(item => item.name);
  const unknowns = sloResults.filter(item => item.status === "UNKNOWN").map(item => item.name);
  const readiness = !databaseReady ? "NOT_READY" : !runs.length ? "NOT_READY" : failures.length || unknowns.length ? "DEGRADED" : "READY";
  return {
    version: PHASE7_VERSION,
    generatedAt: new Date(now).toISOString(),
    metrics,
    slos: sloResults,
    checks,
    liveness: "UP",
    readiness,
    degraded: readiness !== "READY" || !schedulerRunning,
    failures,
    unknowns,
    incidentClass: classifyIncident({ readiness, metrics, failures, unknowns, schedulerRunning, databaseReady })
  };
}

function classifyIncident({ readiness, metrics, failures, unknowns, schedulerRunning, databaseReady }) {
  if (!databaseReady) return "DATABASE";
  if (!schedulerRunning || failures.includes("scan completion rate") || failures.includes("last-known-good age")) return "APPLICATION";
  if (failures.includes("provider freshness age")) return "PROVIDER";
  if (failures.includes("RPC freshness age")) return "RPC";
  if (failures.includes("partial scan rate") || failures.includes("timeout rate")) return "MARKET_DATA";
  if (readiness === "DEGRADED" || unknowns.length) return "DEGRADED_DATA";
  return "NONE";
}

function normalizeRollout(rollout = {}) {
  const mode = ROLLOUT_MODES.includes(String(rollout.mode || "").toUpperCase())
    ? String(rollout.mode).toUpperCase()
    : "BASELINE";
  return {
    mode,
    championVersion: rollout.championVersion || "phase2-v1",
    challengerVersion: rollout.challengerVersion || null,
    configurationHash: rollout.configurationHash || null,
    promotedAt: rollout.promotedAt || null,
    rollbackAt: rollout.rollbackAt || null,
    rollbackReason: rollout.rollbackReason || null,
    promotionEvidence: rollout.promotionEvidence || null
  };
}

function evaluateChampionPromotion({ baseline, candidate, monitoring } = {}) {
  const checks = {
    securityRejectionBehavior: candidate?.securityRejectionBehaviorPreserved === true,
    dataCompleteness: finite(candidate?.completeness) != null && finite(baseline?.completeness) != null
      ? candidate.completeness >= baseline.completeness
      : false,
    precisionAtTopK: finite(candidate?.precisionAt10) != null && finite(baseline?.precisionAt10) != null
      ? candidate.precisionAt10 >= baseline.precisionAt10 + PHASE7_CONFIG.minimumPrecisionImprovement
      : false,
    maximumAdverseExcursion: finite(candidate?.maePercent) != null && finite(baseline?.maePercent) != null
      ? candidate.maePercent >= baseline.maePercent - PHASE7_CONFIG.maximumMaeDeteriorationPercent
      : false,
    latencyBudget: monitoring?.checks?.scanP95Latency === true,
    providerErrorBudget: monitoring?.checks?.providerFreshness === true,
    explainability: candidate?.reasonsExplainable === true
  };
  const missing = [
    ["securityRejectionBehavior", candidate?.securityRejectionBehaviorPreserved],
    ["dataCompleteness", candidate?.completeness],
    ["precisionAtTopK", candidate?.precisionAt10],
    ["maximumAdverseExcursion", candidate?.maePercent],
    ["latencyBudget", monitoring?.metrics?.scanP95LatencyMs],
    ["providerErrorBudget", monitoring?.metrics?.providerFreshnessAgeMs],
    ["explainability", candidate?.reasonsExplainable]
  ].filter(([, value]) => value == null).map(([name]) => name);
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  const sampleSize = finite(candidate?.sampleSize);
  const sampleReady = sampleSize != null && sampleSize >= PHASE7_CONFIG.minimumPromotionSample;
  if (!sampleReady) failedChecks.push("minimumSample");
  return {
    status: missing.length || failedChecks.length ? "BLOCKED" : "ELIGIBLE",
    sampleSize,
    checks,
    failedChecks: [...new Set(failedChecks)],
    missingEvidence: missing,
    rule: "A challenger must beat baseline on fixed top-k outcomes without weakening security, completeness, adverse-excursion, latency, provider, or explanation safeguards."
  };
}

function buildAcceptanceGate({ evaluation, monitoring, promotion } = {}) {
  const checks = {
    outcomesMeasured: evaluation?.minimumRequirements?.met === true,
    securityBehaviorPreserved: promotion?.checks?.securityRejectionBehavior === true,
    completenessNotWorse: promotion?.checks?.dataCompleteness === true,
    precisionImproved: promotion?.checks?.precisionAtTopK === true,
    adverseExcursionNotWorse: promotion?.checks?.maximumAdverseExcursion === true,
    operationalSLOs: monitoring?.readiness === "READY",
    reasonsExplainable: promotion?.checks?.explainability === true,
    rollbackReady: true
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    status: failedChecks.length ? "BLOCKED" : "PASSED",
    checks,
    failedChecks,
    claimPolicy: "No efficacy or probability claim is enabled by this gate; measured evidence and operator approval remain separate."
  };
}

function buildPhase7Report({ scanRuns = [], evaluation = null, rollout = {}, now = Date.now(), databaseReady = true, schedulerRunning = true, alertMetrics = {}, promotionEvidence = null } = {}) {
  const monitoring = summarizeMonitoring(scanRuns, { now, databaseReady, schedulerRunning, alertMetrics });
  const normalizedRollout = normalizeRollout({ ...rollout, promotionEvidence: promotionEvidence || rollout.promotionEvidence });
  const promotion = evaluateChampionPromotion({
    baseline: promotionEvidence?.baseline,
    candidate: promotionEvidence?.candidate,
    monitoring
  });
  const acceptanceGate = buildAcceptanceGate({ evaluation, monitoring, promotion });
  const rollback = {
    ready: true,
    currentMode: normalizedRollout.mode,
    safeMode: "BASELINE",
    trigger: monitoring.readiness === "NOT_READY" ? "NOT_READY" : monitoring.degraded ? "DEGRADED_SLO" : null,
    action: "Set rollout mode to BASELINE and preserve immutable observations, outcomes, and decision history."
  };
  return {
    version: PHASE7_VERSION,
    configurationHash: CONFIGURATION_HASH,
    generatedAt: new Date(now).toISOString(),
    rollout: normalizedRollout,
    monitoring,
    promotion,
    acceptanceGate,
    rollback,
    runbook: [
      { severity: "P1", trigger: "DATABASE or APPLICATION", action: "Stop promotion, preserve last-known-good board, inspect request/correlation IDs, then rollback to BASELINE." },
      { severity: "P1", trigger: "RPC or PROVIDER", action: "Keep new qualification fail-closed, rotate/fix the provider, and do not replace the last-known-good board." },
      { severity: "P2", trigger: "DEGRADED_DATA or MARKET_DATA", action: "Mark data degraded, retain UNKNOWN fields, inspect partial/timeout rates, and replay immutable observations after recovery." }
    ],
    safety: {
      walletExecutionEnabled: false,
      paperTradingSeparate: true,
      probabilityClaimsEnabled: false,
      realFundMovementEnabled: false
    }
  };
}

function rollbackRollout(rollout = {}, reason = "operator_rollback", now = Date.now()) {
  const current = normalizeRollout(rollout);
  return {
    ...current,
    mode: "BASELINE",
    rollbackAt: new Date(now).toISOString(),
    rollbackReason: String(reason).slice(0, 240),
    promotedAt: null,
    challengerVersion: null,
    promotionEvidence: null
  };
}

module.exports = {
  PHASE7_VERSION,
  PHASE7_CONFIG,
  CONFIGURATION_HASH,
  ROLLOUT_MODES,
  summarizeMonitoring,
  classifyIncident,
  normalizeRollout,
  evaluateChampionPromotion,
  buildAcceptanceGate,
  buildPhase7Report,
  rollbackRollout
};