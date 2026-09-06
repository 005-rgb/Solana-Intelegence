const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONFIGURATION_HASH,
  SCORE_VERSION,
  scoreRadarCandidate
} = require("../radar-scoring");

function candidate(overrides = {}) {
  return {
    mint: "score-mint",
    symbol: "SCORE",
    name: "Score Token",
    price: "$1.00",
    priceChange: "12.00%",
    marketCap: 1_000_000,
    liquidity: 25_000,
    details: {
      profile: { description: "A real product", websites: [{ url: "https://example.com" }], socials: [{ url: "https://x.com/example" }] },
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
        featureVersion: "phase3-v1",
        status: "COMPLETE",
        completeness: 100,
        features: {
          priceAcceleration: 4,
          volumeAcceleration: 1.5,
          makerGrowth: 10,
          buySellImbalance: 0.25
        }
      }
    },
    ...overrides
  };
}

test("Phase 4 produces deterministic versioned scores with configuration lineage", () => {
  const first = scoreRadarCandidate(candidate(), {
    manipulationEvidence: { sampleStatus: "SUFFICIENT", flags: {} }
  });
  const second = scoreRadarCandidate(candidate(), {
    manipulationEvidence: { sampleStatus: "SUFFICIENT", flags: {} }
  });
  assert.deepEqual(first.details.scorecard, second.details.scorecard);
  assert.equal(first.details.scorecard.version, SCORE_VERSION);
  assert.equal(first.details.scorecard.configurationHash, CONFIGURATION_HASH);
  assert.equal(first.details.scorecard.activeRadar, "SPECULATIVE_MEME");
  assert.equal(first.radar, Math.round(first.details.scorecard.radars.SPECULATIVE_MEME));
  assert.ok(first.confidence >= 60);
  assert.ok(first.details.scorecard.scoreWarnings.includes("PROJECT_TRACTION_NOT_IMPLEMENTED_PHASE3B"));
});

test("unknown Phase 3A coverage caps confidence and does not become a clear manipulation pass", () => {
  const result = scoreRadarCandidate(candidate());
  assert.ok(result.confidence <= 70);
  assert.ok(result.details.scorecard.confidenceCaps.includes("CAP_MANIPULATION_SAMPLE_UNKNOWN_70"));
  assert.ok(result.details.scorecard.scoreWarnings.includes("MANIPULATION_EVIDENCE_NOT_AVAILABLE"));
  assert.equal(result.details.scorecard.eligibility.blockingManipulationFlags.length, 0);
});

test("blocking manipulation flags prevent qualifying without changing the market gate", () => {
  const result = scoreRadarCandidate(candidate(), {
    manipulationEvidence: {
      sampleStatus: "SUFFICIENT",
      flags: { coordinatedActivity: true, poolDrain: false }
    }
  });
  assert.equal(result.details.scorecard.decisionState, "WATCH");
  assert.equal(result.details.scorecard.eligibility.qualifying, false);
  assert.deepEqual(result.details.scorecard.eligibility.blockingManipulationFlags, ["coordinatedActivity"]);
  assert.ok(result.details.scorecard.scoreWarnings.includes("COORDINATEDACTIVITY_FLAGGED"));
});