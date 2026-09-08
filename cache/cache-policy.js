"use strict";

const CACHE_STATUSES = Object.freeze({
  FRESH: "FRESH",
  STALE_BUT_USABLE: "STALE_BUT_USABLE",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN"
});

const DEFAULT_POLICY = Object.freeze({
  freshMs: 2 * 60 * 1000,
  staleMs: 10 * 60 * 1000
});

const POLICIES = Object.freeze({
  DISCOVERY: { freshMs: 2 * 60 * 1000, staleMs: 10 * 60 * 1000 },
  PAIR_MARKET: { freshMs: 15 * 1000, staleMs: 60 * 1000 },
  PAIR_CANDIDATE: { freshMs: 15 * 1000, staleMs: 60 * 1000 },
  TOKEN_METADATA: { freshMs: 6 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 },
  MINT_ACCOUNT: { freshMs: 30 * 60 * 1000, staleMs: 2 * 60 * 60 * 1000 },
  SUPPLY: { freshMs: 10 * 60 * 1000, staleMs: 30 * 60 * 1000 },
  LARGEST_ACCOUNTS: { freshMs: 10 * 60 * 1000, staleMs: 30 * 60 * 1000 },
  TAXONOMY: { freshMs: 30 * 60 * 1000, staleMs: 2 * 60 * 60 * 1000 },
  EXECUTION_QUOTE: { freshMs: 5 * 1000, staleMs: 15 * 1000 },
  PROJECT_EVIDENCE: { freshMs: 6 * 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 }
});

function policyFor(capability, overrides = {}) {
  const base = POLICIES[String(capability || "").toUpperCase()] || DEFAULT_POLICY;
  const override = overrides[String(capability || "").toUpperCase()] || {};
  return {
    freshMs: Math.max(0, Number(override.freshMs ?? base.freshMs)),
    staleMs: Math.max(0, Number(override.staleMs ?? base.staleMs)),
    version: String(override.version || "m2-cache-policy-v1")
  };
}

function cacheStatus(entry, at = Date.now()) {
  if (!entry) return CACHE_STATUSES.UNKNOWN;
  if (entry.status === CACHE_STATUSES.FAILED) {
    return Number(entry.failedUntil) > at ? CACHE_STATUSES.FAILED : CACHE_STATUSES.EXPIRED;
  }
  if (entry.status === CACHE_STATUSES.UNKNOWN) return CACHE_STATUSES.UNKNOWN;
  if (Number(entry.expiresAt) > at) return CACHE_STATUSES.FRESH;
  if (Number(entry.staleUntil) > at) return CACHE_STATUSES.STALE_BUT_USABLE;
  return CACHE_STATUSES.EXPIRED;
}

module.exports = { CACHE_STATUSES, DEFAULT_POLICY, POLICIES, policyFor, cacheStatus };