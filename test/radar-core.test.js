const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FILTER_CONFIG,
  dedupeMintEntries,
  evaluateBaselineCandidate,
  selectBoardTokens,
  selectPrimaryPair,
  summarizeBaselineCandidates
} = require("../radar-core");

function verifiedItem(overrides = {}) {
  return {
    price: "$1.00",
    liquidity: 25_000,
    priceChange: "5.00%",
    details: { providerMetadata: { cto: false } },
    security: {
      verified: true,
      status: "VERIFIED",
      authorities: { mint: "RENOUNCED", freeze: "RENOUNCED" },
      topHolderPercent: 12,
      supply: "1000"
    },
    ...overrides
  };
}

test("unknown security fails closed", () => {
  const decision = evaluateBaselineCandidate(verifiedItem({
    security: { verified: false, status: "UNVERIFIED", authorities: { mint: "UNKNOWN", freeze: "UNKNOWN" }, topHolderPercent: null, supply: null }
  }));
  assert.equal(decision.accepted, false);
  assert.equal(decision.outcome, "UNRESOLVED");
  assert.deepEqual(decision.reasonCodes, ["SECURITY_UNKNOWN"]);
});

test("missing liquidity is unknown, never zero", () => {
  const decision = evaluateBaselineCandidate(verifiedItem({ liquidity: null }));
  assert.equal(decision.accepted, false);
  assert.equal(decision.outcome, "UNRESOLVED");
  assert.ok(decision.reasonCodes.includes("LIQUIDITY_UNKNOWN"));
  assert.ok(!decision.reasonCodes.includes("LIQUIDITY_BELOW_MINIMUM"));
});

test("checked, accepted, rejected, and unresolved counts reconcile", () => {
  const candidates = [
    verifiedItem(),
    verifiedItem({ liquidity: 100 }),
    verifiedItem({ priceChange: "-1.00%" }),
    verifiedItem({ price: "UNKNOWN" }),
    verifiedItem({ details: { providerMetadata: { cto: true } } })
  ];
  const report = summarizeBaselineCandidates(candidates, { providerRecords: 7, discoveryUniverseSize: 5 });
  assert.equal(report.recordsChecked, 5);
  assert.equal(report.accepted + report.rejected + report.unresolved, report.recordsChecked);
  assert.equal(report.accepted, 1);
  assert.equal(report.rejected, 3);
  assert.equal(report.unresolved, 1);
  assert.equal(report.filterConfig.version, "baseline-v1");
  assert.equal(FILTER_CONFIG.version, "baseline-v1");
});

test("failed or empty scan preserves the last known good board", () => {
  const previous = [{ mint: "known-good" }];
  assert.deepEqual(selectBoardTokens(previous, []), previous);
  assert.deepEqual(selectBoardTokens(previous, null), previous);
  assert.deepEqual(selectBoardTokens(previous, [{ mint: "new-good" }]), [{ mint: "new-good" }]);
});

test("duplicate mints and pairs resolve deterministically", () => {
  const entries = dedupeMintEntries([
    { tokenAddress: "B" },
    { tokenAddress: "A" },
    { tokenAddress: "B" },
    { tokenAddress: "C" }
  ], 10);
  assert.deepEqual(entries.map(item => item.tokenAddress), ["B", "A", "C"]);

  const pair = selectPrimaryPair([
    { chainId: "solana", pairAddress: "z", liquidity: { usd: 1000 }, pairCreatedAt: 2 },
    { chainId: "solana", pairAddress: "a", liquidity: { usd: 1000 }, pairCreatedAt: 2 },
    { chainId: "solana", pairAddress: "newer", liquidity: { usd: 1000 }, pairCreatedAt: 3 },
    { chainId: "ethereum", pairAddress: "largest", liquidity: { usd: 999999 }, pairCreatedAt: 4 }
  ]);
  assert.equal(pair.pairAddress, "newer");
  assert.equal(selectPrimaryPair([
    { chainId: "solana", pairAddress: "z", liquidity: { usd: 1000 }, pairCreatedAt: 2 },
    { chainId: "solana", pairAddress: "a", liquidity: { usd: 1000 }, pairCreatedAt: 2 }
  ]).pairAddress, "a");
});