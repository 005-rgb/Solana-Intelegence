const EXECUTION_SAFETY_VERSION = "phase2a-v1";
const DEFAULT_ORDER_SIZES_USD = Object.freeze([100, 500, 1_000]);
const DEFAULT_MAX_QUOTE_AGE_MS = 30_000;
const DEFAULT_MAX_PRICE_IMPACT_PERCENT = 2;
const DEFAULT_MAX_SLIPPAGE_BPS = 200;

const EXECUTION_REASON_LABELS = Object.freeze({
  BUY_QUOTE_UNKNOWN: "Buy quote is unavailable for one or more research sizes.",
  SELL_QUOTE_UNKNOWN: "Sell quote is unavailable; sellability cannot be assumed.",
  BUY_ROUTE_UNAVAILABLE: "No buy route was returned.",
  SELL_ROUTE_UNAVAILABLE: "No sell route was returned.",
  BUY_QUOTE_FAILED: "Buy quote request failed.",
  SELL_QUOTE_FAILED: "Sell quote request failed.",
  BUY_SIMULATION_UNKNOWN: "Buy simulation evidence is unavailable.",
  SELL_SIMULATION_UNKNOWN: "Sell simulation evidence is unavailable.",
  BUY_SIMULATION_FAILED: "Buy simulation failed.",
  SELL_SIMULATION_FAILED: "Sell simulation failed.",
  PRICE_IMPACT_UNKNOWN: "Quote price impact is unavailable.",
  PRICE_IMPACT_TOO_HIGH: "Quote price impact exceeds the configured limit.",
  SLIPPAGE_UNKNOWN: "Quote slippage evidence is unavailable.",
  SLIPPAGE_TOO_HIGH: "Quote slippage exceeds the configured limit.",
  TRANSFER_FEE_UNKNOWN: "Transfer-fee evidence is unavailable.",
  TRANSFER_HOOK_UNKNOWN: "Transfer-hook evidence is unavailable.",
  ACCOUNT_CREATION_UNKNOWN: "Associated-account creation requirement is unavailable.",
  QUOTE_STALE: "Quote evidence is older than the configured freshness window.",
  QUOTE_TIMESTAMP_UNKNOWN: "Quote timestamp is unavailable.",
  ORDER_SIZE_UNKNOWN: "The quote provider cannot represent the configured research size.",
  SIMULATION_NOT_ATTEMPTED_WITHOUT_WALLET_CONTEXT: "Simulation requires a wallet/account context and was not attempted."
});

function finite(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeStatus(value) {
  const status = String(value || "").toUpperCase();
  return ["PASS", "PASSED", "SUCCESS", "FAILED", "UNKNOWN", "NOT_ATTEMPTED"].includes(status)
    ? status
    : "UNKNOWN";
}

function normalizeEvidence(evidence, {
  orderSizesUsd = DEFAULT_ORDER_SIZES_USD,
  now = Date.now()
} = {}) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  const normalizeSide = side => {
    const input = source[side];
    const records = input && typeof input === "object" ? input : {};
    return Object.fromEntries(orderSizesUsd.map(size => {
      const raw = records[String(size)] || records[size] || {};
      const quoteAt = raw.quoteAt || raw.observedAt || null;
      const quoteTime = quoteAt == null ? null : Date.parse(String(quoteAt));
      return [String(size), {
        orderSizeUsd: size,
        status: normalizeStatus(raw.status),
        routeAvailable: raw.routeAvailable === true ? true : raw.routeAvailable === false ? false : null,
        minimumReceived: finite(raw.minimumReceived),
        priceImpactPercent: finite(raw.priceImpactPercent),
        estimatedSlippageBps: finite(raw.estimatedSlippageBps),
        transferFee: raw.transferFee === "UNKNOWN" || raw.transferFee == null ? null : finite(raw.transferFee),
        transferHook: raw.transferHook === "UNKNOWN" || raw.transferHook == null ? null : normalizeStatus(raw.transferHook),
        accountCreationRequired: typeof raw.accountCreationRequired === "boolean" ? raw.accountCreationRequired : null,
        simulationStatus: normalizeStatus(raw.simulationStatus),
        quoteAt: Number.isFinite(quoteTime) ? new Date(quoteTime).toISOString() : null,
        quoteAgeMs: Number.isFinite(quoteTime) ? Math.max(0, now - quoteTime) : null,
        source: typeof raw.source === "string" ? raw.source : null,
        route: raw.route && typeof raw.route === "object" ? raw.route : null,
        error: typeof raw.error === "string" ? raw.error.slice(0, 240) : null
      }];
    }));
  };
  return {
    version: source.version || EXECUTION_SAFETY_VERSION,
    source: typeof source.source === "string" ? source.source : null,
    buy: normalizeSide("buy"),
    sell: normalizeSide("sell")
  };
}

function evaluateExecutionSafety(evidence, {
  now = Date.now(),
  orderSizesUsd = DEFAULT_ORDER_SIZES_USD,
  maxQuoteAgeMs = DEFAULT_MAX_QUOTE_AGE_MS,
  maxPriceImpactPercent = DEFAULT_MAX_PRICE_IMPACT_PERCENT,
  maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS
} = {}) {
  const normalized = normalizeEvidence(evidence, { orderSizesUsd, now });
  const reasons = [];
  const checks = [];

  for (const size of orderSizesUsd) {
    for (const side of ["buy", "sell"]) {
      const quote = normalized[side][String(size)];
      const label = side === "buy" ? "BUY" : "SELL";
      if (quote.status === "FAILED") reasons.push(`${side === "buy" ? "BUY" : "SELL"}_QUOTE_FAILED`);
      if (quote.status === "UNKNOWN") reasons.push(`${label}_QUOTE_UNKNOWN`);
      if (quote.routeAvailable === false) reasons.push(`${label}_ROUTE_UNAVAILABLE`);
      if (quote.routeAvailable == null) reasons.push(`${label}_QUOTE_UNKNOWN`);
      if (quote.priceImpactPercent == null) reasons.push("PRICE_IMPACT_UNKNOWN");
      else if (quote.priceImpactPercent > maxPriceImpactPercent) reasons.push("PRICE_IMPACT_TOO_HIGH");
      if (quote.estimatedSlippageBps == null) reasons.push("SLIPPAGE_UNKNOWN");
      else if (quote.estimatedSlippageBps > maxSlippageBps) reasons.push("SLIPPAGE_TOO_HIGH");
      if (quote.quoteAgeMs == null) reasons.push("QUOTE_TIMESTAMP_UNKNOWN");
      else if (quote.quoteAgeMs > maxQuoteAgeMs) reasons.push("QUOTE_STALE");
      if (quote.simulationStatus === "FAILED") reasons.push(`${label}_SIMULATION_FAILED`);
      else if (quote.simulationStatus !== "PASS" && quote.simulationStatus !== "PASSED" && quote.simulationStatus !== "SUCCESS") {
        reasons.push(`${label}_SIMULATION_UNKNOWN`);
        if (quote.simulationStatus === "NOT_ATTEMPTED") reasons.push("SIMULATION_NOT_ATTEMPTED_WITHOUT_WALLET_CONTEXT");
      }
      if (quote.transferFee == null) reasons.push("TRANSFER_FEE_UNKNOWN");
      if (quote.transferHook == null) reasons.push("TRANSFER_HOOK_UNKNOWN");
      if (quote.accountCreationRequired == null) reasons.push("ACCOUNT_CREATION_UNKNOWN");
      checks.push({
        side,
        orderSizeUsd: size,
        quoteStatus: quote.status,
        simulationStatus: quote.simulationStatus,
        routeAvailable: quote.routeAvailable,
        quoteAgeMs: quote.quoteAgeMs
      });
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const hardFailure = uniqueReasons.some(code => [
    "BUY_QUOTE_FAILED",
    "SELL_QUOTE_FAILED",
    "BUY_ROUTE_UNAVAILABLE",
    "SELL_ROUTE_UNAVAILABLE",
    "BUY_SIMULATION_FAILED",
    "SELL_SIMULATION_FAILED",
    "PRICE_IMPACT_TOO_HIGH",
    "SLIPPAGE_TOO_HIGH"
  ].includes(code));
  const status = hardFailure ? "REJECTED" : uniqueReasons.length ? "UNKNOWN" : "ACTIONABLE_RESEARCH";
  return {
    version: EXECUTION_SAFETY_VERSION,
    status,
    actionable: status === "ACTIONABLE_RESEARCH",
    reasons: uniqueReasons,
    checks,
    evidence: normalized,
    config: {
      orderSizesUsd: [...orderSizesUsd],
      maxQuoteAgeMs,
      maxPriceImpactPercent,
      maxSlippageBps
    }
  };
}

function summarizeExecutionSafety(items, options = {}) {
  const evaluations = (Array.isArray(items) ? items : []).map(item => evaluateExecutionSafety(item?.details?.executionEvidence || item?.executionEvidence, options));
  const reasonCounts = new Map();
  for (const evaluation of evaluations) {
    for (const code of evaluation.reasons) reasonCounts.set(code, (reasonCounts.get(code) || 0) + 1);
  }
  return {
    version: EXECUTION_SAFETY_VERSION,
    recordsChecked: evaluations.length,
    actionableResearch: evaluations.filter(item => item.status === "ACTIONABLE_RESEARCH").length,
    rejected: evaluations.filter(item => item.status === "REJECTED").length,
    unknown: evaluations.filter(item => item.status === "UNKNOWN").length,
    reasons: [...reasonCounts.entries()]
      .map(([code, count]) => ({ code, count, reason: EXECUTION_REASON_LABELS[code] || code }))
      .sort((left, right) => left.code.localeCompare(right.code))
  };
}

function extractSellExecutionEvidence(executionSafety, orderSizeUsd = 100) {
  const source = executionSafety && typeof executionSafety === "object" ? executionSafety : {};
  const size = String(orderSizeUsd);
  const sellEvidence = source.evidence?.sell?.[size]
    || source.sell?.[size]
    || (Array.isArray(source.checks) ? source.checks.find(check => String(check.side).toLowerCase() === "sell" && Number(check.orderSizeUsd) === Number(orderSizeUsd)) : null);
  if (!sellEvidence || typeof sellEvidence !== "object") {
    return {
      state: "UNKNOWN",
      reason: "SELL_ROUTE_EVIDENCE_UNAVAILABLE",
      routeAvailable: null,
      quoteStatus: "UNKNOWN",
      quoteAt: null,
      slippageBps: null,
      priceImpactPercent: null,
      feeBps: null,
      feeAmount: null,
      feeMint: null,
      source: source.source || null,
      invalidationCodes: []
    };
  }
  const status = normalizeStatus(sellEvidence.status || sellEvidence.quoteStatus);
  const routeAvailable = sellEvidence.routeAvailable === true
    ? true
    : sellEvidence.routeAvailable === false
      ? false
      : null;
  const invalidationCodes = Array.isArray(sellEvidence.invalidationCodes)
    ? sellEvidence.invalidationCodes.map(code => String(code).slice(0, 80))
    : [];
  const slippageBps = finite(sellEvidence.estimatedSlippageBps ?? sellEvidence.slippageBps);
  const priceImpactPercent = finite(sellEvidence.priceImpactPercent ?? sellEvidence.priceImpactPct);
  const feeBps = finite(sellEvidence.feeBps ?? (finite(sellEvidence.feePercent) == null ? null : finite(sellEvidence.feePercent) * 100));
  const feeAmount = finite(sellEvidence.feeAmount ?? sellEvidence.fee);
  const feeMint = typeof sellEvidence.feeMint === "string" ? sellEvidence.feeMint : null;
  if (status === "FAILED" || routeAvailable === false) {
    return {
      state: "UNTRADABLE",
      reason: "SELL_ROUTE_EVIDENCE_FAILED",
      routeAvailable,
      quoteStatus: status,
      quoteAt: sellEvidence.quoteAt || null,
      slippageBps,
      priceImpactPercent,
      feeBps,
      feeAmount,
      feeMint,
      source: sellEvidence.source || source.source || null,
      invalidationCodes: [...new Set([...invalidationCodes, "SELL_ROUTE_UNAVAILABLE"])]
    };
  }
  if (status === "PASS" || status === "PASSED" || status === "SUCCESS" || routeAvailable === true) {
    return {
      state: "TRADABLE",
      reason: "SELL_ROUTE_EVIDENCE_PASS",
      routeAvailable: true,
      quoteStatus: status,
      quoteAt: sellEvidence.quoteAt || null,
      slippageBps,
      priceImpactPercent,
      feeBps,
      feeAmount,
      feeMint,
      source: sellEvidence.source || source.source || null,
      invalidationCodes
    };
  }
  return {
    state: "UNKNOWN",
    reason: "SELL_ROUTE_EVIDENCE_INCOMPLETE",
    routeAvailable,
    quoteStatus: status,
    quoteAt: sellEvidence.quoteAt || null,
    slippageBps,
    priceImpactPercent,
    feeBps,
    feeAmount,
    feeMint,
    source: sellEvidence.source || source.source || null,
    invalidationCodes
  };
}

module.exports = {
  EXECUTION_SAFETY_VERSION,
  DEFAULT_ORDER_SIZES_USD,
  DEFAULT_MAX_QUOTE_AGE_MS,
  DEFAULT_MAX_PRICE_IMPACT_PERCENT,
  DEFAULT_MAX_SLIPPAGE_BPS,
  EXECUTION_REASON_LABELS,
  evaluateExecutionSafety,
  normalizeEvidence,
  extractSellExecutionEvidence,
  summarizeExecutionSafety
};