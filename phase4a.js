const crypto = require("crypto");

const PHASE4A_VERSION = "phase4a-v1";
const GOVERNANCE_VERSION = "phase4a-governance-v1";
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REGIMES = new Set(["RISK_ON", "NEUTRAL", "RISK_OFF", "PANIC", "ROTATION", "EXPANSION", "UNKNOWN"]);
const ROLLOUT_MODES = Object.freeze(["BASELINE", "SHADOW", "CANDIDATE", "ACTIVE_RESEARCH"]);

const PHASE4A_CONFIG = Object.freeze({
  version: PHASE4A_VERSION,
  sourceSet: ["valuationEvidence", "catalystEvidence", "marketRegimeEvidence", "phase4Scorecard", "projectTraction"],
  comparable: {
    maxAgeMs: MAX_EVIDENCE_AGE_MS,
    minimumCount: 2,
    minimumSources: 2,
    requiredMetric: "marketCapOrFdv"
  },
  catalyst: {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    verifiedStatuses: ["VERIFIED", "CONFIRMED"],
    fullyPricedStatuses: ["FULLY_PRICED", "PRICED_IN"]
  },
  thresholds: {
    strongContradiction: 70,
    minimumComparableQuality: 50,
    minimumCatalystScore: 55
  },
  weights: {
    phase4aOpportunity: { baselineOpportunity: 60, valuation: 15, catalyst: 15, marketRegimeFit: 10 }
  }
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const PHASE4A_CONFIGURATION_HASH = crypto
  .createHash("sha256")
  .update(stable(PHASE4A_CONFIG))
  .digest("hex");

const GOVERNANCE_CONFIG = Object.freeze({
  version: GOVERNANCE_VERSION,
  minimumHoldoutSample: 100,
  minimumPrecisionLift: 0,
  maximumMaeWorsening: 0,
  maximumLatencyIncreasePercent: 20,
  requiredChecks: [
    "SECURITY_NOT_WEAKER",
    "COMPLETENESS_NOT_WORSE",
    "PRECISION_LIFT",
    "ADVERSE_EXCURSION",
    "LATENCY_BUDGET",
    "EXPLAINABLE_REASONS",
    "TEMPORAL_HOLDOUT",
    "MODEL_GUARDIAN"
  ]
});

const GOVERNANCE_CONFIGURATION_HASH = crypto
  .createHash("sha256")
  .update(stable(GOVERNANCE_CONFIG))
  .digest("hex");

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, minimum = 0, maximum = 100) {
  const parsed = number(value);
  return parsed == null ? null : Number(Math.max(minimum, Math.min(maximum, parsed)).toFixed(4));
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function validUrl(value) {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function average(values, weights) {
  const usable = values.map((value, index) => ({ value: number(value), weight: weights[index] }))
    .filter(item => item.value != null && item.weight > 0);
  if (!usable.length) return null;
  const totalWeight = usable.reduce((sum, item) => sum + item.weight, 0);
  return clamp(usable.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight);
}

function calculateDrift(current = {}, reference = {}) {
  const keys = [...new Set([...Object.keys(current || {}), ...Object.keys(reference || {})])].sort();
  const featureMissingness = {};
  const scoreDeltas = {};
  for (const key of keys) {
    const currentValue = current?.[key];
    const referenceValue = reference?.[key];
    featureMissingness[key] = (currentValue == null ? 1 : 0) - (referenceValue == null ? 1 : 0);
    if (number(currentValue) != null && number(referenceValue) != null) {
      scoreDeltas[key] = Number((Number(currentValue) - Number(referenceValue)).toFixed(4));
    }
  }
  const values = Object.values(scoreDeltas);
  return {
    featureMissingness,
    scoreDeltas,
    averageScoreDelta: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null,
    status: values.length || Object.keys(featureMissingness).length ? "OBSERVED" : "UNKNOWN"
  };
}

const MODEL_GUARDIAN_CHECKS = Object.freeze([
  ["LEAKAGE_REVIEW", "leakageChecked"],
  ["OVERFITTING_REVIEW", "overfittingChecked"],
  ["SAMPLE_SIZE_REVIEW", "sampleSizeSufficient"],
  ["OUT_OF_SAMPLE_REVIEW", "outOfSampleValidated"],
  ["REGIME_ROBUSTNESS_REVIEW", "regimeRobust"],
  ["ADVERSARIAL_ROBUSTNESS_REVIEW", "adversarialRobust"],
  ["CALIBRATION_REVIEW", "calibrationValidated"],
  ["DEGRADATION_REVIEW", "degradationWithinGuardrail"]
]);

function evaluateModelGuardian(input = {}) {
  const guardian = input.modelGuardian && typeof input.modelGuardian === "object"
    ? input.modelGuardian
    : {};
  const checks = MODEL_GUARDIAN_CHECKS.map(([code, key]) => ({
    code,
    passed: guardian[key] === true || input[key] === true
  }));
  const failed = checks.filter(check => !check.passed).map(check => check.code);
  return {
    status: failed.length ? "REJECT_MODEL" : "PASS",
    passed: failed.length === 0,
    checks,
    failedChecks: failed,
    reason: failed.length
      ? "Promotion is blocked until the model guardian validates leakage, robustness, and degradation controls."
      : "All model guardian checks passed."
  };
}

function evaluatePromotionGate(input = {}) {
  const sampleSize = number(input.holdoutSampleSize) ?? 0;
  const precisionLift = number(input.precisionLift);
  const maeChange = number(input.maximumAdverseExcursionChange);
  const latencyChange = number(input.latencyIncreasePercent);
  const modelGuardian = evaluateModelGuardian(input);
  const checks = [
    { code: "SECURITY_NOT_WEAKER", passed: input.securityNotWeaker === true },
    { code: "COMPLETENESS_NOT_WORSE", passed: input.completenessNotWorse === true },
    { code: "PRECISION_LIFT", passed: precisionLift != null && precisionLift >= GOVERNANCE_CONFIG.minimumPrecisionLift },
    { code: "ADVERSE_EXCURSION", passed: maeChange != null && maeChange <= GOVERNANCE_CONFIG.maximumMaeWorsening },
    { code: "LATENCY_BUDGET", passed: latencyChange != null && latencyChange <= GOVERNANCE_CONFIG.maximumLatencyIncreasePercent },
    { code: "EXPLAINABLE_REASONS", passed: input.explainableReasons === true },
    { code: "TEMPORAL_HOLDOUT", passed: input.temporalHoldoutValidated === true && sampleSize >= GOVERNANCE_CONFIG.minimumHoldoutSample },
    { code: "MODEL_GUARDIAN", passed: modelGuardian.passed }
  ];
  const failed = checks.filter(check => !check.passed).map(check => check.code);
  return {
    status: failed.length ? "HOLDOUT_REQUIRED" : "ELIGIBLE_PENDING_APPROVAL",
    eligible: failed.length === 0,
    holdoutSampleSize: sampleSize,
    checks,
    failedChecks: failed,
    modelGuardian,
    reason: failed.length ? "Promotion is blocked until every governance check passes." : "All configured checks passed; explicit approval is still required."
  };
}

function buildCalibrationGovernance({ mode = "SHADOW", championVersion = "phase4-v1", challengerVersion = PHASE4A_VERSION, gate = {}, currentMetrics = {}, referenceMetrics = {} } = {}) {
  const normalizedMode = ROLLOUT_MODES.includes(String(mode).toUpperCase()) ? String(mode).toUpperCase() : "SHADOW";
  return {
    version: GOVERNANCE_VERSION,
    configurationHash: GOVERNANCE_CONFIGURATION_HASH,
    mode: normalizedMode,
    champion: {
      version: championVersion,
      userVisible: true
    },
    challenger: {
      version: challengerVersion,
      userVisible: false,
      affectsAlerts: false,
      affectsPaperTrades: false
    },
    thresholds: GOVERNANCE_CONFIG,
    drift: calculateDrift(currentMetrics, referenceMetrics),
    promotion: evaluatePromotionGate(gate),
    modelGuardian: evaluateModelGuardian(gate),
    rollback: {
      available: true,
      target: championVersion,
      reason: "Challenger cannot replace the champion without a validated holdout and approval record."
    }
  };
}

function median(values) {
  const sorted = values.filter(value => number(value) != null).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function evidenceDate(record) {
  return asDate(record?.observedAt || record?.asOf || record?.verifiedAt);
}

function validEvidenceRecord(record, asOf, maxAgeMs) {
  const observedAt = evidenceDate(record);
  return Boolean(
    record?.verified === true
    && String(record?.sourceId || record?.source || "").trim()
    && validUrl(record?.sourceUrl || record?.url)
    && observedAt
    && asOf
    && observedAt.getTime() <= asOf.getTime()
    && asOf.getTime() - observedAt.getTime() <= maxAgeMs
  );
}

function valuationMetric(candidate) {
  const valuation = candidate?.details?.valuationEvidence || candidate?.details?.valuation || {};
  const pair = candidate?.details?.pair || {};
  const metric = String(valuation.metric || "marketCap").toLowerCase();
  const value = number(valuation.targetValue ?? (metric === "fdv" ? pair.fdv : pair.marketCap ?? candidate.marketCap));
  return { valuation, metric: metric === "fdv" ? "fdv" : "marketCap", value };
}

function evaluateValuation(candidate, asOf) {
  const { valuation, metric, value: targetValue } = valuationMetric(candidate);
  const records = Array.isArray(valuation.comparables) ? valuation.comparables : [];
  const valid = records.filter(record => validEvidenceRecord(record, asOf, PHASE4A_CONFIG.comparable.maxAgeMs))
    .filter(record => !record.excluded && number(record[metric] ?? record.marketCap ?? record.fdv) > 0)
    .filter(record => !valuation.sector || !record.sector || record.sector === valuation.sector)
    .filter(record => !valuation.stage || !record.stage || record.stage === valuation.stage);
  const unknowns = [];
  if (targetValue == null || targetValue <= 0) unknowns.push("TARGET_VALUATION_UNKNOWN");
  if (records.length !== valid.length) unknowns.push("INVALID_OR_STALE_COMPARABLES_EXCLUDED");
  if (valid.length < PHASE4A_CONFIG.comparable.minimumCount) unknowns.push("COMPARABLE_COVERAGE_INSUFFICIENT");
  const values = valid.map(record => number(record[metric] ?? record.marketCap ?? record.fdv));
  const comparableMedian = median(values);
  const sources = new Set(valid.map(record => String(record.sourceId || record.source)));
  if (sources.size < PHASE4A_CONFIG.comparable.minimumSources) unknowns.push("INDEPENDENT_COMPARABLE_SOURCES_INSUFFICIENT");
  const ratio = targetValue != null && comparableMedian ? targetValue / comparableMedian : null;
  const asymmetry = ratio == null ? null : clamp((1 - Math.min(ratio, 1.5) / 1.5) * 100);
  const comparableQuality = valid.length
    ? clamp(Math.min(100, valid.length / 5 * 60 + Math.min(40, sources.size * 20)))
    : null;
  const valuationScore = asymmetry == null || valid.length < PHASE4A_CONFIG.comparable.minimumCount ? null : average(
    [asymmetry, comparableQuality],
    [70, 30]
  );
  return {
    status: valuationScore == null ? "UNKNOWN" : "EVIDENCE_AVAILABLE",
    metric,
    targetValue,
    comparableMedian,
    targetToComparableRatio: ratio,
    valuationAsymmetry: asymmetry,
    valuationScore,
    comparableQuality,
    comparableCoverage: valid.length,
    sourceCount: sources.size,
    sector: valuation.sector || null,
    stage: valuation.stage || null,
    methodology: {
      selection: "verified fresh records matching sector/stage when supplied",
      metric,
      maxAgeMs: PHASE4A_CONFIG.comparable.maxAgeMs,
      included: valid.map(record => String(record.id || record.sourceId || record.source)).sort(),
      excludedCount: records.length - valid.length
    },
    unknowns
  };
}

function catalystScoreFor(record, asOf) {
  const expectedAt = asDate(record.expectedAt || record.expectedTime);
  if (!expectedAt || !asOf || expectedAt.getTime() <= asOf.getTime()) return null;
  const days = (expectedAt.getTime() - asOf.getTime()) / 86_400_000;
  const proximity = days <= 7 ? 95 : days <= 30 ? 80 : days <= 90 ? 60 : 35;
  const awareness = number(record.marketAwareness);
  const awarenessScore = awareness == null ? 50 : clamp(100 - awareness);
  const pricingStatus = String(record.pricingStatus || "UNKNOWN").toUpperCase();
  const pricingScore = PHASE4A_CONFIG.catalyst.fullyPricedStatuses.includes(pricingStatus)
    ? 0
    : pricingStatus === "PARTIALLY_PRICED" ? 45 : pricingStatus === "NOT_PRICED" ? 90 : 50;
  return { proximity, awarenessScore, pricingScore, days, expectedAt: expectedAt.toISOString(), pricingStatus };
}

function evaluateCatalysts(candidate, asOf) {
  const input = candidate?.details?.catalystEvidence || candidate?.details?.catalysts || [];
  const records = Array.isArray(input) ? input : Array.isArray(input.records) ? input.records : [];
  const valid = records.filter(record => validEvidenceRecord(record, asOf, PHASE4A_CONFIG.catalyst.maxAgeMs))
    .filter(record => PHASE4A_CONFIG.catalyst.verifiedStatuses.includes(String(record.status || (record.verified ? "VERIFIED" : "")).toUpperCase()))
    .map(record => ({ record, score: catalystScoreFor(record, asOf) }))
    .filter(item => item.score);
  const unknowns = [];
  if (records.length !== valid.length) unknowns.push("UNVERIFIED_OR_STALE_CATALYSTS_EXCLUDED");
  if (!valid.length) unknowns.push("VERIFIED_CATALYST_UNKNOWN");
  const scored = valid.map(item => average(
    [item.score.proximity, item.score.awarenessScore, item.score.pricingScore],
    [45, 25, 30]
  ));
  const catalystScore = scored.length ? Math.max(...scored) : null;
  const primary = valid.slice().sort((a, b) => b.score.proximity - a.score.proximity || a.score.expectedAt.localeCompare(b.score.expectedAt))[0];
  return {
    status: catalystScore == null ? "UNKNOWN" : "VERIFIED",
    catalystScore,
    verifiedCount: valid.length,
    next: primary ? {
      id: primary.record.id || null,
      type: primary.record.type || "UNKNOWN",
      title: primary.record.title || primary.record.claim || "Verified catalyst",
      sourceId: primary.record.sourceId || primary.record.source,
      sourceUrl: validUrl(primary.record.sourceUrl || primary.record.url),
      expectedAt: primary.score.expectedAt,
      proximityDays: Number(primary.score.days.toFixed(2)),
      pricingStatus: primary.score.pricingStatus
    } : null,
    catalysts: valid.map(item => ({
      id: item.record.id || null,
      title: item.record.title || item.record.claim || "Verified catalyst",
      sourceId: item.record.sourceId || item.record.source,
      expectedAt: item.score.expectedAt,
      pricingStatus: item.score.pricingStatus,
      score: average([item.score.proximity, item.score.awarenessScore, item.score.pricingScore], [45, 25, 30])
    })),
    unknowns
  };
}

function evaluateMarketRegime(candidate, asOf) {
  const input = candidate?.details?.marketRegime || candidate?.details?.regimeEvidence || {};
  const state = String(input.state || "UNKNOWN").toUpperCase();
  const valid = REGIMES.has(state) && state !== "UNKNOWN" && input.verified === true
    && validEvidenceRecord(input, asOf, 24 * 60 * 60 * 1000);
  const fitScore = valid ? clamp(input.fitScore ?? input.sectorFitScore) : null;
  const unknowns = [];
  if (!valid) unknowns.push("MARKET_REGIME_UNKNOWN");
  if (valid && fitScore == null) unknowns.push("MARKET_REGIME_FIT_UNKNOWN");
  return {
    state: valid ? state : "UNKNOWN",
    fitScore,
    confidence: valid ? clamp(input.confidence) : null,
    sourceId: valid ? input.sourceId || input.source : null,
    sourceUrl: valid ? validUrl(input.sourceUrl || input.url) : null,
    observedAt: valid ? evidenceDate(input).toISOString() : null,
    unknowns
  };
}

function textList(value) {
  return Array.isArray(value) ? value.map(item => {
    if (typeof item === "string") return { code: "EXPLICIT", text: item };
    return { code: item?.code || "EVIDENCE", text: item?.text || item?.claim || item?.reason || "Evidence recorded." };
  }).filter(item => item.text).slice(0, 12) : [];
}

function evaluateThesis(candidate, valuation, catalysts, regime) {
  const details = candidate?.details || {};
  const supplied = details.thesis || {};
  const positiveEvidence = textList(supplied.positiveEvidence || supplied.supportingEvidence);
  const negativeEvidence = textList(supplied.negativeEvidence || supplied.contradictingEvidence);
  const contradictions = textList(supplied.contradictions || supplied.contradiction);
  const invalidation = textList(supplied.invalidationConditions || supplied.invalidation);
  if (valuation.valuationScore != null && valuation.valuationAsymmetry >= 60) {
    positiveEvidence.push({ code: "VALUATION_ASYMMETRY", text: "Fresh comparable evidence indicates valuation asymmetry." });
  } else if (valuation.status === "UNKNOWN") {
    negativeEvidence.push({ code: "VALUATION_UNKNOWN", text: "Comparable valuation evidence is unavailable or insufficient." });
  }
  if (catalysts.catalystScore != null && catalysts.catalystScore >= PHASE4A_CONFIG.thresholds.minimumCatalystScore) {
    positiveEvidence.push({ code: "VERIFIED_CATALYST", text: "At least one verified future catalyst has timing and pricing evidence." });
  } else {
    negativeEvidence.push({ code: "CATALYST_UNKNOWN", text: "No sufficiently verified, future, underappreciated catalyst is available." });
  }
  if (regime.fitScore != null && regime.fitScore >= 60) {
    positiveEvidence.push({ code: "REGIME_FIT", text: `Market regime ${regime.state} has explicit sector-fit evidence.` });
  } else {
    negativeEvidence.push({ code: "REGIME_UNKNOWN", text: "Market-regime and sector-fit evidence is unavailable." });
  }
  const security = details.security || {};
  if (security.status === "REJECTED" || security.verified === false) {
    contradictions.push({ code: "SECURITY_FAILURE", text: "Security evidence contradicts an actionable thesis." });
  }
  const unique = items => [...new Map(items.map(item => [item.code + ":" + item.text, item])).values()];
  const strongestFailureReason = contradictions[0]?.text
    || negativeEvidence.find(item => item.code === "VALUATION_UNKNOWN")?.text
    || negativeEvidence[0]?.text
    || "No explicit failure reason was recorded.";
  const primary = supplied.primary || supplied.primaryThesis
    || (positiveEvidence.length ? "Evidence supports a research candidate, subject to unresolved valuation, catalyst, and regime checks." : "No complete Phase 4A thesis is available.");
  const strongContradiction = contradictions.length > 0 && (
    contradictions.some(item => ["SECURITY_FAILURE", "THESIS_CONFLICT", "PROJECT_INVALIDATED"].includes(item.code))
    || number(supplied.contradictionSeverity) >= PHASE4A_CONFIG.thresholds.strongContradiction
  );
  return {
    primary,
    positiveEvidence: unique(positiveEvidence),
    negativeEvidence: unique(negativeEvidence),
    contradictions: unique(contradictions),
    strongestFailureReason,
    invalidationConditions: unique(invalidation.length ? invalidation : [
      { code: "SECURITY_INVALIDATED", text: "Invalidate if security verification fails or becomes stale." },
      { code: "MARKET_QUALITY_INVALIDATED", text: "Invalidate if market-quality or sellability gates fail." },
      { code: "THESIS_CONFLICT", text: "Invalidate if verified negative evidence outweighs the stated thesis." }
    ]),
    state: strongContradiction ? "THESIS_CONFLICT" : positiveEvidence.length ? "VALIDATING" : "NO_SIGNAL",
    strongContradiction
  };
}

function evaluatePhase4A(candidate, { asOf = null } = {}) {
  const observedAt = asDate(asOf || candidate?.details?.observedAt || candidate?.details?.providerMetadata?.providerUpdatedAt);
  const valuation = evaluateValuation(candidate, observedAt);
  const catalysts = evaluateCatalysts(candidate, observedAt);
  const marketRegime = evaluateMarketRegime(candidate, observedAt);
  const thesis = evaluateThesis(candidate, valuation, catalysts, marketRegime);
  const governance = buildCalibrationGovernance({
    currentMetrics: candidate?.details?.governanceMetrics || {},
    referenceMetrics: candidate?.details?.baselineMetrics || {}
  });
  const warnings = [...new Set([
    ...valuation.unknowns,
    ...catalysts.unknowns,
    ...marketRegime.unknowns,
    ...(thesis.strongContradiction ? ["THESIS_CONFLICT"] : [])
  ])];
  return {
    version: PHASE4A_VERSION,
    configurationHash: PHASE4A_CONFIGURATION_HASH,
    sourceSet: PHASE4A_CONFIG.sourceSet,
    asOf: observedAt ? observedAt.toISOString() : null,
    valuation,
    catalysts,
    marketRegime,
    thesis,
    governance,
    warnings,
    complete: warnings.length === 0
  };
}

module.exports = {
  PHASE4A_VERSION,
  PHASE4A_CONFIG,
  PHASE4A_CONFIGURATION_HASH,
  GOVERNANCE_VERSION,
  GOVERNANCE_CONFIG,
  GOVERNANCE_CONFIGURATION_HASH,
  calculateDrift,
  evaluatePromotionGate,
  evaluateModelGuardian,
  buildCalibrationGovernance,
  evaluatePhase4A
};