const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreRadarCandidate } = require("../radar-scoring");
const { evaluateEvidenceQuality } = require("../evidence-quality");

function candidate(overrides = {}) {
  return {
    mint: "evidence-quality-mint",
    symbol: "EQ",
    name: "Evidence Quality",
    price: "$1.00",
    priceChange: "12.00%",
    marketCap: 1_000_000,
    liquidity: 25_000,
    details: {
      profile: { description: "Product", websites: [{ url: "https://example.com" }], socials: [] },
      pair: {
        priceChange: { h24: 12 },
        volume: { h24: 50_000 },
        txns: { h24: { buys: 100, sells: 60 } },
        makers: { h24: 100 },
        liquidityUsd: 25_000,
        marketCap: 1_000_000
      },
      security: {
        verified: true,
        status: "VERIFIED",
        authorities: { mint: "RENOUNCED", freeze: "RENOUNCED" },
        topHolderPercent: 12
      },
      marketQuality: {
        status: "PASSED",
        passed: true,
        metrics: {
          estimatedEntryImpactPercent: 0.4,
          volumeLiquidityRatio: 2,
          liquidityToMarketCap: 0.025,
          poolAgeMs: 3_600_000,
          marketDataAgeMs: 60_000
        }
      },
      executionSafety: { status: "ACTIONABLE_RESEARCH" },
      featureSnapshot: {
        status: "COMPLETE",
        completeness: 100,
        features: { priceAcceleration: 4, volumeAcceleration: 1.5, makerGrowth: 10, buySellImbalance: 0.25 }
      }
    },
    ...overrides
  };
}

test("complete required evidence is allowed to qualify", () => {
  const result = scoreRadarCandidate(candidate(), {
    manipulationEvidence: { sampleStatus: "SUFFICIENT", flags: {} }
  });
  assert.equal(result.details.scorecard.evidenceQuality.verified, true);
  assert.equal(result.details.scorecard.evidenceQuality.qualifyingAllowed, true);
  assert.equal(result.details.scorecard.evidenceQuality.domains.manipulation.status, "VERIFIED");
});

test("partial feature evidence blocks qualification instead of silently passing", () => {
  const result = scoreRadarCandidate(candidate({
    details: {
      ...candidate().details,
      featureSnapshot: {
        ...candidate().details.featureSnapshot,
        completeness: 50,
        status: "PARTIAL"
      }
    }
  }), {
    manipulationEvidence: { sampleStatus: "SUFFICIENT", flags: {} }
  });
  assert.equal(result.details.scorecard.evidenceQuality.qualifyingAllowed, false);
  assert.ok(result.details.scorecard.evidenceQuality.reasons.includes("MOMENTUM_EVIDENCE_PARTIAL"));
  assert.equal(result.details.scorecard.eligibility.qualifying, false);
});

test("active radar follows explicit project classification", () => {
  const realProject = candidate({
    details: {
      ...candidate().details,
      projectTraction: {
        version: "project-traction-v1",
        classification: "REAL_PROJECT",
        status: "VERIFIED",
        capLifted: true,
        sourceSet: ["official", "independent"]
      }
    }
  });
  const result = scoreRadarCandidate(realProject, {
    manipulationEvidence: { sampleStatus: "SUFFICIENT", flags: {} }
  });
  assert.equal(result.details.scorecard.activeRadar, "REAL_PROJECT");
  assert.equal(result.radar, Math.round(result.details.scorecard.radars.REAL_PROJECT));
});

test("active radar follows each supported classification without changing the other radar scores", () => {
  for (const classification of ["REAL_PROJECT", "REACTIVATION", "SPECULATIVE_MEME"]) {
    const result = scoreRadarCandidate(candidate({
      details: {
        ...candidate().details,
        projectTraction: {
          version: "phase3b-v1",
          classification,
          status: classification === "REAL_PROJECT" ? "VERIFIED" : "PARTIAL",
          capLifted: classification === "REAL_PROJECT",
          sourceSet: ["official", "independent"]
        }
      }
    }), {
      manipulationEvidence: { sampleStatus: "SUFFICIENT", flags: {} }
    });
    assert.equal(result.details.scorecard.activeRadar, classification);
    assert.equal(result.radar, Math.round(result.details.scorecard.radars[classification]));
    for (const radar of ["REAL_PROJECT", "REACTIVATION", "SPECULATIVE_MEME"]) {
      assert.notEqual(result.details.scorecard.radars[radar], undefined);
    }
  }
});

test("unverified classification does not activate a project radar", () => {
  const result = scoreRadarCandidate(candidate({
    details: {
      ...candidate().details,
      projectTraction: {
        version: "phase3b-v1",
        classification: "UNVERIFIED",
        status: "UNKNOWN",
        capLifted: false,
        sourceSet: []
      }
    }
  }));
  assert.equal(result.details.scorecard.activeRadar, null);
  assert.equal(result.radar, null);
  assert.equal(result.details.scorecard.eligibility.qualifying, false);
});

test("future as-of evidence is rejected by the evidence gate", () => {
  const result = evaluateEvidenceQuality(candidate({
    details: { ...candidate().details, observedAt: "2030-01-01T00:00:00.000Z" }
  }), { decisionTime: Date.parse("2029-01-01T00:00:00.000Z") });
  assert.equal(result.futureEvidence, true);
  assert.equal(result.qualifyingAllowed, false);
  assert.ok(result.reasons.includes("EVIDENCE_AS_OF_AFTER_DECISION_TIME"));
});