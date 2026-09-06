const test = require("node:test");
const assert = require("node:assert/strict");
const { TRACTION_VERSION, deriveProjectTraction } = require("../project-traction");

const urlFor = source => `https://${source.toLowerCase()}.example.com/evidence`;
const dimensions = [
  ["productReality", "PRODUCT", 88],
  ["productMaturity", "DOCUMENTATION", 80],
  ["userAdoption", "USERS", 75],
  ["userGrowth", "USERS", 82],
  ["revenueOrFees", "FEES", 70],
  ["tvlOrEconomicActivity", "PROTOCOL_ACTIVITY", 78],
  ["developerActivity", "GITHUB", 85],
  ["tokenUtility", "TOKEN_UTILITY", 72],
  ["tokenomics", "TOKENOMICS", 74],
  ["ecosystemIntegration", "INTEGRATION", 68]
];

function evidence(asOf, overrides = {}) {
  return dimensions.map(([dimension, sourceType, score], index) => ({
    dimension,
    sourceType,
    sourceId: index % 2 ? "github" : "project-docs",
    sourceUrl: urlFor(index % 2 ? "github" : "project-docs"),
    observedAt: new Date(asOf.getTime() - 60 * 60 * 1000).toISOString(),
    verified: true,
    score,
    claim: `${dimension} is supported by an auditable source.`,
    ...overrides
  }));
}

test("missing project evidence remains unknown and keeps the quality cap", () => {
  const result = deriveProjectTraction({ profile: { websites: [{ url: urlFor("profile") }] } }, { asOf: new Date("2026-09-06T00:00:00Z") });
  assert.equal(result.version, TRACTION_VERSION);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.classification, "UNVERIFIED");
  assert.equal(result.projectQualityScore, null);
  assert.equal(result.qualityCap, 70);
  assert.equal(result.capLifted, false);
  assert.ok(result.qualityReasons.includes("PROJECT_TRACTION_EVIDENCE_UNKNOWN"));
});

test("complete fresh multi-source evidence lifts the project quality cap and derives inflection", () => {
  const asOf = new Date("2026-09-06T00:00:00Z");
  const result = deriveProjectTraction({
    profile: { description: "Product", websites: [{ url: urlFor("profile") }] },
    providerMetadata: { name: "Real", symbol: "REAL" },
    projectEvidence: {
      classification: "REAL_PROJECT",
      evidence: evidence(asOf),
      tractionSeries: [
        { metricKey: "active_users", value: 10000, unit: "users", sourceId: "analytics", sourceType: "USERS", sourceUrl: urlFor("analytics"), observedAt: "2026-09-04T00:00:00Z", verified: true },
        { metricKey: "active_users", value: 12000, unit: "users", sourceId: "analytics", sourceType: "USERS", sourceUrl: urlFor("analytics"), observedAt: "2026-09-05T00:00:00Z", verified: true },
        { metricKey: "active_users", value: 18000, unit: "users", sourceId: "analytics", sourceType: "USERS", sourceUrl: urlFor("analytics"), observedAt: "2026-09-06T00:00:00Z", verified: true }
      ]
    }
  }, { asOf });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.classification, "REAL_PROJECT");
  assert.equal(result.qualityCap, 100);
  assert.equal(result.capLifted, true);
  assert.equal(result.evidenceCoverage, 100);
  assert.equal(result.traction.sampleQuality, "SUFFICIENT");
  assert.equal(result.traction.inflectionStatus, "ACCELERATING");
  assert.ok(result.projectQualityScore > 70);
});

test("stale or future evidence cannot lift the cap", () => {
  const asOf = new Date("2026-09-06T00:00:00Z");
  const stale = evidence(asOf).map(record => ({ ...record, observedAt: "2026-08-01T00:00:00Z" }));
  const future = evidence(asOf).map(record => ({ ...record, observedAt: "2026-09-07T00:00:00Z" }));
  for (const records of [stale, future]) {
    const result = deriveProjectTraction({
      projectEvidence: { classification: "REAL_PROJECT", evidence: records }
    }, { asOf });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.qualityCap, 70);
    assert.equal(result.capLifted, false);
    assert.ok(result.qualityReasons.includes("INVALID_OR_STALE_PROJECT_EVIDENCE_EXCLUDED"));
  }
});