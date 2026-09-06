const FEATURE_VERSION = "phase3-v1";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FEATURE_LOOKBACK_MS = 24 * ONE_HOUR_MS;
const MIN_VOLATILITY_SAMPLES = 3;
const MIN_MANIPULATION_SAMPLES = 12;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  const result = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(result) ? result : null;
}

function observationTime(observation) {
  return timestamp(observation?.observedAt);
}

function field(observation, key) {
  return observation?.[key] == null ? null : observation[key];
}

function pairValue(observation, key, nestedKey = null) {
  const pair = observation?.pair || observation?.rawPayload?.pair || {};
  const value = pair[nestedKey || key];
  return finite(value);
}

function volumeValue(observation, window) {
  return finite(observation?.volume?.[window] ?? observation?.rawPayload?.pair?.volume?.[window]);
}

function transactionValue(observation, window, side) {
  return finite(observation?.transactions?.[window]?.[side]
    ?? observation?.rawPayload?.pair?.txns?.[window]?.[side]);
}

function makerValue(observation, window) {
  return finite(observation?.makers?.[window] ?? observation?.rawPayload?.pair?.makers?.[window]);
}

function sortedObservations(observations, asOfMs) {
  return (Array.isArray(observations) ? observations : [])
    .map(observation => ({ observation, time: observationTime(observation) }))
    .filter(item => item.time != null && item.time <= asOfMs)
    .sort((left, right) => left.time - right.time)
    .map(item => item.observation);
}

function atOrBefore(observations, targetMs, toleranceMs) {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const candidateTime = observationTime(observations[index]);
    if (candidateTime == null || candidateTime > targetMs) continue;
    return targetMs - candidateTime <= toleranceMs ? observations[index] : null;
  }
  return null;
}

function percentChange(current, previous) {
  if (current == null || previous == null || previous <= 0) return null;
  return Number((((current / previous) - 1) * 100).toFixed(6));
}

function median(values) {
  const usable = values.filter(value => value != null).sort((left, right) => left - right);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function standardDeviation(values) {
  if (values.length < MIN_VOLATILITY_SAMPLES) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Number((Math.sqrt(variance) * 100).toFixed(6));
}

function countImbalance(observation) {
  const buys = transactionValue(observation, "h24", "buys");
  const sells = transactionValue(observation, "h24", "sells");
  if (buys == null || sells == null || buys + sells <= 0) return null;
  return Number(((buys - sells) / (buys + sells)).toFixed(6));
}

function deriveFeatureSnapshot(observations, { asOf = null } = {}) {
  const candidateTimes = (Array.isArray(observations) ? observations : [])
    .map(observationTime)
    .filter(value => value != null);
  const asOfMs = timestamp(asOf) ?? (candidateTimes.length ? Math.max(...candidateTimes) : null);
  if (asOfMs == null) {
    return {
      featureVersion: FEATURE_VERSION,
      observedAt: null,
      status: "UNKNOWN",
      features: {},
      qualityReasons: ["OBSERVATION_TIME_UNKNOWN"],
      freshness: { observedAt: null, marketDataAgeMs: null, securityDataAgeMs: null },
      completeness: 0
    };
  }

  const history = sortedObservations(observations, asOfMs);
  const current = history[history.length - 1] || null;
  if (!current) {
    return {
      featureVersion: FEATURE_VERSION,
      observedAt: new Date(asOfMs).toISOString(),
      status: "UNKNOWN",
      features: {},
      qualityReasons: ["OBSERVATION_NOT_FOUND"],
      freshness: { observedAt: new Date(asOfMs).toISOString(), marketDataAgeMs: null, securityDataAgeMs: null },
      completeness: 0
    };
  }

  const currentTime = observationTime(current);
  const fiveMinute = atOrBefore(history, currentTime - FIVE_MINUTES_MS, 2 * 60 * 1000);
  const oneHour = atOrBefore(history, currentTime - ONE_HOUR_MS, 15 * 60 * 1000);
  const currentPrice = finite(field(current, "priceUsd"));
  const shortPriceChange = percentChange(currentPrice, finite(field(fiveMinute, "priceUsd")));
  const longPriceChange = percentChange(currentPrice, finite(field(oneHour, "priceUsd")));
  const priceAcceleration = shortPriceChange == null || longPriceChange == null
    ? null
    : Number((shortPriceChange - longPriceChange).toFixed(6));

  const priorVolumeSamples = history
    .filter(observation => observationTime(observation) < currentTime)
    .slice(-20)
    .map(observation => volumeValue(observation, "m5"))
    .filter(value => value != null);
  const currentVolume5m = volumeValue(current, "m5");
  const expectedVolume5m = median(priorVolumeSamples);
  const volumeAcceleration = currentVolume5m != null && expectedVolume5m != null && expectedVolume5m > 0
    ? Number((currentVolume5m / expectedVolume5m).toFixed(6))
    : null;

  const currentLiquidity = finite(field(current, "liquidityUsd"));
  const previousLiquidity = finite(field(oneHour, "liquidityUsd"));
  const liquidityGrowth = percentChange(currentLiquidity, previousLiquidity);
  const currentMakers = makerValue(current, "h24");
  const previousMakers = makerValue(oneHour, "h24");
  const makerGrowth = percentChange(currentMakers, previousMakers);
  const volume24h = volumeValue(current, "h24");
  const volumeLiquidityRatio = currentLiquidity != null && currentLiquidity > 0 && volume24h != null
    ? Number((volume24h / currentLiquidity).toFixed(6))
    : null;
  const buySellImbalance = countImbalance(current);

  const priceSeries = history
    .filter(observation => currentTime - observationTime(observation) <= ONE_HOUR_MS)
    .map(observation => finite(field(observation, "priceUsd")))
    .filter(value => value != null && value > 0);
  const returns = [];
  for (let index = 1; index < priceSeries.length; index += 1) {
    returns.push(Math.log(priceSeries[index] / priceSeries[index - 1]));
  }
  const volatility = standardDeviation(returns);
  const highWaterMark = priceSeries.length ? Math.max(...priceSeries) : null;
  const drawdown = currentPrice != null && highWaterMark > 0
    ? Number((((currentPrice / highWaterMark) - 1) * 100).toFixed(6))
    : null;
  const topAccountPercent = finite(current?.concentration?.top_1_account_percent
    ?? current?.rawPayload?.security?.concentration?.top_1_account_percent);
  const concentrationPenalty = topAccountPercent == null
    ? null
    : Number(Math.max(0, Math.min(100, topAccountPercent)).toFixed(6));

  const features = {
    priceAcceleration,
    priceAccelerationBasis: "5M_MINUS_1H_PERCENT_CHANGE",
    volumeAcceleration,
    volumeAccelerationBasis: "CURRENT_M5_OVER_PRIOR_M5_MEDIAN",
    buySellImbalance,
    buySellImbalanceBasis: buySellImbalance == null ? null : "H24_TRANSACTION_COUNTS_ONLY",
    makerGrowth,
    liquidityGrowth,
    volumeLiquidityRatio,
    volatility,
    drawdown,
    concentrationPenalty
  };
  const measurable = [
    priceAcceleration, volumeAcceleration, buySellImbalance, makerGrowth,
    liquidityGrowth, volumeLiquidityRatio, volatility, drawdown
  ];
  const qualityReasons = [];
  if (priceAcceleration == null) qualityReasons.push("PRICE_ACCELERATION_HISTORY_INSUFFICIENT");
  if (volumeAcceleration == null) qualityReasons.push("VOLUME_ACCELERATION_HISTORY_INSUFFICIENT");
  if (buySellImbalance == null) qualityReasons.push("FLOW_TRANSACTION_COUNTS_UNKNOWN");
  if (buySellImbalance != null) qualityReasons.push("FLOW_VOLUME_UNAVAILABLE");
  if (makerGrowth == null) qualityReasons.push("MAKER_GROWTH_HISTORY_INSUFFICIENT");
  if (liquidityGrowth == null) qualityReasons.push("LIQUIDITY_GROWTH_HISTORY_INSUFFICIENT");
  if (volumeLiquidityRatio == null) qualityReasons.push("VOLUME_LIQUIDITY_RATIO_UNKNOWN");
  if (volatility == null) qualityReasons.push("VOLATILITY_HISTORY_INSUFFICIENT");
  if (drawdown == null) qualityReasons.push("DRAWDOWN_HISTORY_INSUFFICIENT");
  if (concentrationPenalty == null) qualityReasons.push("CONCENTRATION_UNKNOWN");
  if (history.length < MIN_MANIPULATION_SAMPLES) qualityReasons.push("MANIPULATION_UNKNOWN_SAMPLE");

  const securityObservedAt = timestamp(current?.rawPayload?.security?.rpcEvidence?.observedAt);
  const providerUpdatedAt = timestamp(current?.providerUpdatedAt);
  const observedAt = new Date(currentTime).toISOString();
  return {
    featureVersion: FEATURE_VERSION,
    observedAt,
    status: measurable.every(value => value != null) ? "COMPLETE" : "PARTIAL",
    features,
    freshness: {
      observedAt,
      sourceUpdatedAt: providerUpdatedAt == null ? null : new Date(providerUpdatedAt).toISOString(),
      marketDataAgeMs: providerUpdatedAt == null ? null : Math.max(0, currentTime - providerUpdatedAt),
      securityObservedAt: securityObservedAt == null ? null : new Date(securityObservedAt).toISOString(),
      securityDataAgeMs: securityObservedAt == null ? null : Math.max(0, currentTime - securityObservedAt),
      historySamples: history.length
    },
    completeness: Math.round((measurable.filter(value => value != null).length / measurable.length) * 100),
    qualityReasons: [...new Set(qualityReasons)]
  };
}

module.exports = {
  FEATURE_VERSION,
  deriveFeatureSnapshot
};