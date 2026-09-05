const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACCOUNT_CLASSES,
  buildAccountTaxonomy,
  FILTER_CONFIG,
  dedupeMintEntries,
  dedupePairs,
  evaluateBaselineCandidate,
  normalizeDiscoveryUniverse,
  selectBoardTokens,
  selectPrimaryPair,
  summarizeBaselineCandidates
  , validateProviderFeed
  , validateProviderPair
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
    { chainId: "solana", pairAddress: "z", priceUsd: "1", liquidity: { usd: 1000 }, pairCreatedAt: 2 },
    { chainId: "solana", pairAddress: "a", priceUsd: "1", liquidity: { usd: 1000 }, pairCreatedAt: 2 },
    { chainId: "solana", pairAddress: "newer", priceUsd: "1", liquidity: { usd: 1000 }, pairCreatedAt: 3 },
    { chainId: "ethereum", pairAddress: "largest", priceUsd: "1", liquidity: { usd: 999999 }, pairCreatedAt: 4 }
  ]);
  assert.equal(pair.pairAddress, "newer");
  assert.equal(selectPrimaryPair([
    { chainId: "solana", pairAddress: "z", priceUsd: "1", liquidity: { usd: 1000 }, pairCreatedAt: 2 },
    { chainId: "solana", pairAddress: "a", priceUsd: "1", liquidity: { usd: 1000 }, pairCreatedAt: 2 }
  ]).pairAddress, "a");
});

test("phase 1 discovery merges sources, preserves watchlist priority, and records overlap", () => {
  const discovery = normalizeDiscoveryUniverse({
    boostEntries: [
      { tokenAddress: "boost-only", chainId: "solana" },
      { tokenAddress: "shared", chainId: "solana" }
    ],
    profileEntries: [
      { tokenAddress: "profile-only", chainId: "solana" },
      { tokenAddress: "shared", chainId: "solana" }
    ],
    watchlistMints: ["watch-only", "shared"],
    limit: 10
  });
  assert.deepEqual(discovery.entries.map(entry => entry.tokenAddress), ["shared", "watch-only", "profile-only", "boost-only"]);
  assert.deepEqual(discovery.entries[0].sources, ["boost_feed", "new_pair_feed", "watchlist"]);
  assert.equal(discovery.sourceMetrics.unique_mints_before_dedup, 4);
  assert.equal(discovery.sourceMetrics.unique_mints_after_dedup, 4);
  assert.equal(discovery.sourceMetrics.source_overlap["boost_feed+new_pair_feed"], 1);
  assert.equal(discovery.sourceMetrics.source_only_candidates.watchlist, 1);
});

test("phase 1 pair observations are deduplicated without dropping other valid pairs", () => {
  const pairs = dedupePairs([
    { chainId: "solana", pairAddress: "pair-b", priceUsd: "1", liquidity: { usd: 1000 } },
    { chainId: "solana", pairAddress: "pair-b", priceUsd: "1", liquidity: { usd: 2000 } },
    { chainId: "solana", pairAddress: "pair-a", priceUsd: "1", liquidity: { usd: 3000 } },
    { chainId: "ethereum", pairAddress: "pair-eth", priceUsd: "1", liquidity: { usd: 999999 } }
  ]);
  assert.deepEqual(pairs.map(pair => pair.pairAddress), ["pair-b", "pair-a"]);
  assert.equal(selectPrimaryPair(pairs).pairAddress, "pair-a");
});

test("partial candidate data remains unresolved and cannot reconcile as accepted", () => {
  const report = summarizeBaselineCandidates([
    verifiedItem({
      security: {
        verified: false,
        status: "UNVERIFIED",
        authorities: { mint: "UNKNOWN", freeze: "UNKNOWN" },
        topHolderPercent: null,
        supply: null
      }
    }),
    verifiedItem({ liquidity: null })
  ]);
  assert.equal(report.accepted, 0);
  assert.equal(report.unresolved, 2);
  assert.equal(report.rejected, 0);
  assert.equal(report.recordsChecked, 2);
  assert.equal(report.recordsChecked, report.accepted + report.rejected + report.unresolved);
  assert.deepEqual(report.reasons.map(reason => reason.code), ["LIQUIDITY_UNKNOWN", "SECURITY_UNKNOWN"]);
});

test("unresolved token account is never presented as wallet ownership", () => {
  const taxonomy = buildAccountTaxonomy([
    { rank: 1, address: "account-1", amount: "600", percent: 60 }
  ]);
  assert.equal(taxonomy.status, "ACCOUNT_CONCENTRATION_ONLY");
  assert.equal(taxonomy.accounts[0].accountClass, ACCOUNT_CLASSES.UNKNOWN_ACCOUNT);
  assert.equal(taxonomy.concentration.top_1_account_percent, 60);
  assert.equal(taxonomy.concentration.top_1_wallet_percent, null);
});

test("pool as largest account is classified and excluded from wallet concentration", () => {
  const taxonomy = buildAccountTaxonomy([
    { rank: 1, address: "base-vault", amount: "600", percent: 60 },
    { rank: 2, address: "wallet-account", amount: "200", percent: 20 }
  ], {
    poolEvidence: {
      poolAddress: "amm-pool",
      baseVault: "base-vault",
      quoteVault: "quote-vault",
      poolProgramId: "amm-program",
      ammType: "test-amm",
      source: "fixture"
    },
    accountInfoByAddress: {
      "wallet-account": {
        result: {
          value: {
            data: {
              parsed: { info: { owner: "wallet-owner" } }
            }
          }
        }
      }
    },
    ownerInfoByAddress: {
      "wallet-owner": { result: { value: { owner: "11111111111111111111111111111111", executable: false } } }
    }
  });
  assert.equal(taxonomy.status, "CLASSIFIED_PARTIAL");
  assert.equal(taxonomy.accounts[0].accountClass, ACCOUNT_CLASSES.POOL_VAULT);
  assert.equal(taxonomy.accounts[1].accountClass, ACCOUNT_CLASSES.UNKNOWN_ACCOUNT);
  assert.equal(taxonomy.concentration.top_1_account_percent, 60);
  assert.equal(taxonomy.concentration.top_1_wallet_percent, null);
  assert.equal(taxonomy.concentration.pool_adjusted_top_1_wallet_percent, null);
  assert.equal(taxonomy.concentration.pool_accounts_observed, 1);
});

test("executable resolved owners remain program-owned, not wallets", () => {
  const taxonomy = buildAccountTaxonomy([
    { rank: 1, address: "program-token-account", amount: "500", percent: 50 }
  ], {
    accountInfoByAddress: {
      "program-token-account": {
        result: {
          value: {
            data: {
              parsed: { info: { owner: "program-owner" } }
            }
          }
        }
      }
    },
    ownerInfoByAddress: {
      "program-owner": { result: { value: { executable: true, owner: "program" } } }
    }
  });
  assert.equal(taxonomy.accounts[0].accountClass, ACCOUNT_CLASSES.PROGRAM_OWNED);
  assert.equal(taxonomy.concentration.top_1_wallet_percent, null);
});

test("system-owned non-executable owner remains unknown without wallet evidence", () => {
  const taxonomy = buildAccountTaxonomy([
    { rank: 1, address: "possible-pda", amount: "500", percent: 50 }
  ], {
    accountInfoByAddress: {
      "possible-pda": {
        result: { value: { data: { parsed: { info: { owner: "system-owner" } } } } }
      }
    },
    ownerInfoByAddress: {
      "system-owner": { result: { value: { owner: "11111111111111111111111111111111", executable: false } } }
    }
  });
  assert.equal(taxonomy.accounts[0].accountClass, ACCOUNT_CLASSES.UNKNOWN_ACCOUNT);
  assert.equal(taxonomy.concentration.top_1_wallet_percent, null);
});

test("provider feed validation rejects malformed records and future timestamps", () => {
  const now = Date.parse("2026-09-05T00:00:00.000Z");
  const result = validateProviderFeed([
    { tokenAddress: "valid", chainId: "solana", updatedAt: now - 1000, amount: "2" },
    { tokenAddress: "bad-number", chainId: "solana", amount: -1 },
    { tokenAddress: "future", chainId: "solana", updatedAt: now + 10 * 60 * 1000 },
    { tokenAddress: "wrong-chain", chainId: "ethereum" }
  ], { now });
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 2);
  assert.equal(result.invalidRecords, 2);
  assert.ok(result.errors.includes("boost_amount_invalid"));
  assert.ok(result.errors.includes("updated_at_invalid_or_out_of_bounds"));
  assert.equal(validateProviderFeed({ data: [] }, { now }).ok, false);
});

test("provider pair validation preserves missing values as null but rejects unsafe values", () => {
  const now = Date.parse("2026-09-05T00:00:00.000Z");
  const valid = validateProviderPair({ chainId: "solana", pairAddress: "pair-1", priceUsd: null, liquidity: null }, { now });
  assert.equal(valid.valid, true);
  assert.equal(valid.pair.priceUsd, null);
  assert.equal(validateProviderPair({ chainId: "solana", pairAddress: "pair-2", priceUsd: "-1" }, { now }).valid, false);
  assert.equal(validateProviderPair({
    chainId: "solana",
    pairAddress: "pair-3",
    priceUsd: "1",
    pairCreatedAt: now + 10 * 60 * 1000
  }, { now }).valid, false);
});