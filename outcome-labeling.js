const crypto = require("crypto");
const { extractSellExecutionEvidence } = require("./execution-safety");

const OUTCOME_VERSION = "phase6-v1";
const CHECKPOINTS = Object.freeze([
  { key: "T+1M", offsetMs: 60 * 1000 },
  { key: "T+5M", offsetMs: 5 * 60 * 1000 },
  { key: "T+15M", offsetMs: 15 * 60 * 1000 },
  { key: "T+30M", offsetMs: 30 * 60 * 1000 },
  { key: "T+1H", offsetMs: 60 * 60 * 1000 },
  { key: "T+3H", offsetMs: 3 * 60 * 60 * 1000 },
  { key: "T+6H", offsetMs: 6 * 60 * 60 * 1000 },
  { key: "T+12H", offsetMs: 12 * 60 * 60 * 1000 },
  { key: "T+24H", offsetMs: 24 * 60 * 60 * 1000 },
  { key: "T+3D", offsetMs: 3 * 24 * 60 * 60 * 1000 },
  { key: "T+7D", offsetMs: 7 * 24 * 60 * 60 * 1000 }
]);

const LABEL_CONFIG = Object.freeze({
  version: OUTCOME_VERSION,
  targetReturnPercent: 5,
  lossLimitPercent: 5,
  maxObservationLagMs: 30 * 60 * 1000,
  priceEntryDefinition: "FIRST_VALID_PROVIDER_PRICE_AT_SIGNAL",
  priceExitDefinition: "FIRST_VALID_PROVIDER_PRICE_AT_OR_AFTER_CHECKPOINT",
  feeBps: 30
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const TARGET_CONFIG_HASH = crypto.createHash("sha256").update(stable({
  targetReturnPercent: LABEL_CONFIG.targetReturnPercent,
  priceEntryDefinition: LABEL_CONFIG.priceEntryDefinition,
  priceExitDefinition: LABEL_CONFIG.priceExitDefinition
})).digest("hex");
const LOSS_LIMIT_CONFIG_HASH = crypto.createHash("sha256").update(stable({
  lossLimitPercent: LABEL_CONFIG.lossLimitPercent,
  maxObservationLagMs: LABEL_CONFIG.maxObservationLagMs
})).digest("hex");

function finite(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function priceOf(observation) {
  const value = finite(observation?.priceUsd ?? observation?.price);
  return value != null && value > 0 ? value : null;
}

function observationTime(observation) {
  return timestamp(observation?.observedAt);
}

function orderedObservations(observations, signalTime) {
  return (Array.isArray(observations) ? observations : [])
    .map(observation => ({ observation, at: observationTime(observation), price: priceOf(observation) }))
    .filter(item => item.at != null && item.at >= signalTime && item.price != null)
    .sort((a, b) => a.at - b.at);
}

function checkpointFor(observations, signalTime, checkpoint, asOfMs, maxLagMs) {
  const dueAt = signalTime + checkpoint.offsetMs;
  if (asOfMs < dueAt) return { state: "NOT_DUE", dueAt };
  const eligible = observations.filter(item => item.at >= dueAt && item.at <= dueAt + maxLagMs);
  if (!eligible.length) {
    return {
      state: "CENSORED",
      dueAt,
      censoringReason: asOfMs >= dueAt + maxLagMs ? "NO_OBSERVATION_WITHIN_WINDOW" : "FUTURE_OBSERVATION_NOT_YET_AVAILABLE"
    };
  }
  return { state: "FOUND", dueAt, point: eligible[0] };
}

function executionEvidence(observation) {
  const payload = observation?.rawPayload || observation?.raw_payload || {};
  const safety = payload.executionSafety || payload.executionEvidence || {};
  const explicit = payload.tradability || {};
  const extracted = extractSellExecutionEvidence(safety, explicit.orderSizeUsd || 100);
  const slippage = finite(extracted.slippageBps);
  const feeBps = finite(extracted.feeBps ?? explicit.feeBps);
  return {
    ...extracted,
    state: explicit.state || extracted.state,
    reason: explicit.reason || extracted.reason,
    slippageBps: slippage,
    feeBps
  };
}

function securityState(observation) {
  const security = observation?.rawPayload?.security;
  if (security?.status) return String(security.status).toUpperCase();
  if (security?.verified === true) return "VERIFIED";
  return "UNKNOWN";
}

function invalidationCodes(observation, execution) {
  const codes = Array.isArray(execution?.invalidationCodes) ? [...execution.invalidationCodes] : [];
  const status = securityState(observation);
  if (["REJECTED", "INVALID", "UNVERIFIED"].includes(status)) codes.push("SECURITY_INVALIDATED");
  if (execution?.state === "UNTRADABLE") codes.push("EXECUTION_UNTRADABLE");
  return [...new Set(codes)];
}

function thesisOutcome(scorecard, result, horizonObservation) {
  if (result.state !== "FOUND") return "UNKNOWN";
  const thesis = scorecard?.phase4a?.thesis || {};
  if (thesis.state === "THESIS_CONFLICT") return "INVALIDATED";
  const security = securityState(horizonObservation);
  if (["REJECTED", "INVALID", "UNVERIFIED"].includes(security)) return "INVALIDATED";
  if (result.forwardReturnPercent == null || result.maePercent == null) return "UNKNOWN";
  if (result.forwardReturnPercent >= LABEL_CONFIG.targetReturnPercent && result.maePercent > -LABEL_CONFIG.lossLimitPercent) return "SUPPORTED";
  if (result.forwardReturnPercent <= -LABEL_CONFIG.lossLimitPercent || result.maePercent <= -LABEL_CONFIG.lossLimitPercent) return "INVALIDATED";
  return "WEAKENED";
}

function catalystOutcome(horizonObservation) {
  const explicit = horizonObservation?.rawPayload?.catalystOutcome
    || horizonObservation?.rawPayload?.projectEvidence?.catalystOutcome;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().toUpperCase();
  return "UNKNOWN";
}

function labelDecisionAtCheckpoint(decision, observations, checkpoint, asOf = Date.now(), config = LABEL_CONFIG) {
  const signalTime = timestamp(decision?.observedAt);
  if (signalTime == null) throw new Error("Outcome labeling requires a valid decision time.");
  const asOfMs = timestamp(asOf) ?? Date.now();
  const points = orderedObservations(observations, signalTime);
  const checkpointState = checkpointFor(points, signalTime, checkpoint, asOfMs, config.maxObservationLagMs);
  const base = {
    outcomeVersion: OUTCOME_VERSION,
    checkpoint: checkpoint.key,
    signalTime: new Date(signalTime).toISOString(),
    labelStartTime: new Date(signalTime).toISOString(),
    labelEndTime: new Date(signalTime + checkpoint.offsetMs).toISOString(),
    targetConfigHash: TARGET_CONFIG_HASH,
    lossLimitConfigHash: LOSS_LIMIT_CONFIG_HASH,
    entryPriceDefinition: config.priceEntryDefinition,
    exitPriceDefinition: config.priceExitDefinition,
    completionState: checkpointState.state,
    censoringReason: checkpointState.censoringReason || null,
    sourceObservationId: checkpointState.point?.observation?.id || null,
    metadata: {
      decisionId: decision.id || null,
      mint: decision.mint || null,
      pairAddress: decision.pairAddress || null,
      decisionVersion: decision.decisionVersion || null,
      featureVersion: decision.featureVersion || null
    }
  };
  if (checkpointState.state !== "FOUND") {
    return {
      ...base,
      observedAt: null,
      entryPrice: null,
      exitPrice: null,
      forwardReturnPercent: null,
      mfePercent: null,
      maePercent: null,
      drawdownPercent: null,
      tradabilityState: "UNKNOWN",
      tradabilityReason: checkpointState.censoringReason || "CHECKPOINT_NOT_COMPLETE",
      slippageBps: null,
      feeBps: null,
      executableReturnPercent: null,
      securityStateAtHorizon: "UNKNOWN",
      thesisOutcome: "UNKNOWN",
      catalystOutcome: "UNKNOWN",
      invalidationCodes: []
    };
  }
  const entryPoint = points[0];
  const exitPoint = checkpointState.point;
  const entryPrice = entryPoint.price;
  const exitPrice = exitPoint.price;
  const window = points.filter(point => point.at <= exitPoint.at);
  const returns = window.map(point => ((point.price / entryPrice) - 1) * 100);
  const forwardReturnPercent = ((exitPrice / entryPrice) - 1) * 100;
  const mfePercent = Math.max(...returns);
  const maePercent = Math.min(...returns);
  let peak = entryPrice;
  let drawdownPercent = 0;
  for (const point of window) {
    peak = Math.max(peak, point.price);
    drawdownPercent = Math.min(drawdownPercent, ((point.price / peak) - 1) * 100);
  }
  const execution = executionEvidence(exitPoint.observation);
  const feeBps = execution.feeBps;
  const slippageBps = execution.slippageBps;
  const executableReturnPercent = execution.state === "TRADABLE" && slippageBps != null && feeBps != null
    ? forwardReturnPercent - (slippageBps + feeBps) / 100
    : null;
  return {
    ...base,
    observedAt: new Date(exitPoint.at).toISOString(),
    entryPrice,
    exitPrice,
    forwardReturnPercent: Number(forwardReturnPercent.toFixed(6)),
    mfePercent: Number(mfePercent.toFixed(6)),
    maePercent: Number(maePercent.toFixed(6)),
    drawdownPercent: Number(drawdownPercent.toFixed(6)),
    tradabilityState: execution.state,
    tradabilityReason: execution.reason,
    slippageBps,
    feeBps,
    executableReturnPercent: executableReturnPercent == null ? null : Number(executableReturnPercent.toFixed(6)),
    securityStateAtHorizon: securityState(exitPoint.observation),
    thesisOutcome: thesisOutcome(decision.scorecard, { ...checkpointState, forwardReturnPercent, maePercent }, exitPoint.observation),
    catalystOutcome: catalystOutcome(exitPoint.observation),
    invalidationCodes: invalidationCodes(exitPoint.observation, execution)
  };
}

function labelDecision(decision, observations, asOf = Date.now(), config = LABEL_CONFIG) {
  return CHECKPOINTS
    .map(checkpoint => labelDecisionAtCheckpoint(decision, observations, checkpoint, asOf, config))
    .filter(label => label.completionState !== "NOT_DUE");
}

module.exports = {
  OUTCOME_VERSION,
  CHECKPOINTS,
  LABEL_CONFIG,
  TARGET_CONFIG_HASH,
  LOSS_LIMIT_CONFIG_HASH,
  labelDecisionAtCheckpoint,
  labelDecision
};