const MANIPULATION_VERSION = "phase3a-v1";
const MIN_TRADE_SAMPLE = 12;
const BURST_WINDOW_MS = 60_000;
const ROUND_TRIP_WINDOW_MS = 15 * 60_000;
const LIQUIDITY_PULL_THRESHOLD_PERCENT = 30;
const COORDINATED_WINDOW_MS = 30_000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function time(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value, max = 160) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function tradeSources(observation) {
  const raw = observation?.rawPayload || {};
  return raw.tradeObservations || raw.trades || observation?.tradeObservations || observation?.trades;
}

function normalizeTrade(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const observedAt = time(raw.observedAt ?? raw.timestamp ?? raw.time ?? raw.blockTime);
  const side = String(raw.side || raw.type || "").toUpperCase();
  const entityId = text(raw.entityId || raw.owner || raw.maker || raw.wallet || raw.account || raw.trader, 128);
  const funderId = text(raw.funder || raw.firstFunder || raw.fundingSource, 128);
  const clusterId = text(raw.clusterId || raw.holderClusterId, 128);
  const amountUsd = finite(raw.amountUsd ?? raw.usd ?? raw.valueUsd ?? raw.notionalUsd);
  const slot = raw.slot == null ? null : String(raw.slot);
  if (observedAt == null && slot == null) return null;
  return {
    id: text(raw.signature || raw.id || `trade-${index}`, 180),
    observedAt,
    slot,
    side: side === "BUY" || side === "SELL" ? side : null,
    entityId,
    funderId,
    clusterId,
    amountUsd,
    source: text(raw.source || "trade-level-provider", 80)
  };
}

function extractTrades(observation) {
  const source = tradeSources(observation);
  if (!Array.isArray(source)) return [];
  return source.map(normalizeTrade).filter(Boolean).sort((a, b) => (a.observedAt || 0) - (b.observedAt || 0));
}

function latestLiquidity(observation) {
  return finite(observation?.liquidityUsd ?? observation?.rawPayload?.pair?.liquidityUsd
    ?? observation?.rawPayload?.pair?.liquidity?.usd);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function percentile(values, fraction) {
  const usable = values.filter(value => value != null).sort((a, b) => a - b);
  if (!usable.length) return null;
  return usable[Math.min(usable.length - 1, Math.floor((usable.length - 1) * fraction))];
}

function unknownReason(code, detail) {
  return { code, detail };
}

function deriveManipulationEvidence(observations, { asOf = null } = {}) {
  const history = (Array.isArray(observations) ? observations : [])
    .filter(item => time(item?.observedAt) != null)
    .sort((a, b) => time(a.observedAt) - time(b.observedAt));
  const asOfMs = time(asOf) ?? (history.length ? time(history[history.length - 1].observedAt) : null);
  if (asOfMs == null) {
    return {
      version: MANIPULATION_VERSION, observedAt: null, status: "UNKNOWN", sampleStatus: "UNKNOWN",
      sampleSize: 0, flags: {}, entities: [], metrics: {}, qualityReasons: [unknownReason("OBSERVATION_TIME_UNKNOWN", "No observation timestamp is available.")],
      smartMoneyStatus: "UNKNOWN", poolDrainStatus: "UNKNOWN"
    };
  }

  const usableHistory = history.filter(item => time(item.observedAt) <= asOfMs);
  const current = usableHistory[usableHistory.length - 1] || null;
  const prior = usableHistory.length > 1 ? usableHistory[usableHistory.length - 2] : null;
  const trades = usableHistory.flatMap(extractTrades).filter(item => item.observedAt == null || item.observedAt <= asOfMs);
  const qualityReasons = [];
  const flags = {
    washTrading: null,
    circularActivity: null,
    burstActivity: null,
    coordinatedActivity: null,
    poolDrain: null
  };

  const knownEntities = unique(trades.map(item => item.entityId));
  const knownClusters = unique(trades.map(item => item.clusterId));
  const funderGroups = new Map();
  for (const trade of trades) {
    if (trade.funderId) funderGroups.set(trade.funderId, (funderGroups.get(trade.funderId) || 0) + 1);
  }
  const entityGroups = new Map();
  for (const trade of trades) {
    if (trade.entityId) {
      if (!entityGroups.has(trade.entityId)) entityGroups.set(trade.entityId, []);
      entityGroups.get(trade.entityId).push(trade);
    }
  }

  if (!trades.length) {
    qualityReasons.push(unknownReason("TRADE_LEVEL_COVERAGE_UNAVAILABLE", "The provider did not supply trade-level observations."));
  } else if (trades.length < MIN_TRADE_SAMPLE) {
    qualityReasons.push(unknownReason("TRADE_SAMPLE_INSUFFICIENT", `Only ${trades.length} trade-level observations are available; ${MIN_TRADE_SAMPLE} are required.`));
  }

  let roundTrips = 0;
  let circularPairs = 0;
  for (const group of entityGroups.values()) {
    for (let index = 0; index < group.length; index += 1) {
      for (let next = index + 1; next < group.length; next += 1) {
        const left = group[index];
        const right = group[next];
        if (left.side && right.side && left.side !== right.side
          && left.observedAt != null && right.observedAt != null
          && right.observedAt - left.observedAt <= ROUND_TRIP_WINDOW_MS) {
          roundTrips += 1;
          break;
        }
      }
    }
  }
  for (let index = 0; index < trades.length; index += 1) {
    const left = trades[index];
    const right = trades[index + 1];
    if (left?.entityId && right?.entityId && left.entityId === right.entityId
      && left.side && right.side && left.side !== right.side
      && left.observedAt != null && right.observedAt != null
      && right.observedAt - left.observedAt <= ROUND_TRIP_WINDOW_MS) circularPairs += 1;
  }

  const timestamps = trades.map(item => item.observedAt).filter(value => value != null);
  let maxBurst = 0;
  for (const startedAt of timestamps) {
    maxBurst = Math.max(maxBurst, timestamps.filter(value => value >= startedAt && value <= startedAt + BURST_WINDOW_MS).length);
  }
  const maxSameSlot = Math.max(0, ...[...new Map(trades.filter(item => item.slot).map(item => [item.slot, 0])).keys()]
    .map(slot => trades.filter(item => item.slot === slot).length));
  const coordinatedGroups = [...new Set(trades.map(item => item.observedAt).filter(value => value != null))]
    .map(startedAt => trades.filter(item => item.observedAt != null && Math.abs(item.observedAt - startedAt) <= COORDINATED_WINDOW_MS))
    .filter(group => group.length >= 3);

  if (trades.length >= MIN_TRADE_SAMPLE) {
    const roundTripRate = roundTrips / trades.length;
    flags.washTrading = roundTripRate >= 0.25;
    // Circular activity needs repeated opposing flow. A repeated round-trip
    // is still evidence of circular behavior even when counterparty identity
    // is unavailable, while the separate wash flag keeps its rate semantics.
    flags.circularActivity = circularPairs >= 2 || roundTrips >= 2;
    flags.burstActivity = maxBurst >= Math.max(5, Math.ceil(trades.length * 0.35)) || maxSameSlot >= 4;
    flags.coordinatedActivity = coordinatedGroups.some(group => new Set(group.map(item => item.entityId).filter(Boolean)).size >= 3);
  } else {
    qualityReasons.push(unknownReason("MANIPULATION_FLAGS_UNKNOWN_SAMPLE", "Trade-based manipulation flags are suppressed until the minimum sample is available."));
  }

  const currentLiquidity = latestLiquidity(current);
  const previousLiquidity = latestLiquidity(prior);
  const liquidityChangePercent = currentLiquidity != null && previousLiquidity != null && previousLiquidity > 0
    ? Number((((currentLiquidity / previousLiquidity) - 1) * 100).toFixed(6))
    : null;
  if (liquidityChangePercent == null) {
    qualityReasons.push(unknownReason("POOL_LIQUIDITY_HISTORY_INSUFFICIENT", "At least two liquidity observations are required."));
  } else {
    flags.poolDrain = liquidityChangePercent <= -LIQUIDITY_PULL_THRESHOLD_PERCENT;
  }

  const amountValues = trades.map(item => item.amountUsd).filter(value => value != null);
  const repeatedAmountThreshold = percentile(amountValues, 0.25);
  const repeatedAmountCount = repeatedAmountThreshold == null ? null
    : amountValues.filter(value => Math.abs(value - repeatedAmountThreshold) <= Math.max(0.01, repeatedAmountThreshold * 0.02)).length;
  const entityEvidence = [...entityGroups.entries()].map(([entityId, group]) => ({
    entityId,
    tradeCount: group.length,
    buyCount: group.filter(item => item.side === "BUY").length,
    sellCount: group.filter(item => item.side === "SELL").length,
    clusterIds: unique(group.map(item => item.clusterId)),
    funderIds: unique(group.map(item => item.funderId))
  })).sort((a, b) => b.tradeCount - a.tradeCount).slice(0, 25);

  const identityEvidence = knownEntities.length > 0 && trades.some(item => item.entityId && (item.funderId || item.clusterId));
  const historyEvidence = entityEvidence.some(item => item.tradeCount >= 2);
  const smartMoneyStatus = identityEvidence && historyEvidence ? "UNVERIFIED" : "UNKNOWN";
  if (!identityEvidence) qualityReasons.push(unknownReason("ENTITY_IDENTITY_UNAVAILABLE", "Wallet/entity identity or funding lineage was not provided."));
  if (!historyEvidence) qualityReasons.push(unknownReason("ENTITY_HISTORY_UNAVAILABLE", "Prior entity outcomes are not present; smart-money classification is not permitted."));

  const sampleStatus = trades.length >= MIN_TRADE_SAMPLE ? "SUFFICIENT" : "UNKNOWN";
  const status = sampleStatus === "SUFFICIENT" && (liquidityChangePercent != null || trades.length > 0) ? "COMPLETE" : "PARTIAL";
  return {
    version: MANIPULATION_VERSION,
    observedAt: new Date(asOfMs).toISOString(),
    status,
    sampleStatus,
    sampleSize: trades.length,
    flags,
    entities: entityEvidence,
    metrics: {
      tradeCount: trades.length,
      knownEntityCount: knownEntities.length,
      knownClusterCount: knownClusters.length,
      sharedFunderCount: [...funderGroups.values()].filter(count => count > 1).length,
      roundTripCount: roundTrips,
      circularPairCount: circularPairs,
      maxBurstCount: maxBurst,
      maxSameSlotCount: maxSameSlot,
      coordinatedGroupCount: coordinatedGroups.length,
      repeatedAmountCount,
      liquidityChangePercent,
      currentLiquidityUsd: currentLiquidity,
      previousLiquidityUsd: previousLiquidity
    },
    qualityReasons,
    smartMoneyStatus,
    poolDrainStatus: flags.poolDrain == null ? "UNKNOWN" : flags.poolDrain ? "FLAGGED" : "CLEAR"
  };
}

module.exports = {
  MANIPULATION_VERSION,
  MIN_TRADE_SAMPLE,
  deriveManipulationEvidence,
  extractTrades
};