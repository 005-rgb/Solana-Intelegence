"use strict";

const SYNTHETIC_MINT_PREFIX = "synthetic-mint-";

function syntheticToken(index) {
  const id = String(index + 1).padStart(4, "0");
  return {
    tokenAddress: `${SYNTHETIC_MINT_PREFIX}${id}`,
    chainId: "solana",
    symbol: `SYN${id}`,
    name: `Synthetic Token ${id}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "m0-fixture",
    confidence: "UNKNOWN"
  };
}

function buildBaselineFixture(size = 10) {
  const allowedSizes = new Set([10, 100, 1000]);
  if (!allowedSizes.has(size)) throw new Error("Baseline fixture size must be 10, 100, or 1000.");
  const tokens = Array.from({ length: size }, (_, index) => syntheticToken(index));
  return {
    fixtureVersion: "m0-baseline-v1",
    network: "none",
    tokens,
    watchlist: Array.from({ length: Math.min(100, size) }, (_, index) => tokens[index].tokenAddress),
    providerResponses: {
      rateLimited: {
        status: 429,
        headers: { "retry-after": "2" },
        body: { error: "synthetic_rate_limit" }
      },
      timeout: { errorCode: "TIMEOUT", body: null },
      malformed: { status: 200, body: { unexpected: true } }
    }
  };
}

function buildBaselineFixtures() {
  return {
    sizes: [10, 100, 1000].map(size => buildBaselineFixture(size)),
    failureModes: buildBaselineFixture(10).providerResponses
  };
}

module.exports = { buildBaselineFixture, buildBaselineFixtures };