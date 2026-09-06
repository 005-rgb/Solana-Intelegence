const crypto = require("crypto");
const { TRACTION_VERSION } = require("./project-traction");
const {
  PHASE4A_VERSION,
  PHASE4A_CONFIGURATION_HASH,
  PHASE4A_CONFIG,
  evaluatePhase4A
} = require("./phase4a");

const SCORE_VERSION = "phase4-v1";
const FEATURE_VERSION = "phase3-v1";
const RADAR_TYPES = Object.freeze(["REAL_PROJECT", "REACTIVATION", "SPECULATIVE_MEME"]);
const SCORE_CONFIG = Object.freeze({
  version: SCORE_VERSION,
  sourceSet: ["security", "marketQuality", "phase3Features", "phase3AManipulation", "executionSafety", "providerProfile", "projectTraction"],
  thresholds: {
    confidenceForQualifying: 60,
    maximumRiskForQualifying: 55,
    minimumOpportunityForQualifying: 55,
    minimumEntryForAcceptable: 60,
    chasePriceChangePercent: 25,
    blockingManipulation: ["washTrading", "circularActivity", "coordinatedActivity", "poolDrain"]
  },
  componentWeights: {
    opportunity: { momentumQuality: 35, marketQuality: 25, flowQuality: 20, securityQuality: 20 },
    realProject: { projectQuality: 30, tokenQuality: 25, opportunity: 25, riskInverse: 20 },
    reactivation: { projectQuality: 20, momentumQuality: 30, tokenQuality: 15, opportunity: 20, confidence: 15 },
    speculativeMeme: { momentumQuality: 35, flowQuality: 20, structuralFeasibility: 20, tokenQuality: 10, opportunity: 15 }
  }
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const CONFIGURATION_HASH = crypto.createHash("sha256").update(stable(SCORE_CONFIG)).digest("hex");

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum = 0, maximum = 100) {
  const number = finite(value);
  return number == null ? null : Number(Math.max(minimum, Math.min(maximum, number)).toFixed(4));
}

function average(values, weights = null) {
  const usable = values.map((value, index) => ({ value: finite(value), weight: weights ? finite(weights[index]) : 1 }))
    .filter(item => item.value != null && item.weight != null && item.weight > 0);
  if (!usable.length) return { value: null, coverage: 0 };
  const totalWeight = usable.reduce((sum, item) => sum + item.weight, 0);
  return {
    value: clamp(usable.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight),
    coverage: Number((totalWeight / (weights ? weights.reduce((sum, item) => sum + item, 0) : usable.length)).toFixed(4))
  };
}

function percent(value) {
  return finite(String(value ?? "").replace("%", ""));
}

function positiveRatio(value, baseline = 1, maximum = 3) {
  const number = finite(value);
  if (number == null) return null;
  return clamp(((number - baseline) / (maximum - baseline)) * 100, 0, 100);
}

function inverseRatio(value, maximum) {
  const number = finite(value);
  if (number == null || maximum <= 0) return null;
  return clamp(100 - (number / maximum) * 100);
}

function profileEvidence(item) {
  const details = item?.details || {};
  const profile = details.profile || {};
  const metadata = details.providerMetadata || {};
  const traction = details.projectTraction;
  const pair = details.pair || {};
  const websites = Array.isArray(profile.websites) ? profile.websites : [];
  const socials = Array.isArray(profile.socials) ? profile.socials : [];
  const evidence = [
    [Boolean(profile.description || metadata.description), 25],
    [websites.length > 0, 15],
    [socials.length > 0, 10],
    [Boolean(item?.name && item?.symbol && item?.mint), 15],
    [finite(pair.volume?.h24) != null, 15],
    [finite(pair.txns?.h24?.buys) != null && finite(pair.txns?.h24?.sells) != null, 10],
    [finite(pair.makers?.h24) != null, 10]
  ];
  const raw = evidence.reduce((sum, [present, points]) => sum + (present ? points : 0), 0);
  const warnings = [];
  if (traction?.version === TRACTION_VERSION && traction.projectQualityScore != null) {
    const cap = finite(traction.qualityCap) ?? 70;
    const value = clamp(Math.min(traction.projectQualityScore, cap));
    if (!traction.capLifted) warnings.push(`CAP_PROJECT_TRACTION_${cap}`);
    warnings.push(...(traction.qualityReasons || []));
    if (traction.status !== "VERIFIED") warnings.push(`PROJECT_TRACTION_${traction.status || "UNKNOWN"}`);
    return { value, warnings };
  }
  if (!profile.description && !metadata.description) warnings.push("PROJECT_DESCRIPTION_UNKNOWN");
  if (!websites.length && !socials.length) warnings.push("PROJECT_LINK_EVIDENCE_UNKNOWN");
  warnings.push("PROJECT_TRACTION_UNKNOWN", "CAP_PROJECT_TRACTION_70");
  return { value: clamp(raw, 0, 70), warnings };
}

function securityQuality(security) {
  if (!security || security.status === "UNVERIFIED" || security.status === "UNKNOWN") return { value: null, reasons: ["SECURITY_QUALITY_UNKNOWN"] };
  const values = [
    security.verified === true ? 40 : 0,
    security.authorities?.mint === "RENOUNCED" ? 20 : 0,
    security.authorities?.freeze === "RENOUNCED" ? 20 : 0,
    security.topHolderPercent == null ? null : security.topHolderPercent <= 80 ? 20 : 0
  ];
  const result = average(values, [40, 20, 20, 20]);
  return { value: result.value, reasons: result.value === 100 ? [] : ["SECURITY_QUALITY_REDUCED"] };
}

function marketQuality(item) {
  const market = item?.details?.marketQuality || {};
  if (market.status === "PASSED" || market.passed === true) return { value: 100, reasons: [] };
  const metrics = market.metrics || {};
  const values = [
    inverseRatio(metrics.estimatedEntryImpactPercent, 2),
    inverseRatio(metrics.volumeLiquidityRatio, 100),
    finite(metrics.liquidityToMarketCap) == null ? null : clamp(metrics.liquidityToMarketCap * 4_000),
    finite(metrics.poolAgeMs) == null ? null : clamp(metrics.poolAgeMs / (60 * 60 * 1000) * 100)
  ];
  const result = average(values, [35, 25, 25, 15]);
  return { value: result.value, reasons: result.value == null ? ["MARKET_QUALITY_UNKNOWN"] : ["MARKET_QUALITY_GATE_NOT_PASSED"] };
}

function momentumQuality(item) {
  const details = item?.details || {};
  const features = details.featureSnapshot?.features || {};
  const pair = details.pair || {};
  const values = [
    finite(features.priceAcceleration) == null ? null : clamp(50 + features.priceAcceleration * 2),
    positiveRatio(features.volumeAcceleration, 1, 3),
    finite(features.makerGrowth) == null ? null : clamp(50 + features.makerGrowth),
    percent(pair.priceChange?.h24) == null ? null : clamp(50 + percent(pair.priceChange.h24) * 1.5)
  ];
  const result = average(values, [30, 25, 25, 20]);
  const reasons = [];
  if (result.value == null) reasons.push("MOMENTUM_EVIDENCE_UNKNOWN");
  if (features.priceAcceleration == null || features.volumeAcceleration == null) reasons.push("PHASE3_FEATURE_SAMPLE_PARTIAL");
  return { value: result.value, reasons };
}

function flowQuality(item) {
  const features = item?.details?.featureSnapshot?.features || {};
  const imbalance = finite(features.buySellImbalance);
  const makerGrowth = finite(features.makerGrowth);
  const values = [
    imbalance == null ? null : clamp(50 + imbalance * 50),
    makerGrowth == null ? null : clamp(50 + makerGrowth)
  ];
  const result = average(values, [60, 40]);
  return {
    value: result.value,
    reasons: result.value == null ? ["FLOW_QUALITY_UNKNOWN"] : []
  };
}

function tokenQuality(item, securityScore) {
  const security = securityScore.value;
  const market = item?.details?.marketQuality?.passed === true || item?.details?.marketQuality?.status === "PASSED";
  const result = average([security, market ? 100 : null], [75, 25]);
  return {
    value: result.value,
    reasons: result.value == null ? ["TOKEN_QUALITY_UNKNOWN"] : security == null ? ["SECURITY_QUALITY_UNKNOWN"] : []
  };
}

function structuralFeasibility(item) {
  const market = item?.details?.marketQuality || {};
  const execution = item?.details?.executionSafety || {};
  const values = [
    inverseRatio(market.metrics?.estimatedEntryImpactPercent, 2),
    inverseRatio(market.metrics?.volumeLiquidityRatio, 100),
    execution.status === "ACTIONABLE_RESEARCH" ? 100 : execution.status === "REJECTED" ? 0 : null,
    market.passed === true || market.status === "PASSED" ? 100 : null
  ];
  const result = average(values, [30, 20, 30, 20]);
  return {
    value: result.value,
    reasons: result.value == null ? ["STRUCTURAL_FEASIBILITY_UNKNOWN"] : []
  };
}

function manipulationRisk(item) {
  const evidence = item?.details?.manipulationEvidence;
  if (!evidence) return { value: null, reasons: ["MANIPULATION_EVIDENCE_NOT_AVAILABLE"] };
  const flags = evidence.flags || {};
  const blockingFlags = SCORE_CONFIG.thresholds.blockingManipulation.filter(flag => flags[flag] === true);
  if (blockingFlags.length) return { value: 100, reasons: blockingFlags.map(flag => `${flag.toUpperCase()}_FLAGGED`) };
  if (evidence.sampleStatus !== "SUFFICIENT") return { value: 50, reasons: ["MANIPULATION_SAMPLE_UNKNOWN"] };
  return { value: 0, reasons: [] };
}

function riskScore(item, securityScore, structuralScore) {
  const securityRisk = securityScore.value == null ? 80 : 100 - securityScore.value;
  const marketRisk = structuralScore.value == null ? null : 100 - structuralScore.value;
  const manipulation = manipulationRisk(item);
  const concentration = finite(item?.details?.security?.topHolderPercent);
  const concentrationRisk = concentration == null ? null : clamp(Math.max(0, concentration - 40) * 1.6667);
  const executionStatus = item?.details?.executionSafety?.status;
  const executionRisk = executionStatus === "ACTIONABLE_RESEARCH" ? 0 : executionStatus === "REJECTED" ? 100 : 60;
  const result = average([securityRisk, marketRisk, manipulation.value, concentrationRisk, executionRisk], [25, 20, 30, 10, 15]);
  return {
    value: result.value,
    reasons: [...new Set([...manipulation.reasons, ...(result.value == null ? ["RISK_EVIDENCE_UNKNOWN"] : [])])]
  };
}

function confidenceScore(item, securityScore, marketScore, featureScore, executionScore, manipulation) {
  const security = securityScore.value == null ? 0 : 25;
  const market = marketScore.value == null ? 0 : 20;
  const featureCompleteness = finite(item?.details?.featureSnapshot?.completeness);
  const features = featureCompleteness == null ? 0 : featureCompleteness * 0.2;
  const execution = executionScore.value == null ? 0 : 20;
  const manipulationCoverage = manipulation.sampleStatus === "SUFFICIENT" ? 10 : 0;
  const freshness = item?.details?.marketQuality?.metrics?.marketDataAgeMs != null ? 5 : 0;
  let value = clamp(security + market + features + execution + manipulationCoverage + freshness);
  const caps = [];
  if (manipulation.sampleStatus !== "SUFFICIENT") {
    value = Math.min(value ?? 0, 70);
    caps.push("CAP_MANIPULATION_SAMPLE_UNKNOWN_70");
  }
  if (featureCompleteness == null || featureCompleteness < 75) {
    value = Math.min(value ?? 0, 65);
    caps.push("CAP_FEATURE_COMPLETENESS_65");
  }
  if (securityScore.value == null) {
    value = Math.min(value ?? 0, 40);
    caps.push("CAP_SECURITY_UNKNOWN_40");
  }
  return {
    value,
    caps,
    reasons: caps.length ? caps : ["EVIDENCE_COVERAGE_COMPLETE"]
  };
}

function entryQuality(item, structuralScore, chaseScore) {
  const execution = item?.details?.executionSafety?.status;
  const executionValue = execution === "ACTIONABLE_RESEARCH" ? 60 : execution === "REJECTED" ? 0 : null;
  const chaseValue = chaseScore.value == null ? null : 100 - chaseScore.value;
  const result = average([executionValue, structuralScore.value, chaseValue], [45, 35, 20]);
  return { value: result.value, reasons: result.value == null ? ["ENTRY_QUALITY_UNKNOWN"] : [] };
}

function chaseRisk(item, momentumScore) {
  const change = percent(item?.details?.pair?.priceChange?.h24 ?? item?.priceChange);
  const acceleration = finite(item?.details?.featureSnapshot?.features?.priceAcceleration);
  if (change == null && acceleration == null) return { value: null, reasons: ["CHASE_EVIDENCE_UNKNOWN"] };
  const value = Math.max(
    change == null ? 0 : change >= SCORE_CONFIG.thresholds.chasePriceChangePercent ? 85 : change >= 10 ? 60 : change >= 5 ? 35 : 15,
    acceleration == null ? 0 : acceleration >= 10 ? 80 : acceleration >= 5 ? 55 : 20
  );
  return {
    value: clamp(value),
    reasons: value >= 80 ? ["PRICE_EXTENSION_REQUIRES_REVIEW"] : momentumScore.value == null ? ["MOMENTUM_SAMPLE_PARTIAL"] : []
  };
}

function scoreRadarCandidate(item, { manipulationEvidence = null } = {}) {
  const candidate = {
    ...item,
    details: {
      ...(item?.details || {}),
      ...(manipulationEvidence ? { manipulationEvidence } : {})
    }
  };
  const securityScore = securityQuality(candidate.details.security);
  const marketScore = marketQuality(candidate);
  const momentumScore = momentumQuality(candidate);
  const flowScore = flowQuality(candidate);
  const tokenScore = tokenQuality(candidate, securityScore);
  const structuralScore = structuralFeasibility(candidate);
  const manipulation = candidate.details.manipulationEvidence
    ? candidate.details.manipulationEvidence
    : { sampleStatus: "UNKNOWN", flags: {}, qualityReasons: [] };
  const risk = riskScore(candidate, securityScore, structuralScore);
  const project = profileEvidence(candidate);
  const phase4a = evaluatePhase4A(candidate, {
    asOf: candidate.details.observedAt || candidate.details.providerMetadata?.providerUpdatedAt || null
  });
  const opportunityResult = average(
    [momentumScore.value, marketScore.value, flowScore.value, securityScore.value],
    [35, 25, 20, 20]
  );
  const chase = chaseRisk(candidate, momentumScore);
  const entry = entryQuality(candidate, structuralScore, chase);
  const confidence = confidenceScore(candidate, securityScore, marketScore, momentumScore, structuralScore, manipulation);
  const phase4aOpportunity = average(
    [
      opportunityResult.value,
      phase4a.valuation.valuationScore,
      phase4a.catalysts.catalystScore,
      phase4a.marketRegime.fitScore
    ],
    [
      PHASE4A_CONFIG.weights.phase4aOpportunity.baselineOpportunity,
      PHASE4A_CONFIG.weights.phase4aOpportunity.valuation,
      PHASE4A_CONFIG.weights.phase4aOpportunity.catalyst,
      PHASE4A_CONFIG.weights.phase4aOpportunity.marketRegimeFit
    ]
  );
  const opportunityValue = phase4aOpportunity?.value ?? opportunityResult.value;
  const riskInverse = risk.value == null ? null : 100 - risk.value;
  const radars = {
    REAL_PROJECT: average(
      [project.value, tokenScore.value, opportunityValue, riskInverse, phase4a.valuation.valuationScore, phase4a.catalysts.catalystScore, phase4a.marketRegime.fitScore],
      [25, 20, 20, 15, 10, 5, 5]
    ).value,
    REACTIVATION: average(
      [project.value, momentumScore.value, tokenScore.value, opportunityValue, confidence.value, phase4a.marketRegime.fitScore],
      [15, 25, 15, 20, 15, 10]
    ).value,
    SPECULATIVE_MEME: average(
      [momentumScore.value, flowScore.value, structuralScore.value, tokenScore.value, opportunityValue, phase4a.marketRegime.fitScore],
      [30, 18, 18, 9, 15, 10]
    ).value
  };
  const activeRadar = "SPECULATIVE_MEME";
  const activeScore = radars[activeRadar];
  const blockingFlags = SCORE_CONFIG.thresholds.blockingManipulation
    .filter(flag => candidate.details.manipulationEvidence?.flags?.[flag] === true);
  const qualifying = confidence.value != null
    && confidence.value >= SCORE_CONFIG.thresholds.confidenceForQualifying
    && risk.value != null
    && risk.value <= SCORE_CONFIG.thresholds.maximumRiskForQualifying
    && opportunityResult.value != null
    && opportunityValue >= SCORE_CONFIG.thresholds.minimumOpportunityForQualifying
    && !blockingFlags.length;
  const phase4aQualifying = !phase4a.thesis.strongContradiction;
  const finalQualifying = qualifying && phase4aQualifying;
  const warnings = [...new Set([
    ...project.warnings,
    ...securityScore.reasons,
    ...marketScore.reasons,
    ...momentumScore.reasons,
    ...flowScore.reasons,
    ...tokenScore.reasons,
    ...risk.reasons,
    ...confidence.reasons,
    ...entry.reasons,
    ...chase.reasons,
    ...phase4a.warnings,
    ...(blockingFlags.length ? blockingFlags.map(flag => `${flag.toUpperCase()}_BLOCKS_QUALIFYING`) : [])
  ])];
  const scorecard = {
    version: SCORE_VERSION,
    featureVersion: candidate.details.featureSnapshot?.featureVersion || FEATURE_VERSION,
    projectTractionVersion: candidate.details.projectTraction?.version || null,
    configurationHash: CONFIGURATION_HASH,
    phase4aVersion: PHASE4A_VERSION,
    phase4aConfigurationHash: PHASE4A_CONFIGURATION_HASH,
    sourceSet: SCORE_CONFIG.sourceSet,
    activeRadar,
    components: {
      projectQuality: project.value,
      tokenQuality: tokenScore.value,
      momentumQuality: momentumScore.value,
      marketQuality: marketScore.value,
      flowQuality: flowScore.value,
      opportunity: opportunityValue,
      baselineOpportunity: opportunityResult.value,
      valuation: phase4a.valuation.valuationScore,
      catalyst: phase4a.catalysts.catalystScore,
      marketRegimeFit: phase4a.marketRegime.fitScore,
      risk: risk.value,
      confidence: confidence.value,
      entryQuality: entry.value,
      chaseRisk: chase.value,
      structuralFeasibility: structuralScore.value
    },
    radars,
    decisionState: finalQualifying ? "QUALIFYING" : "WATCH",
    eligibility: {
      qualifying: finalQualifying,
      baselineQualifying: qualifying,
      phase4aThesisClear: phase4aQualifying,
      blockingManipulationFlags: blockingFlags,
      requiredConfidence: SCORE_CONFIG.thresholds.confidenceForQualifying,
      requiredOpportunity: SCORE_CONFIG.thresholds.minimumOpportunityForQualifying,
      maximumRisk: SCORE_CONFIG.thresholds.maximumRiskForQualifying
    },
    scoreReasons: [
      `Active ${activeRadar} score is ${activeScore == null ? "UNKNOWN" : activeScore}.`,
      `Opportunity is ${opportunityValue == null ? "UNKNOWN" : opportunityValue}; risk is ${risk.value == null ? "UNKNOWN" : risk.value}.`,
      `Entry quality is ${entry.value == null ? "UNKNOWN" : entry.value}; chase risk is ${chase.value == null ? "UNKNOWN" : chase.value}.`
    ],
    scoreWarnings: warnings,
    confidenceCaps: confidence.caps,
    phase4a: {
      version: phase4a.version,
      configurationHash: phase4a.configurationHash,
      valuation: phase4a.valuation,
      catalysts: phase4a.catalysts,
      marketRegime: phase4a.marketRegime,
      thesis: phase4a.thesis,
      governance: phase4a.governance,
      warnings: phase4a.warnings
    }
  };
  return {
    ...candidate,
    radar: activeScore == null ? null : Math.round(activeScore),
    opportunity: opportunityValue == null ? null : Math.round(opportunityValue),
    momentum: momentumScore.value == null ? null : Math.round(momentumScore.value),
    risk: risk.value == null ? null : Math.round(risk.value),
    confidence: confidence.value == null ? null : Math.round(confidence.value),
    details: { ...candidate.details, scorecard }
  };
}

module.exports = {
  SCORE_VERSION,
  FEATURE_VERSION,
  RADAR_TYPES,
  SCORE_CONFIG,
  CONFIGURATION_HASH,
  scoreRadarCandidate
};