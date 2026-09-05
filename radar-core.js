const BASELINE_DECISION_VERSION = "baseline-v1";
const MAX_TOP_HOLDER_PERCENT = 80;
const MIN_LIQUIDITY_USD = 10_000;
const TAXONOMY_VERSION = "taxonomy-v1";

const ACCOUNT_CLASSES = Object.freeze({
  EOA_OR_WALLET: "EOA_OR_WALLET",
  ASSOCIATED_TOKEN_ACCOUNT: "ASSOCIATED_TOKEN_ACCOUNT",
  AMM_POOL: "AMM_POOL",
  POOL_VAULT: "POOL_VAULT",
  PROGRAM_OWNED: "PROGRAM_OWNED",
  ESCROW_OR_LOCK: "ESCROW_OR_LOCK",
  TREASURY: "TREASURY",
  UNKNOWN_ACCOUNT: "UNKNOWN_ACCOUNT"
});

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbCqRbMqDqYj3aKf6gQf1Q2r7",
  "TokenzQdBNbLqP5VEhdkYJ6Y1W3qL6u3x9a6J6wGv5"
]);

const FILTER_CONFIG = Object.freeze({
  version: BASELINE_DECISION_VERSION,
  mintAuthority: "RENOUNCED",
  freezeAuthority: "RENOUNCED",
  largestHolderMaximum: `${MAX_TOP_HOLDER_PERCENT}%`,
  minimumLiquidityUsd: MIN_LIQUIDITY_USD,
  positive24hChange: true,
  ctoFlag: false
});

const REASON_LABELS = Object.freeze({
  SECURITY_UNKNOWN: "Security verification unavailable or stale.",
  MINT_AUTHORITY_ACTIVE: "Mint authority is still active.",
  FREEZE_AUTHORITY_ACTIVE: "Freeze authority is still active.",
  SECURITY_DATA_INCOMPLETE: "Security response is incomplete.",
  TOP_HOLDER_ABOVE_LIMIT: `Largest holder exceeds ${MAX_TOP_HOLDER_PERCENT}% of supply.`,
  SECURITY_REJECTED: "Security verification rejected the candidate.",
  PRICE_UNKNOWN: "Provider price is unavailable.",
  LIQUIDITY_UNKNOWN: "Provider liquidity is unavailable.",
  LIQUIDITY_BELOW_MINIMUM: `Liquidity is below $${MIN_LIQUIDITY_USD.toLocaleString("en-US")}.`,
  PRICE_CHANGE_UNKNOWN: "Provider 24h change is unavailable.",
  PRICE_CHANGE_NOT_POSITIVE: "Provider 24h change is not positive.",
  CTO_FLAG: "Provider marked the token as CTO."
});

function numeric(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedAddressSet(values) {
  return new Set((Array.isArray(values) ? values : [values])
    .map(value => String(value || "").trim())
    .filter(Boolean));
}

function normalizePoolEvidence(input = {}) {
  const evidence = input && typeof input === "object" ? input : {};
  const addresses = value => [...normalizedAddressSet(value)];
  return {
    taxonomyVersion: TAXONOMY_VERSION,
    poolAddress: evidence.poolAddress || evidence.address || null,
    poolProgramId: evidence.poolProgramId || evidence.programId || null,
    ammType: evidence.ammType || evidence.dexId || null,
    ammVersion: evidence.ammVersion || null,
    baseVault: evidence.baseVault || null,
    quoteVault: evidence.quoteVault || null,
    vaultAddresses: addresses(evidence.vaultAddresses || [evidence.baseVault, evidence.quoteVault]),
    programOwnedAddresses: addresses(evidence.programOwnedAddresses),
    escrowAddresses: addresses(evidence.escrowAddresses || evidence.lockAddresses),
    treasuryAddresses: addresses(evidence.treasuryAddresses),
    lpMint: evidence.lpMint || null,
    lpSupply: numeric(evidence.lpSupply),
    lpHolderDistribution: evidence.lpHolderDistribution || null,
    lpBurnStatus: evidence.lpBurnStatus || null,
    lpLockProvider: evidence.lpLockProvider || null,
    lpLockExpiry: evidence.lpLockExpiry || null,
    withdrawAuthority: evidence.withdrawAuthority || null,
    poolCreationSlot: evidence.poolCreationSlot ?? null,
    poolLastUpdateSlot: evidence.poolLastUpdateSlot ?? null,
    source: evidence.source || null,
    status: evidence.status || (Object.values(evidence).some(Boolean) ? "PARTIAL" : "UNKNOWN")
  };
}

function classifyAccount({
  address,
  accountInfo = null,
  ownerInfo = null,
  poolEvidence = {},
  associatedTokenAccountAddresses = [],
  explicitClass = null
} = {}) {
  const accountAddress = String(address || "").trim() || null;
  const pool = normalizePoolEvidence(poolEvidence);
  const poolAddresses = normalizedAddressSet([
    pool.poolAddress,
    pool.baseVault,
    pool.quoteVault,
    ...(pool.vaultAddresses || [])
  ]);
  const associatedAddresses = normalizedAddressSet(associatedTokenAccountAddresses);
  const tokenValue = accountInfo?.result?.value || accountInfo?.value || accountInfo || null;
  const tokenInfo = tokenValue?.data?.parsed?.info || accountInfo?.parsed?.info || {};
  const ownerAddress = String(tokenInfo.owner || "").trim() || null;
  const ownerValue = ownerInfo?.result?.value || ownerInfo?.value || ownerInfo || null;
  const ownerProgramId = String(ownerValue?.owner || "").trim() || null;
  const isOwnerExecutable = ownerValue?.executable === true;

  if (explicitClass && Object.values(ACCOUNT_CLASSES).includes(explicitClass)) {
    return {
      address: accountAddress,
      accountClass: explicitClass,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Explicit account class supplied by the source."]
    };
  }
  if (accountAddress && pool.vaultAddresses.includes(accountAddress) || accountAddress && [pool.baseVault, pool.quoteVault].includes(accountAddress)) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.POOL_VAULT,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Account address matches explicit pool vault evidence."]
    };
  }
  if (accountAddress && pool.poolAddress === accountAddress) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.AMM_POOL,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Account address matches explicit AMM pool evidence."]
    };
  }
  if (accountAddress && associatedAddresses.has(accountAddress)) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.ASSOCIATED_TOKEN_ACCOUNT,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Account address is present in the associated-token-account evidence set."]
    };
  }
  if (accountInfo?.isAssociatedTokenAccount === true || tokenValue?.isAssociatedTokenAccount === true) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.ASSOCIATED_TOKEN_ACCOUNT,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["RPC/source marked the account as an associated token account."]
    };
  }
  if (accountAddress && pool.programOwnedAddresses.includes(accountAddress)) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.PROGRAM_OWNED,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Account address matches explicit program-owned evidence."]
    };
  }
  if (accountAddress && pool.escrowAddresses.includes(accountAddress)) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.ESCROW_OR_LOCK,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Account address matches explicit escrow or lock evidence."]
    };
  }
  if (accountAddress && pool.treasuryAddresses.includes(accountAddress)) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.TREASURY,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Account address matches explicit treasury evidence."]
    };
  }
  if (isOwnerExecutable) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.PROGRAM_OWNED,
      ownerAddress,
      confidence: "RPC",
      evidence: ["Resolved owner account is executable."]
    };
  }
  if (ownerAddress && poolAddresses.has(ownerAddress)) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.AMM_POOL,
      ownerAddress,
      confidence: "EXPLICIT",
      evidence: ["Resolved owner matches explicit pool evidence."]
    };
  }
  if (ownerAddress && ownerProgramId === SYSTEM_PROGRAM_ID && ownerValue?.executable === false) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.EOA_OR_WALLET,
      ownerAddress,
      confidence: "RPC",
      evidence: ["Resolved owner is a non-executable system-owned account."]
    };
  }
  if (ownerAddress && ownerProgramId && TOKEN_PROGRAM_IDS.has(ownerProgramId)) {
    return {
      address: accountAddress,
      accountClass: ACCOUNT_CLASSES.UNKNOWN_ACCOUNT,
      ownerAddress,
      confidence: "LOW",
      evidence: ["Owner was resolved, but its account type is not sufficient to prove wallet ownership."]
    };
  }
  return {
    address: accountAddress,
    accountClass: ACCOUNT_CLASSES.UNKNOWN_ACCOUNT,
    ownerAddress,
    confidence: "UNKNOWN",
    evidence: ["No explicit pool, vault, program, escrow, treasury, ATA, or wallet evidence was available."]
  };
}

function topPercent(topHolders, count, predicate = () => true) {
  const values = (Array.isArray(topHolders) ? topHolders : [])
    .filter(predicate)
    .slice(0, count)
    .map(holder => numeric(holder?.percent))
    .filter(value => value != null);
  return values.length ? Number(values.reduce((sum, value) => sum + value, 0).toFixed(8)) : null;
}

function buildAccountTaxonomy(topHolders, {
  poolEvidence = {},
  accountInfoByAddress = {},
  ownerInfoByAddress = {},
  associatedTokenAccountAddresses = []
} = {}) {
  const holders = (Array.isArray(topHolders) ? topHolders : []).map(holder => {
    const address = String(holder?.address || "").trim() || null;
    const resolvedOwner = address
      ? accountInfoByAddress[address]?.result?.value?.data?.parsed?.info?.owner
        || accountInfoByAddress[address]?.value?.data?.parsed?.info?.owner
      : null;
    const classification = classifyAccount({
      address,
      accountInfo: address ? accountInfoByAddress[address] : null,
      ownerInfo: resolvedOwner
        ? ownerInfoByAddress[resolvedOwner]
        : null,
      poolEvidence,
      associatedTokenAccountAddresses,
      explicitClass: holder?.accountClass || holder?.class
    });
    return { ...holder, ...classification };
  });
  const resolvedWallet = holder => [
    ACCOUNT_CLASSES.EOA_OR_WALLET,
    ACCOUNT_CLASSES.ASSOCIATED_TOKEN_ACCOUNT
  ].includes(holder.accountClass);
  const knownClassCount = holders.filter(holder => holder.accountClass !== ACCOUNT_CLASSES.UNKNOWN_ACCOUNT).length;
  const poolClassCount = holders.filter(holder => [ACCOUNT_CLASSES.AMM_POOL, ACCOUNT_CLASSES.POOL_VAULT].includes(holder.accountClass)).length;
  const status = knownClassCount > 0 ? "CLASSIFIED_PARTIAL" : "ACCOUNT_CONCENTRATION_ONLY";

  return {
    taxonomyVersion: TAXONOMY_VERSION,
    status,
    confidenceCap: status === "ACCOUNT_CONCENTRATION_ONLY" ? 50 : knownClassCount === holders.length ? 100 : 70,
    poolEvidence: normalizePoolEvidence(poolEvidence),
    accounts: holders,
    classCounts: holders.reduce((counts, holder) => {
      counts[holder.accountClass] = (counts[holder.accountClass] || 0) + 1;
      return counts;
    }, {}),
    concentration: {
      top_1_account_percent: topPercent(holders, 1),
      top_5_account_percent: topPercent(holders, 5),
      top_10_account_percent: topPercent(holders, 10),
      top_20_account_percent: topPercent(holders, 20),
      top_1_wallet_percent: topPercent(holders, 1, resolvedWallet),
      top_5_wallet_percent: topPercent(holders, 5, resolvedWallet),
      top_10_wallet_percent: topPercent(holders, 10, resolvedWallet),
      pool_adjusted_top_1_wallet_percent: topPercent(holders.filter(holder => ![ACCOUNT_CLASSES.AMM_POOL, ACCOUNT_CLASSES.POOL_VAULT].includes(holder.accountClass)), 1, resolvedWallet),
      pool_adjusted_top_10_wallet_percent: topPercent(holders.filter(holder => ![ACCOUNT_CLASSES.AMM_POOL, ACCOUNT_CLASSES.POOL_VAULT].includes(holder.accountClass)), 10, resolvedWallet),
      pool_accounts_observed: poolClassCount
    }
  };
}

function selectPrimaryPair(pairs) {
  return [...(Array.isArray(pairs) ? pairs : [])]
    .filter(pair => pair && pair.chainId === "solana" && numeric(pair.priceUsd) != null && numeric(pair.liquidity?.usd) != null)
    .sort((left, right) => {
      const liquidityDifference = (numeric(right.liquidity?.usd) ?? -1) - (numeric(left.liquidity?.usd) ?? -1);
      if (liquidityDifference) return liquidityDifference;
      const updatedDifference = (numeric(right.updatedAt) ?? -1) - (numeric(left.updatedAt) ?? -1);
      if (updatedDifference) return updatedDifference;
      const createdDifference = (numeric(right.pairCreatedAt) ?? -1) - (numeric(left.pairCreatedAt) ?? -1);
      if (createdDifference) return createdDifference;
      return String(left.pairAddress || "").localeCompare(String(right.pairAddress || ""));
    })[0] || null;
}

function dedupePairs(pairs) {
  const seen = new Set();
  return (Array.isArray(pairs) ? pairs : []).filter(pair => {
    if (!pair || pair.chainId !== "solana" || !pair.pairAddress || seen.has(pair.pairAddress)) return false;
    seen.add(pair.pairAddress);
    return true;
  });
}

function dedupeMintEntries(entries, limit = 10) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).filter(item => {
    const mint = String(item?.tokenAddress || "");
    if (!mint || seen.has(mint)) return false;
    seen.add(mint);
    return true;
  }).slice(0, limit);
}

function normalizeDiscoveryUniverse({ boostEntries = [], profileEntries = [], watchlistMints = [], limit = 30 } = {}) {
  const merged = new Map();
  const sourceLists = [
    ["boost_feed", boostEntries],
    ["new_pair_feed", profileEntries],
    ["watchlist", watchlistMints.map(tokenAddress => ({ tokenAddress }))]
  ];
  for (const [source, entries] of sourceLists) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const mint = String(entry?.tokenAddress || "").trim();
      if (!mint || (entry.chainId && entry.chainId !== "solana")) continue;
      const current = merged.get(mint) || {
        tokenAddress: mint,
        sources: [],
        sourceEntries: {}
      };
      if (!current.sources.includes(source)) current.sources.push(source);
      if (!current.sourceEntries[source]) current.sourceEntries[source] = entry;
      merged.set(mint, current);
    }
  }
  const entries = [...merged.values()]
    .sort((left, right) => {
      const sourcePriority = entry => entry.sources.includes("watchlist") ? 0 : entry.sources.includes("new_pair_feed") ? 1 : 2;
      return sourcePriority(left) - sourcePriority(right) || left.tokenAddress.localeCompare(right.tokenAddress);
    })
    .slice(0, limit);
  const sourceMetrics = {
    boost_feed_seen: new Set((Array.isArray(boostEntries) ? boostEntries : []).map(item => item?.tokenAddress).filter(Boolean)).size,
    profile_feed_seen: new Set((Array.isArray(profileEntries) ? profileEntries : []).map(item => item?.tokenAddress).filter(Boolean)).size,
    new_pair_feed_seen: new Set((Array.isArray(profileEntries) ? profileEntries : []).map(item => item?.tokenAddress).filter(Boolean)).size,
    watchlist_seen: new Set((Array.isArray(watchlistMints) ? watchlistMints : []).filter(Boolean)).size,
    unique_mints_before_dedup: new Set(sourceLists.flatMap(([, values]) => values.map(item => item?.tokenAddress).filter(Boolean))).size,
    unique_mints_after_dedup: entries.length,
    source_overlap: {},
    source_only_candidates: { boost_feed: 0, new_pair_feed: 0, watchlist: 0 }
  };
  for (const entry of entries) {
    const sources = entry.sources;
    if (sources.length > 1) {
      for (let index = 0; index < sources.length; index += 1) {
        for (let next = index + 1; next < sources.length; next += 1) {
          const key = [sources[index], sources[next]].sort().join("+");
          sourceMetrics.source_overlap[key] = (sourceMetrics.source_overlap[key] || 0) + 1;
        }
      }
    } else if (sources.length === 1) {
      sourceMetrics.source_only_candidates[sources[0]] += 1;
    }
  }
  return { entries, sourceMetrics };
}

function securityReasonCodes(security) {
  if (!security || ["UNVERIFIED", "UNKNOWN", "STALE"].includes(security.status)) return ["SECURITY_UNKNOWN"];
  const codes = [];
  if (security.authorities?.mint === "ACTIVE") codes.push("MINT_AUTHORITY_ACTIVE");
  if (security.authorities?.freeze === "ACTIVE") codes.push("FREEZE_AUTHORITY_ACTIVE");
  if (security.topHolderPercent == null || security.supply == null) codes.push("SECURITY_DATA_INCOMPLETE");
  else if (security.topHolderPercent > MAX_TOP_HOLDER_PERCENT) codes.push("TOP_HOLDER_ABOVE_LIMIT");
  if (!codes.length && security.verified !== true) codes.push("SECURITY_REJECTED");
  return codes;
}

function evaluateBaselineCandidate(item) {
  const reasons = [];
  const securityCodes = securityReasonCodes(item?.security);
  reasons.push(...securityCodes);

  if (item?.price === "UNKNOWN" || numeric(String(item?.price || "").replace("$", "")) == null) {
    reasons.push("PRICE_UNKNOWN");
  }

  const liquidity = numeric(item?.liquidity);
  if (liquidity == null) reasons.push("LIQUIDITY_UNKNOWN");
  else if (liquidity < MIN_LIQUIDITY_USD) reasons.push("LIQUIDITY_BELOW_MINIMUM");

  const priceChange = numeric(String(item?.priceChange || "").replace("%", ""));
  if (priceChange == null) reasons.push("PRICE_CHANGE_UNKNOWN");
  else if (priceChange <= 0) reasons.push("PRICE_CHANGE_NOT_POSITIVE");

  if (item?.details?.providerMetadata?.cto === true) reasons.push("CTO_FLAG");

  const unknown = reasons.some(code => code.endsWith("_UNKNOWN") || code === "SECURITY_DATA_INCOMPLETE");
  const accepted = reasons.length === 0 && item?.security?.verified === true;
  return {
    accepted,
    outcome: accepted ? "ACCEPTED" : unknown ? "UNRESOLVED" : "REJECTED",
    reasonCodes: [...new Set(reasons)]
  };
}

function summarizeBaselineCandidates(candidates, metadata = {}) {
  const decisions = (Array.isArray(candidates) ? candidates : []).map(evaluateBaselineCandidate);
  const reasons = new Map();
  for (const decision of decisions) {
    for (const code of decision.reasonCodes) {
      const current = reasons.get(code) || { code, count: 0 };
      current.count += 1;
      reasons.set(code, current);
    }
  }

  const report = {
    decisionVersion: BASELINE_DECISION_VERSION,
    recordsChecked: decisions.length,
    filterConfig: FILTER_CONFIG,
    accepted: decisions.filter(decision => decision.accepted).length,
    rejected: decisions.filter(decision => decision.outcome === "REJECTED").length,
    unresolved: decisions.filter(decision => decision.outcome === "UNRESOLVED").length,
    reasons: [...reasons.values()]
      .map(reason => ({ ...reason, reason: REASON_LABELS[reason.code] || reason.code }))
      .sort((left, right) => left.code.localeCompare(right.code)),
    providerRecords: metadata.providerRecords ?? decisions.length,
    discoveryUniverseSize: metadata.discoveryUniverseSize ?? decisions.length,
    providerRecordsWithPair: metadata.providerRecordsWithPair ?? 0,
    providerRecordsWithPrice: metadata.providerRecordsWithPrice ?? 0,
    providerRecordsWithLiquidity: metadata.providerRecordsWithLiquidity ?? 0,
    securityVerified: candidates.filter(item => item?.security?.status === "VERIFIED").length,
    securityUnknown: candidates.filter(item => ["UNVERIFIED", "UNKNOWN", "STALE"].includes(item?.security?.status)).length,
    securityRejected: candidates.filter(item => item?.security?.status === "REJECTED").length,
    liquidityRejected: decisions.filter(decision => decision.reasonCodes.includes("LIQUIDITY_BELOW_MINIMUM")).length,
    momentumRejected: decisions.filter(decision => decision.reasonCodes.includes("PRICE_CHANGE_NOT_POSITIVE")).length,
    ctoRejected: decisions.filter(decision => decision.reasonCodes.includes("CTO_FLAG")).length,
    ...metadata
  };

  if (report.recordsChecked !== report.accepted + report.rejected + report.unresolved) {
    throw new Error("Baseline count reconciliation failed.");
  }
  return report;
}

function selectBoardTokens(previousTokens, acceptedTokens) {
  return Array.isArray(acceptedTokens) && acceptedTokens.length
    ? acceptedTokens
    : (Array.isArray(previousTokens) ? previousTokens : []);
}

module.exports = {
  ACCOUNT_CLASSES,
  BASELINE_DECISION_VERSION,
  FILTER_CONFIG,
  MAX_TOP_HOLDER_PERCENT,
  MIN_LIQUIDITY_USD,
  TAXONOMY_VERSION,
  buildAccountTaxonomy,
  classifyAccount,
  dedupePairs,
  dedupeMintEntries,
  evaluateBaselineCandidate,
  normalizePoolEvidence,
  normalizeDiscoveryUniverse,
  selectBoardTokens,
  selectPrimaryPair,
  summarizeBaselineCandidates
};