const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PHASE4A_VERSION,
  PHASE4A_CONFIGURATION_HASH,
  evaluatePhase4A,
  GOVERNANCE_VERSION,
  GOVERNANCE_CONFIGURATION_HASH,
  calculateDrift,
  evaluatePromotionGate,
  buildCalibrationGovernance
} = require("../phase4a");

const AS_OF = "2026-09-06T00:00:00.000Z";

function evidence(sourceId, score = 70) {
  return {
    sourceId,
    sourceType: "RESEARCH",
    sourceUrl: `https://${sourceId}.example/evidence`,
    verified: true,
    observedAt: "2026-09-05T00:00:00.000Z",
    score
  };
}

function candidate(overrides = {}) {
  return {
    mint: "phase4a-mint",
    marketCap: 100_000,
    details: {
      pair: { marketCap: 100_000 },
      valuationEvidence: {
        sector: "infra",
        stage: "emerging",
        comparables: [
          { ...evidence("alpha"), marketCap: 500_000, sector: "infra", stage: "emerging" },
          { ...evidence("beta"), marketCap: 400_000, sector: "infra", stage: "emerging" }
        ]
      },
      catalystEvidence: [{
        ...evidence("roadmap"),
        type: "PRODUCT_LAUNCH",
        title: "Mainnet launch",
        status: "VERIFIED",
        expectedAt: "2026-09-20T00:00:00.000Z",
        marketAwareness: 20,
        pricingStatus: "NOT_PRICED"
      }],
      marketRegime: {
        ...evidence("regime"),
        state: "RISK_ON",
        confidence: 80,
        fitScore: 75
      }
    },
    ...overrides
  };
}

test("Phase 4A preserves versioned lineage and computes only fresh verified evidence", () => {
  const result = evaluatePhase4A(candidate(), { asOf: AS_OF });
  assert.equal(result.version, PHASE4A_VERSION);
  assert.equal(result.configurationHash, PHASE4A_CONFIGURATION_HASH);
  assert.equal(result.valuation.comparableCoverage, 2);
  assert.ok(result.valuation.valuationAsymmetry > 70);
  assert.equal(result.catalysts.verifiedCount, 1);
  assert.equal(result.marketRegime.state, "RISK_ON");
  assert.equal(result.thesis.state, "VALIDATING");
  assert.ok(result.thesis.positiveEvidence.some(item => item.code === "VALUATION_ASYMMETRY"));
});

test("missing Phase 4A sources remain unknown and do not become positive scores", () => {
  const result = evaluatePhase4A({ mint: "unknown", details: { pair: { marketCap: 100_000 } } }, { asOf: AS_OF });
  assert.equal(result.valuation.valuationScore, null);
  assert.equal(result.catalysts.catalystScore, null);
  assert.equal(result.marketRegime.fitScore, null);
  assert.ok(result.warnings.includes("COMPARABLE_COVERAGE_INSUFFICIENT"));
  assert.ok(result.warnings.includes("VERIFIED_CATALYST_UNKNOWN"));
  assert.ok(result.warnings.includes("MARKET_REGIME_UNKNOWN"));
  assert.equal(result.thesis.state, "NO_SIGNAL");
});

test("strong explicit contradiction produces a thesis conflict", () => {
  const result = evaluatePhase4A(candidate({
    details: {
      thesis: {
        contradictions: [{ code: "THESIS_CONFLICT", text: "Verified disclosure contradicts the launch claim." }],
        contradictionSeverity: 90
      }
    }
  }), { asOf: AS_OF });
  assert.equal(result.thesis.state, "THESIS_CONFLICT");
  assert.equal(result.thesis.strongContradiction, true);
  assert.ok(result.warnings.includes("THESIS_CONFLICT"));
});

test("stale comparable and fully priced catalyst are excluded or penalized", () => {
  const result = evaluatePhase4A(candidate({
    details: {
      valuationEvidence: {
        comparables: [{ ...evidence("old"), marketCap: 900_000, observedAt: "2026-01-01T00:00:00.000Z" }]
      },
      catalystEvidence: [{
        ...evidence("priced"),
        status: "CONFIRMED",
        expectedAt: "2026-09-20T00:00:00.000Z",
        pricingStatus: "FULLY_PRICED"
      }]
    }
  }), { asOf: AS_OF });
  assert.equal(result.valuation.valuationScore, null);
  assert.ok(result.valuation.unknowns.includes("INVALID_OR_STALE_COMPARABLES_EXCLUDED"));
  assert.ok(result.catalysts.catalystScore < 60);
});

test("Phase 4A governance keeps the challenger in shadow and exposes drift", () => {
  const governance = buildCalibrationGovernance({
    currentMetrics: { confidence: 62, missingness: null },
    referenceMetrics: { confidence: 60, missingness: 0 }
  });
  assert.equal(governance.version, GOVERNANCE_VERSION);
  assert.equal(governance.configurationHash, GOVERNANCE_CONFIGURATION_HASH);
  assert.equal(governance.mode, "SHADOW");
  assert.equal(governance.champion.userVisible, true);
  assert.equal(governance.challenger.userVisible, false);
  assert.equal(governance.challenger.affectsAlerts, false);
  assert.equal(governance.promotion.status, "HOLDOUT_REQUIRED");
  assert.ok(governance.promotion.failedChecks.includes("TEMPORAL_HOLDOUT"));
  assert.equal(governance.drift.scoreDeltas.confidence, 2);
  assert.equal(governance.drift.featureMissingness.missingness, 1);
});

test("promotion requires a temporal holdout and every safety guardrail", () => {
  const blocked = evaluatePromotionGate({
    holdoutSampleSize: 99,
    precisionLift: 0.1,
    maximumAdverseExcursionChange: 0,
    latencyIncreasePercent: 5,
    securityNotWeaker: true,
    completenessNotWorse: true,
    explainableReasons: true,
    temporalHoldoutValidated: true
  });
  assert.equal(blocked.eligible, false);
  assert.ok(blocked.failedChecks.includes("TEMPORAL_HOLDOUT"));

  const eligible = evaluatePromotionGate({
    holdoutSampleSize: 100,
    precisionLift: 0.1,
    maximumAdverseExcursionChange: -0.01,
    latencyIncreasePercent: 5,
    securityNotWeaker: true,
    completenessNotWorse: true,
    explainableReasons: true,
    temporalHoldoutValidated: true,
    modelGuardian: {
      leakageChecked: true,
      overfittingChecked: true,
      sampleSizeSufficient: true,
      outOfSampleValidated: true,
      regimeRobust: true,
      adversarialRobust: true,
      calibrationValidated: true,
      degradationWithinGuardrail: true
    }
  });
  assert.equal(eligible.status, "ELIGIBLE_PENDING_APPROVAL");
  assert.equal(eligible.eligible, true);
});

test("model guardian is fail-closed when any validation dimension is missing", () => {
  const blocked = evaluatePromotionGate({
    holdoutSampleSize: 100,
    precisionLift: 0.1,
    maximumAdverseExcursionChange: 0,
    latencyIncreasePercent: 5,
    securityNotWeaker: true,
    completenessNotWorse: true,
    explainableReasons: true,
    temporalHoldoutValidated: true,
    modelGuardian: {
      leakageChecked: true,
      overfittingChecked: true,
      sampleSizeSufficient: true,
      outOfSampleValidated: true,
      regimeRobust: true,
      adversarialRobust: true,
      calibrationValidated: true
    }
  });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.modelGuardian.status, "REJECT_MODEL");
  assert.ok(blocked.failedChecks.includes("MODEL_GUARDIAN"));
  assert.ok(blocked.modelGuardian.failedChecks.includes("DEGRADATION_REVIEW"));
});