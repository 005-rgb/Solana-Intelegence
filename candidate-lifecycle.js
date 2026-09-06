const RESEARCH_STATES = Object.freeze([
  "OBSERVED",
  "WATCH",
  "QUALIFYING",
  "ACTIONABLE_RESEARCH",
  "STALE",
  "REJECTED",
  "INVALIDATED"
]);

const SIGNAL_STATES = Object.freeze([
  "NO_SIGNAL",
  "WATCH",
  "VALIDATING",
  "EARLY",
  "CONFIRMED",
  "STRONG",
  "DEVELOPING",
  "MATURE",
  "WEAKENING",
  "INVALIDATED"
]);

const ENTRY_STATES = Object.freeze([
  "NO_ENTRY",
  "EARLY_ENTRY",
  "ACCEPTABLE_ENTRY",
  "EXTENDED",
  "CHASE_RISK",
  "EXIT_RESEARCH"
]);

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const MATERIAL_SCORE_DELTA = 10;
const STALE_MARKET_DATA_MS = 5 * 60 * 1000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scorecardFor(candidate) {
  return candidate?.details?.scorecard || {};
}

function securityFor(candidate) {
  return candidate?.details?.security || {};
}

function marketFor(candidate) {
  return candidate?.details?.marketQuality || {};
}

function isStale(candidate) {
  const market = marketFor(candidate);
  const quality = String(candidate?.dataQuality || "").toUpperCase();
  if (market.status === "STALE" || market.qualityStatus === "STALE" || quality === "STALE") return true;
  const age = finite(market.metrics?.marketDataAgeMs);
  return age != null && age > STALE_MARKET_DATA_MS;
}

function isInvalidated(candidate) {
  const security = securityFor(candidate);
  return ["REJECTED", "INVALID", "UNVERIFIED"].includes(String(security.status || "").toUpperCase());
}

function researchState(candidate, previousState) {
  if (isInvalidated(candidate)) {
    return previousState && previousState !== "OBSERVED" ? "INVALIDATED" : "REJECTED";
  }
  if (isStale(candidate)) return "STALE";
  const scorecard = scorecardFor(candidate);
  const qualifying = scorecard.eligibility?.qualifying === true || scorecard.decisionState === "QUALIFYING";
  if (qualifying && candidate?.details?.executionSafety?.status === "ACTIONABLE_RESEARCH") {
    return "ACTIONABLE_RESEARCH";
  }
  if (qualifying) return "QUALIFYING";
  return "WATCH";
}

function signalState(state) {
  if (["INVALIDATED", "REJECTED"].includes(state)) return "INVALIDATED";
  if (state === "STALE") return "WEAKENING";
  if (state === "ACTIONABLE_RESEARCH") return "CONFIRMED";
  if (state === "QUALIFYING") return "VALIDATING";
  return "WATCH";
}

function projectState(candidate) {
  const classification = String(candidate?.details?.projectTraction?.classification || "").toUpperCase();
  if (classification === "REAL_PROJECT") return "ACTIVE";
  if (classification === "FAKE_OR_SUSPICIOUS") return "DECLINING";
  if (classification === "UNVERIFIED" || !classification) return "UNVERIFIED";
  return "EMERGING";
}

function entryState(candidate, state) {
  if (["INVALIDATED", "REJECTED", "STALE"].includes(state)) return "EXIT_RESEARCH";
  const scorecard = scorecardFor(candidate);
  const entry = finite(scorecard.components?.entryQuality);
  const chase = finite(scorecard.components?.chaseRisk);
  if (chase != null && chase >= 80) return "CHASE_RISK";
  if (entry != null && entry >= 60) return "ACCEPTABLE_ENTRY";
  if (entry != null && entry >= 35) return "EARLY_ENTRY";
  return "NO_ENTRY";
}

function decisionVersion(candidate) {
  const scorecard = scorecardFor(candidate);
  return scorecard.decisionVersion || scorecard.version || "unknown";
}

function eventFor(change, candidate, now) {
  const symbol = candidate.symbol || candidate.mint;
  const scorecard = scorecardFor(candidate);
  const state = change.toState;
  const previous = change.fromState;
  const security = securityFor(candidate);
  const market = marketFor(candidate);
  let eventType = null;
  let tone = "blue";
  let text = "";

  if (change.transition) {
    if (previous === "INVALIDATED" || previous === "STALE") {
      eventType = "CANDIDATE_REQUALIFIED";
      tone = "green";
      text = `${symbol} requalified from ${previous} to ${state}. This is a new research event, not a restored alert.`;
    } else if (state === "INVALIDATED" || state === "REJECTED") {
      eventType = "CANDIDATE_INVALIDATED";
      tone = "red";
      text = `${symbol} was invalidated. ${security.reasons?.[0] || scorecard.scoreWarnings?.[0] || "A blocking safety condition is present."}`;
    } else if (state === "STALE") {
      eventType = "CANDIDATE_STALE";
      tone = "yellow";
      text = `${symbol} became stale and its prior opportunity alert is superseded. Refresh evidence before review.`;
    } else if (state === "QUALIFYING" || state === "ACTIONABLE_RESEARCH") {
      eventType = "CANDIDATE_QUALIFYING";
      tone = "green";
      text = `${symbol} entered ${state}. Review the immutable decision snapshot and negative evidence before treating it as research-actionable.`;
    }
  } else if (change.materialReason) {
    eventType = change.materialReason.type;
    tone = change.materialReason.tone;
    text = `${symbol}: ${change.materialReason.text}`;
  }
  if (!eventType) return null;

  const cooldownBucket = Math.floor(now / ALERT_COOLDOWN_MS);
  return {
    eventType,
    type: eventType,
    token: symbol,
    tone,
    text,
    time: new Date(now).toISOString(),
    status: state === "INVALIDATED" || state === "REJECTED"
      ? "INVALIDATED"
      : state === "STALE" ? "STALE" : "OPEN",
    dedupeKey: `${candidate.mint}:${eventType}:${decisionVersion(candidate)}:${cooldownBucket}`,
    cooldownBucket,
    payload: {
      mint: candidate.mint,
      symbol,
      state,
      previousState: previous,
      decisionVersion: decisionVersion(candidate),
      decisionId: change.decisionId,
      featureSnapshotId: change.featureSnapshotId,
      score: candidate.radar ?? null,
      risk: candidate.risk ?? scorecard.components?.risk ?? null,
      securityState: security.status || "UNKNOWN",
      marketQualityState: market.status || "UNKNOWN",
      reason: change.transitionReason
    }
  };
}

function materialReason(candidate, previous) {
  if (!previous) return null;
  const scorecard = scorecardFor(candidate);
  const previousScore = finite(previous.lastScore);
  const currentScore = finite(candidate.radar);
  if (previousScore != null && currentScore != null && Math.abs(currentScore - previousScore) >= MATERIAL_SCORE_DELTA) {
    return {
      type: "CANDIDATE_SCORE_CHANGE",
      tone: currentScore > previousScore ? "green" : "yellow",
      text: `material score change ${previousScore} → ${currentScore}; review the updated evidence lineage.`
    };
  }
  const currentSecurity = String(securityFor(candidate).status || "UNKNOWN");
  if (previous.securityState && previous.securityState !== currentSecurity) {
    return {
      type: "CANDIDATE_SECURITY_CHANGE",
      tone: ["REJECTED", "INVALID", "UNVERIFIED"].includes(currentSecurity) ? "red" : "yellow",
      text: `security state changed ${previous.securityState} → ${currentSecurity}.`
    };
  }
  const currentMarket = String(marketFor(candidate).status || "UNKNOWN");
  if (previous.marketQualityState && previous.marketQualityState !== currentMarket
    && ["FAILED", "REJECTED", "STALE", "UNKNOWN"].includes(currentMarket)) {
    return {
      type: "CANDIDATE_LIQUIDITY_DETERIORATION",
      tone: "red",
      text: `market-quality state changed ${previous.marketQualityState} → ${currentMarket}.`
    };
  }
  const currentThesis = scorecard.phase4a?.thesis?.state || null;
  if (previous.thesisState && currentThesis && previous.thesisState !== currentThesis) {
    return {
      type: "CANDIDATE_THESIS_CHANGE",
      tone: currentThesis === "THESIS_CONFLICT" ? "red" : "yellow",
      text: `thesis state changed ${previous.thesisState} → ${currentThesis}.`
    };
  }
  return null;
}

function deriveCandidateLifecycle(candidate, previous = null, now = Date.now()) {
  if (!candidate?.mint) throw new Error("Candidate lifecycle requires a mint.");
  const fromState = previous?.currentState || "OBSERVED";
  const toState = researchState(candidate, previous?.currentState);
  const scorecard = scorecardFor(candidate);
  const decisionId = candidate.details?.decisionSnapshotId || null;
  const featureSnapshotId = candidate.details?.featureSnapshot?.id || null;
  const transition = fromState !== toState ? {
    fromState,
    toState,
    transitionReason: isInvalidated(candidate)
      ? "SECURITY_OR_IDENTITY_INVALIDATED"
      : isStale(candidate)
        ? "MARKET_EVIDENCE_STALE"
        : toState === "ACTIONABLE_RESEARCH"
          ? "QUALIFIED_WITH_EXECUTION_SAFETY"
          : toState === "QUALIFYING"
            ? "SCORECARD_QUALIFYING"
            : previous?.currentState === "INVALIDATED" || previous?.currentState === "STALE"
              ? "REQUALIFIED_AFTER_REFRESH"
              : "INITIAL_RESEARCH_STATE",
    occurredAt: new Date(now).toISOString()
  } : null;
  const change = {
    mint: candidate.mint,
    fromState,
    toState,
    transition,
    transitionReason: transition?.transitionReason || "NO_STATE_CHANGE",
    decisionId,
    featureSnapshotId,
    decisionVersion: decisionVersion(candidate),
    cooldownBucket: Math.floor(now / ALERT_COOLDOWN_MS),
    currentState: toState,
    signalState: signalState(toState),
    projectState: projectState(candidate),
    entryState: entryState(candidate, toState),
    decisionSnapshotId: decisionId,
    featureSnapshotId,
    lastScore: finite(candidate.radar),
    riskScore: finite(candidate.risk ?? scorecard.components?.risk),
    securityState: String(securityFor(candidate).status || "UNKNOWN"),
    marketQualityState: String(marketFor(candidate).status || "UNKNOWN"),
    thesisState: scorecard.phase4a?.thesis?.state || null,
    observedAt: new Date(timestampMs(candidate.details?.observedAt || candidate.updatedAt, now)).toISOString(),
    payload: {
      symbol: candidate.symbol || null,
      name: candidate.name || null,
      decisionVersion: decisionVersion(candidate),
      scorecard
    }
  };
  change.materialReason = transition ? null : materialReason(candidate, previous);
  change.alert = eventFor(change, candidate, now);
  return change;
}

module.exports = {
  RESEARCH_STATES,
  SIGNAL_STATES,
  ENTRY_STATES,
  ALERT_COOLDOWN_MS,
  MATERIAL_SCORE_DELTA,
  deriveCandidateLifecycle
};