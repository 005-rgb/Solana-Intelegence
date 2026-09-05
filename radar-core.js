const BASELINE_DECISION_VERSION = "baseline-v1";
const MAX_TOP_HOLDER_PERCENT = 80;
const MIN_LIQUIDITY_USD = 10_000;

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

function selectPrimaryPair(pairs) {
  return [...(Array.isArray(pairs) ? pairs : [])]
    .filter(pair => pair && pair.chainId === "solana" && numeric(pair.priceUsd) != null && numeric(pair.liquidity?.usd) != null)
    .sort((left, right) => {
      const liquidityDifference = (numeric(right.liquidity?.usd) ?? -1) - (numeric(left.liquidity?.usd) ?? -1);
      if (liquidityDifference) return liquidityDifference;
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
  const entries = [...merged.values()].slice(0, limit);
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
  BASELINE_DECISION_VERSION,
  FILTER_CONFIG,
  MAX_TOP_HOLDER_PERCENT,
  MIN_LIQUIDITY_USD,
  dedupePairs,
  dedupeMintEntries,
  evaluateBaselineCandidate,
  normalizeDiscoveryUniverse,
  selectBoardTokens,
  selectPrimaryPair,
  summarizeBaselineCandidates
};