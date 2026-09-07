const EVIDENCE_QUALITY_VERSION = "evidence-quality-v1";

const EVIDENCE_QUALITY_CONFIG = Object.freeze({
  version: EVIDENCE_QUALITY_VERSION,
  minimumFeatureCompleteness: 75,
  minimumProjectSourceCount: 2,
  freshnessMs: {
    security: 10 * 60 * 1000,
    market: 10 * 60 * 1000,
    features: 10 * 60 * 1000,
    manipulation: 15 * 60 * 1000,
    execution: 2 * 60 * 1000
  }
});

function finite(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function statusFromEvidence({ verified = false, partial = false, invalid = false, stale = false } = {}) {
  if (invalid) return "INVALID";
  if (stale) return "STALE";
  if (verified) return "VERIFIED";
  if (partial) return "PARTIAL";
  return "UNKNOWN";
}

function ageState(ageMs, maximumAgeMs) {
  const age = finite(ageMs);
  if (age == null) return { known: false, stale: false };
  return { known: true, stale: age < 0 || age > maximumAgeMs };
}

function qualityReasons(domain, reasons, status, coverage = null) {
  return {
    domain,
    status,
    coverage,
    reasons: [...new Set(reasons)]
  };
}

function securityQuality(candidate) {
  const security = candidate?.details?.security || {};
  const reasons = [];
  const status = normalizedStatus(security.status);
  if (["REJECTED", "INVALID"].includes(status)) reasons.push("SECURITY_REJECTED");
  if (status === "UNVERIFIED" || status === "UNKNOWN") reasons.push("SECURITY_UNKNOWN");
  if (security.authorities?.mint !== "RENOUNCED") reasons.push("MINT_AUTHORITY_NOT_VERIFIED");
  if (security.authorities?.freeze !== "RENOUNCED") reasons.push("FREEZE_AUTHORITY_NOT_VERIFIED");
  if (finite(security.topHolderPercent) == null) reasons.push("TOP_HOLDER_UNKNOWN");
  const rpcAge = security.rpcEvidence?.securityDataAgeMs
    ?? security.rpcEvidence?.ageMs
    ?? security.securityDataAgeMs;
  const freshness = ageState(rpcAge, EVIDENCE_QUALITY_CONFIG.freshnessMs.security);
  if (freshness.stale) reasons.push("SECURITY_EVIDENCE_STALE");
  const invalid = status === "REJECTED" || status === "INVALID";
  const stale = freshness.stale;
  const verified = status === "VERIFIED"
    && security.verified === true
    && security.authorities?.mint === "RENOUNCED"
    && security.authorities?.freeze === "RENOUNCED"
    && finite(security.topHolderPercent) != null
    && !stale;
  const partial = !invalid && !stale && (
    status === "PARTIAL" || status === "VERIFIED" || security.verified === true
  );
  return qualityReasons("security", reasons, statusFromEvidence({ verified, partial, invalid, stale }), verified ? 1 : 0);
}

function marketQuality(candidate) {
  const market = candidate?.details?.marketQuality || {};
  const metrics = market.metrics || {};
  const reasons = [];
  const marketStatus = normalizedStatus(market.status || market.qualityStatus);
  const age = metrics.marketDataAgeMs ?? market.marketDataAgeMs;
  const freshness = ageState(age, EVIDENCE_QUALITY_CONFIG.freshnessMs.market);
  if (freshness.stale) reasons.push("MARKET_EVIDENCE_STALE");
  if (marketStatus === "UNKNOWN" || marketStatus === "FAILED" || marketStatus === "REJECTED") {
    reasons.push("MARKET_QUALITY_NOT_PASSED");
  }
  const requiredMetrics = [
    ["estimatedEntryImpactPercent", "ENTRY_IMPACT_UNKNOWN"],
    ["volumeLiquidityRatio", "VOLUME_LIQUIDITY_RATIO_UNKNOWN"],
    ["liquidityToMarketCap", "LIQUIDITY_MARKET_CAP_RATIO_UNKNOWN"],
    ["poolAgeMs", "POOL_AGE_UNKNOWN"]
  ];
  const missingMetrics = requiredMetrics.filter(([field]) => finite(metrics[field]) == null);
  missingMetrics.forEach(([, reason]) => reasons.push(reason));
  const verified = (marketStatus === "PASSED" || market.passed === true)
    && missingMetrics.length === 0
    && !freshness.stale;
  const partial = !freshness.stale && (
    marketStatus === "PASSED"
    || market.passed === true
    || Object.keys(metrics).length > 0
  );
  return qualityReasons("market", reasons, statusFromEvidence({ verified, partial, stale: freshness.stale }), verified ? 1 : 0);
}

function featureQuality(candidate) {
  const snapshot = candidate?.details?.featureSnapshot || {};
  const completeness = finite(snapshot.completeness);
  const reasons = Array.isArray(snapshot.qualityReasons) ? [...snapshot.qualityReasons] : [];
  const freshness = ageState(
    snapshot.freshness?.marketDataAgeMs,
    EVIDENCE_QUALITY_CONFIG.freshnessMs.features
  );
  if (freshness.stale) reasons.push("FEATURE_EVIDENCE_STALE");
  if (completeness == null) reasons.push("FEATURE_COMPLETENESS_UNKNOWN");
  else if (completeness < EVIDENCE_QUALITY_CONFIG.minimumFeatureCompleteness) reasons.push("FEATURE_COMPLETENESS_BELOW_MINIMUM");
  const verified = normalizedStatus(snapshot.status) === "COMPLETE"
    && completeness != null
    && completeness >= EVIDENCE_QUALITY_CONFIG.minimumFeatureCompleteness
    && !freshness.stale;
  const partial = !freshness.stale && completeness != null;
  return {
    ...qualityReasons("momentum", reasons, statusFromEvidence({ verified, partial, stale: freshness.stale }), completeness == null ? 0 : Math.min(1, completeness / 100)),
    completeness
  };
}

function manipulationQuality(candidate) {
  const evidence = candidate?.details?.manipulationEvidence;
  const reasons = [];
  if (!evidence) reasons.push("MANIPULATION_EVIDENCE_NOT_AVAILABLE");
  const sampleStatus = normalizedStatus(evidence?.sampleStatus);
  const freshness = ageState(
    evidence?.freshness?.ageMs ?? evidence?.marketDataAgeMs,
    EVIDENCE_QUALITY_CONFIG.freshnessMs.manipulation
  );
  if (freshness.stale) reasons.push("MANIPULATION_EVIDENCE_STALE");
  const blockingFlags = ["washTrading", "circularActivity", "coordinatedActivity", "poolDrain"]
    .filter(flag => evidence?.flags?.[flag] === true);
  if (blockingFlags.length) reasons.push(...blockingFlags.map(flag => `${flag.toUpperCase()}_FLAGGED`));
  const verified = Boolean(evidence)
    && sampleStatus === "SUFFICIENT"
    && blockingFlags.length === 0
    && !freshness.stale;
  const partial = Boolean(evidence) && !freshness.stale;
  return {
    ...qualityReasons("manipulation", reasons, statusFromEvidence({ verified, partial, stale: freshness.stale }), verified ? 1 : partial ? 0.5 : 0),
    sampleStatus: sampleStatus || "UNKNOWN",
    blockingFlags
  };
}

function projectQuality(candidate) {
  const traction = candidate?.details?.projectTraction;
  const reasons = [];
  const sourceSet = Array.isArray(traction?.sourceSet)
    ? traction.sourceSet.filter(Boolean)
    : [];
  const classification = normalizedStatus(traction?.classification);
  if (!traction) reasons.push("PROJECT_TRACTION_UNKNOWN");
  if (traction?.status !== "VERIFIED") reasons.push(`PROJECT_TRACTION_${traction?.status || "UNKNOWN"}`);
  if (sourceSet.length < EVIDENCE_QUALITY_CONFIG.minimumProjectSourceCount) reasons.push("PROJECT_TRACTION_INDEPENDENT_SOURCE_COVERAGE_INSUFFICIENT");
  if (traction?.capLifted !== true) reasons.push("PROJECT_TRACTION_QUALITY_CAP_ACTIVE");
  const verified = Boolean(traction)
    && traction.status === "VERIFIED"
    && traction.capLifted === true
    && sourceSet.length >= EVIDENCE_QUALITY_CONFIG.minimumProjectSourceCount;
  const partial = Boolean(traction) || Boolean(candidate?.details?.profile);
  return {
    ...qualityReasons("project", reasons, statusFromEvidence({ verified, partial }), verified ? 1 : partial ? 0.5 : 0),
    classification: classification || "UNVERIFIED",
    sourceCount: sourceSet.length,
    capLifted: traction?.capLifted === true
  };
}

function executionQuality(candidate) {
  const execution = candidate?.details?.executionSafety || {};
  const status = normalizedStatus(execution.status);
  const reasons = [];
  if (status === "REJECTED") reasons.push("EXECUTION_SAFETY_REJECTED");
  if (!["ACTIONABLE_RESEARCH", "REJECTED"].includes(status)) reasons.push("EXECUTION_EVIDENCE_UNKNOWN");
  const verified = status === "ACTIONABLE_RESEARCH";
  return qualityReasons("execution", reasons, statusFromEvidence({ verified, invalid: status === "REJECTED" }), verified ? 1 : 0);
}

function activeRadarFor(candidate) {
  const classification = normalizedStatus(
    candidate?.details?.projectTraction?.classification
      || candidate?.details?.classification
      || candidate?.classification
      || candidate?.details?.providerMetadata?.classification
  );
  const radarByClassification = {
    REAL_PROJECT: "REAL_PROJECT",
    REACTIVATION: "REACTIVATION",
    SPECULATIVE_MEME: "SPECULATIVE_MEME"
  };
  return radarByClassification[classification] || null;
}

function evaluateEvidenceQuality(candidate, {
  activeRadar = activeRadarFor(candidate),
  decisionTime = timestamp(candidate?.details?.observedAt || candidate?.updatedAt) ?? 0
} = {}) {
  const domains = {
    security: securityQuality(candidate),
    market: marketQuality(candidate),
    momentum: featureQuality(candidate),
    manipulation: manipulationQuality(candidate),
    project: projectQuality(candidate),
    execution: executionQuality(candidate)
  };
  const requiredDomains = ["security", "market", "momentum", "manipulation"];
  if (activeRadar === "REAL_PROJECT") requiredDomains.push("project");
  const required = requiredDomains.map(domain => domains[domain]);
  const blocking = required
    .filter(domain => ["UNKNOWN", "STALE", "INVALID"].includes(domain.status))
    .map(domain => `${domain.domain.toUpperCase()}_EVIDENCE_${domain.status}`);
  const partial = required.filter(domain => domain.status === "PARTIAL").map(domain => `${domain.domain.toUpperCase()}_EVIDENCE_PARTIAL`);
  const sourceLineage = candidate?.details?.providerMetadata?.discoveryLineage
    || candidate?.details?.discoveryLineage
    || candidate?.details?.evidence;
  const lineageAvailable = Array.isArray(sourceLineage) && sourceLineage.length > 0;
  const reasons = [
    ...blocking,
    ...partial,
    ...(lineageAvailable ? [] : ["EVIDENCE_LINEAGE_PARTIAL"])
  ];
  const verifiedCount = required.filter(domain => domain.status === "VERIFIED").length;
  const coverage = required.length ? Number((verifiedCount / required.length).toFixed(4)) : 0;
  const observedAt = timestamp(candidate?.details?.observedAt || candidate?.updatedAt);
  const futureEvidence = observedAt != null && observedAt > decisionTime;
  if (futureEvidence) reasons.push("EVIDENCE_AS_OF_AFTER_DECISION_TIME");
  return {
    version: EVIDENCE_QUALITY_VERSION,
    decisionTime: new Date(decisionTime).toISOString(),
    observedAt: observedAt == null ? null : new Date(observedAt).toISOString(),
    activeRadar,
    requiredDomains,
    domains,
    coverage,
    verified: blocking.length === 0 && partial.length === 0 && !futureEvidence,
    qualifyingAllowed: blocking.length === 0 && partial.length === 0 && !futureEvidence,
    lineage: {
      available: lineageAvailable,
      status: lineageAvailable ? "AVAILABLE" : "PARTIAL"
    },
    futureEvidence,
    reasons: [...new Set(reasons)]
  };
}

module.exports = {
  EVIDENCE_QUALITY_VERSION,
  EVIDENCE_QUALITY_CONFIG,
  activeRadarFor,
  evaluateEvidenceQuality
};