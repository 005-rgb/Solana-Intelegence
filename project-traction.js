const TRACTION_VERSION = "phase3b-v1";
const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_DIMENSIONS = Object.freeze([
  "productReality",
  "productMaturity",
  "userAdoption",
  "userGrowth",
  "revenueOrFees",
  "tvlOrEconomicActivity",
  "developerActivity",
  "tokenUtility",
  "tokenomics",
  "ecosystemIntegration"
]);
const DIMENSION_WEIGHTS = Object.freeze({
  productReality: 15,
  productMaturity: 10,
  userAdoption: 10,
  userGrowth: 10,
  revenueOrFees: 10,
  tvlOrEconomicActivity: 10,
  developerActivity: 10,
  tokenUtility: 10,
  tokenomics: 10,
  ecosystemIntegration: 5
});
const DIMENSION_TYPES = Object.freeze({
  productReality: ["PRODUCT", "DOCUMENTATION", "SMART_CONTRACT"],
  productMaturity: ["PRODUCT", "DOCUMENTATION"],
  userAdoption: ["USERS", "PRODUCT", "PROTOCOL_ACTIVITY"],
  userGrowth: ["USERS", "PROTOCOL_ACTIVITY"],
  revenueOrFees: ["REVENUE", "FEES", "PROTOCOL_ACTIVITY"],
  tvlOrEconomicActivity: ["TVL", "ECONOMIC_ACTIVITY", "PROTOCOL_ACTIVITY"],
  developerActivity: ["GITHUB", "DEVELOPER_ACTIVITY"],
  tokenUtility: ["TOKEN_UTILITY", "PRODUCT", "DOCUMENTATION"],
  tokenomics: ["TOKENOMICS", "DOCUMENTATION", "SMART_CONTRACT"],
  ecosystemIntegration: ["INTEGRATION", "ECOSYSTEM"]
});
const CLASSIFICATIONS = new Set([
  "REAL_PROJECT",
  "PARTIALLY_VERIFIED",
  "WEAK_PROJECT",
  "MEME_OR_CONCEPT",
  "UNVERIFIED",
  "FAKE_OR_SUSPICIOUS"
]);

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

function normalizeRecord(record, asOf) {
  const sourceId = String(record?.sourceId || record?.source || "").trim();
  const sourceType = String(record?.sourceType || record?.type || "").trim().toUpperCase();
  const observedAt = asDate(record?.observedAt);
  const sourceUrl = validUrl(record?.sourceUrl || record?.url);
  const score = clamp(record?.score);
  const valid = Boolean(
    record?.verified === true
    && sourceId
    && sourceType
    && sourceUrl
    && observedAt
    && asOf
    && observedAt.getTime() <= asOf.getTime()
    && asOf.getTime() - observedAt.getTime() <= MAX_EVIDENCE_AGE_MS
    && record?.claim
    && score != null
  );
  return {
    valid,
    sourceId,
    sourceType,
    sourceUrl,
    observedAt,
    score,
    dimension: String(record?.dimension || "").trim(),
    claim: String(record?.claim || "").trim().slice(0, 500),
    metricKey: record?.metricKey ? String(record.metricKey).trim() : null,
    value: number(record?.value),
    unit: record?.unit ? String(record.unit).trim().slice(0, 40) : null,
    reason: !valid
      ? "Evidence requires verified=true, source identity, HTTP(S) URL, as-of timestamp, freshness, claim, and a bounded score."
      : null
  };
}

function normalizeSeries(series, asOf) {
  if (!Array.isArray(series)) return [];
  return series.map(point => {
    const observedAt = asDate(point?.observedAt);
    const value = number(point?.value);
    const sourceId = String(point?.sourceId || point?.source || "").trim();
    const sourceType = String(point?.sourceType || point?.type || "").trim().toUpperCase();
    const sourceUrl = validUrl(point?.sourceUrl || point?.url);
    return {
      valid: Boolean(
        point?.verified === true
        && observedAt
        && asOf
        && observedAt.getTime() <= asOf.getTime()
        && asOf.getTime() - observedAt.getTime() <= MAX_EVIDENCE_AGE_MS
        && value != null
        && sourceId
        && sourceType
        && sourceUrl
        && point?.metricKey
      ),
      metricKey: point?.metricKey ? String(point.metricKey).trim() : null,
      value,
      unit: point?.unit ? String(point.unit).trim().slice(0, 40) : null,
      sourceId,
      sourceType,
      sourceUrl,
      observedAt,
      claim: String(point?.claim || "").trim().slice(0, 300)
    };
  }).filter(point => point.valid);
}

function trend(series) {
  if (!series.length) {
    return {
      metricKey: null,
      tractionLevel: null,
      tractionGrowth: null,
      tractionAcceleration: null,
      inflectionStatus: "UNKNOWN",
      baselineWindow: 0,
      sampleQuality: "UNKNOWN"
    };
  }
  const grouped = new Map();
  for (const point of series) {
    if (!grouped.has(point.metricKey)) grouped.set(point.metricKey, []);
    grouped.get(point.metricKey).push(point);
  }
  const selected = [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0][1]
    .sort((a, b) => a.observedAt - b.observedAt);
  const latest = selected[selected.length - 1];
  const previous = selected[selected.length - 2];
  const beforePrevious = selected[selected.length - 3];
  const growth = previous && previous.value !== 0 ? ((latest.value - previous.value) / Math.abs(previous.value)) * 100 : null;
  const previousGrowth = beforePrevious && previous.value !== 0
    ? ((previous.value - beforePrevious.value) / Math.abs(beforePrevious.value)) * 100
    : null;
  const acceleration = growth != null && previousGrowth != null ? growth - previousGrowth : null;
  let inflectionStatus = "UNKNOWN";
  if (growth != null && acceleration != null) {
    if (growth > 0 && acceleration >= 10) inflectionStatus = "ACCELERATING";
    else if (growth > 0) inflectionStatus = "GROWING";
    else if (growth === 0) inflectionStatus = "STABLE";
    else inflectionStatus = "DECLINING";
  } else if (growth != null) {
    inflectionStatus = growth > 0 ? "GROWING" : growth === 0 ? "STABLE" : "DECLINING";
  }
  return {
    metricKey: latest.metricKey,
    unit: latest.unit,
    tractionLevel: latest.value,
    tractionGrowth: clamp(growth, -100, 1000),
    tractionAcceleration: clamp(acceleration, -1000, 1000),
    inflectionStatus,
    baselineWindow: selected.length,
    sampleQuality: selected.length >= 3 ? "SUFFICIENT" : "PARTIAL"
  };
}

function identityEvidence(profile = {}, providerMetadata = {}) {
  const websites = Array.isArray(profile.websites) ? profile.websites : [];
  const socials = Array.isArray(profile.socials) ? profile.socials : [];
  return {
    descriptionPresent: Boolean(profile.description || providerMetadata.description),
    websiteCount: websites.length,
    socialCount: socials.length,
    hasNameAndSymbol: Boolean(providerMetadata.name && providerMetadata.symbol)
  };
}

function deriveProjectTraction(input = {}, { asOf = new Date() } = {}) {
  const observedAt = asDate(asOf) || new Date();
  const evidenceInput = input.projectEvidence || input.tractionEvidence || {};
  const records = Array.isArray(evidenceInput.evidence) ? evidenceInput.evidence : [];
  const normalized = records.map(record => normalizeRecord(record, observedAt));
  const validEvidence = normalized.filter(record => record.valid && REQUIRED_DIMENSIONS.includes(record.dimension));
  const invalidEvidenceCount = normalized.length - validEvidence.length;
  const dimensions = {};
  const unknownDimensions = [];
  for (const dimension of REQUIRED_DIMENSIONS) {
    const allowedTypes = DIMENSION_TYPES[dimension];
    const matches = validEvidence.filter(record => record.dimension === dimension && allowedTypes.includes(record.sourceType));
    if (!matches.length) {
      dimensions[dimension] = null;
      unknownDimensions.push(dimension);
    } else {
      dimensions[dimension] = clamp(matches.reduce((sum, record) => sum + record.score, 0) / matches.length);
    }
  }
  const weighted = REQUIRED_DIMENSIONS
    .filter(dimension => dimensions[dimension] != null)
    .reduce((sum, dimension) => sum + dimensions[dimension] * DIMENSION_WEIGHTS[dimension], 0);
  const totalWeight = REQUIRED_DIMENSIONS
    .filter(dimension => dimensions[dimension] != null)
    .reduce((sum, dimension) => sum + DIMENSION_WEIGHTS[dimension], 0);
  const pqs = totalWeight ? clamp(weighted / totalWeight) : null;
  const sourceIds = [...new Set(validEvidence.map(record => record.sourceId))];
  const hasProductEvidence = ["productReality", "productMaturity"].some(dimension => dimensions[dimension] != null);
  const hasActivityEvidence = ["userAdoption", "revenueOrFees", "tvlOrEconomicActivity"].some(dimension => dimensions[dimension] != null);
  const requestedClassification = String(evidenceInput.classification || "").toUpperCase();
  let classification = CLASSIFICATIONS.has(requestedClassification) ? requestedClassification : "UNVERIFIED";
  if (!requestedClassification) {
    classification = hasProductEvidence && hasActivityEvidence && unknownDimensions.length <= 3
      ? "PARTIALLY_VERIFIED"
      : "UNVERIFIED";
  }
  if (classification === "REAL_PROJECT" && (!hasProductEvidence || !hasActivityEvidence)) classification = "PARTIALLY_VERIFIED";
  const complete = unknownDimensions.length === 0 && sourceIds.length >= 2 && classification === "REAL_PROJECT";
  const qualityCap = complete ? 100 : 70;
  const sourceSet = sourceIds.map(sourceId => {
    const source = validEvidence.find(record => record.sourceId === sourceId);
    return { sourceId, sourceType: source.sourceType, sourceUrl: source.sourceUrl };
  });
  const series = normalizeSeries(evidenceInput.tractionSeries, observedAt);
  const trendData = trend(series);
  const qualityReasons = [];
  if (!validEvidence.length) qualityReasons.push("PROJECT_TRACTION_EVIDENCE_UNKNOWN");
  if (invalidEvidenceCount) qualityReasons.push("INVALID_OR_STALE_PROJECT_EVIDENCE_EXCLUDED");
  if (unknownDimensions.length) qualityReasons.push(`UNKNOWN_PROJECT_DIMENSIONS:${unknownDimensions.join(",")}`);
  if (sourceIds.length < 2) qualityReasons.push("INDEPENDENT_SOURCE_COVERAGE_INSUFFICIENT");
  if (!hasProductEvidence) qualityReasons.push("PRODUCT_REALITY_NOT_VERIFIED");
  if (!hasActivityEvidence) qualityReasons.push("ECONOMIC_OR_USER_TRACTION_NOT_VERIFIED");
  if (!series.length) qualityReasons.push("TRACTION_SERIES_UNKNOWN");
  if (series.length && trendData.sampleQuality !== "SUFFICIENT") qualityReasons.push("TRACTION_BASELINE_SAMPLE_PARTIAL");
  if (classification === "FAKE_OR_SUSPICIOUS") qualityReasons.push("PROJECT_CLASSIFIED_FAKE_OR_SUSPICIOUS");
  return {
    version: TRACTION_VERSION,
    observedAt: observedAt.toISOString(),
    status: validEvidence.length ? (complete ? "VERIFIED" : "PARTIAL") : "UNKNOWN",
    classification,
    projectQualityScore: pqs,
    qualityCap,
    capLifted: qualityCap === 100,
    evidenceCoverage: Math.round((REQUIRED_DIMENSIONS.length - unknownDimensions.length) / REQUIRED_DIMENSIONS.length * 100),
    confidence: clamp((validEvidence.length / REQUIRED_DIMENSIONS.length) * 70 + Math.min(30, sourceIds.length * 10)),
    unknownDimensions,
    dimensions,
    identityEvidence: identityEvidence(input.profile, input.providerMetadata),
    sourceSet,
    evidenceCount: validEvidence.length,
    invalidEvidenceCount,
    traction: trendData,
    qualityReasons
  };
}

module.exports = {
  TRACTION_VERSION,
  MAX_EVIDENCE_AGE_MS,
  REQUIRED_DIMENSIONS,
  deriveProjectTraction
};