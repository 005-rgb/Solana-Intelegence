"use strict";

const crypto = require("crypto");
const { CACHE_STATUSES, cacheStatus, policyFor } = require("./cache-policy");

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function abortError() {
  const error = new Error("Cache caller aborted.");
  error.code = "REQUEST_ABORTED";
  return error;
}

function awaitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function createProviderCache({
  now = () => Date.now(),
  store = null,
  policies = {},
  failedTtlMs = 10_000,
  maxEntries = 2_000,
  onEvent = null
} = {}) {
  const entries = new Map();
  const running = new Map();
  const counters = { hits: 0, misses: 0, staleHits: 0, failures: 0, coalesced: 0, writes: 0 };

  function emit(event) {
    try {
      onEvent?.({ ...event });
    } catch {
      // Cache telemetry must not affect provider behavior.
    }
  }

  function keyOf(input) {
    return typeof input === "string" ? input : input?.cacheKey;
  }

  function trim() {
    while (entries.size > maxEntries) {
      const first = entries.keys().next().value;
      if (first === undefined) break;
      entries.delete(first);
    }
  }

  async function read(cacheKey) {
    if (!cacheKey) return null;
    let entry = entries.get(cacheKey) || null;
    if (!entry && store?.get) {
      try {
        entry = await store.get(cacheKey);
        if (entry) entries.set(cacheKey, entry);
      } catch (error) {
        emit({ type: "storage_error", operation: "get", error: error.message });
      }
    }
    return entry ? { ...entry, payload: clone(entry.payload) } : null;
  }

  function status(entry) {
    return cacheStatus(entry, now());
  }

  async function get(input, { allowStale = true } = {}) {
    const cacheKey = keyOf(input);
    const entry = await read(cacheKey);
    const currentStatus = status(entry);
    if (currentStatus === CACHE_STATUSES.FRESH ||
        (allowStale && currentStatus === CACHE_STATUSES.STALE_BUT_USABLE) ||
        currentStatus === CACHE_STATUSES.FAILED) {
      counters.hits += 1;
      if (currentStatus === CACHE_STATUSES.STALE_BUT_USABLE) counters.staleHits += 1;
      emit({ type: "hit", cacheKey, status: currentStatus });
      return { ...entry, status: currentStatus };
    }
    counters.misses += 1;
    if (entry && currentStatus !== CACHE_STATUSES.UNKNOWN) emit({ type: "miss", cacheKey, status: currentStatus });
    return null;
  }

  async function persist(entry) {
    entries.set(entry.cacheKey, entry);
    trim();
    counters.writes += 1;
    if (store?.set) {
      try {
        await store.set(entry);
      } catch (error) {
        emit({ type: "storage_error", operation: "set", error: error.message });
      }
    }
    return entry;
  }

  async function set(input, payload, metadata = {}) {
    const cacheKey = keyOf(input);
    if (!cacheKey) throw new Error("cacheKey is required.");
    const policy = policyFor(metadata.capability || input?.capability, policies);
    const at = now();
    const sourceObservedAt = metadata.sourceObservedAt == null ? at : Number(metadata.sourceObservedAt);
    const existing = await read(cacheKey);
    const existingStatus = status(existing);
    const existingObservedAt = existing?.sourceObservedAt == null ? null : Number(existing.sourceObservedAt);
    if (existing && existingStatus !== CACHE_STATUSES.FAILED &&
        existingObservedAt != null && Number.isFinite(sourceObservedAt) &&
        sourceObservedAt < existingObservedAt) {
      emit({ type: "write_skipped_older", cacheKey });
      return { ...existing, status: existingStatus };
    }
    const value = clone(payload);
    const entry = {
      cacheKey,
      providerId: metadata.providerId || input?.providerId || "unknown",
      capability: metadata.capability || input?.capability || "DEFAULT",
      chain: metadata.chain || input?.chain || null,
      entityType: metadata.entityType || input?.entityType || null,
      entityId: metadata.entityId || input?.entityId || null,
      requestParams: clone(metadata.requestParams || input?.params || null),
      payload: value,
      payloadHash: metadata.payloadHash || crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      sourceObservedAt: Number.isFinite(sourceObservedAt) ? sourceObservedAt : null,
      cachedAt: at,
      expiresAt: at + policy.freshMs,
      staleUntil: at + policy.freshMs + policy.staleMs,
      status: CACHE_STATUSES.FRESH,
      sourceRequestId: metadata.sourceRequestId || null,
      responseHash: metadata.responseHash || null,
      slot: metadata.slot == null ? null : String(metadata.slot),
      schemaVersion: metadata.schemaVersion || null,
      configHash: metadata.configHash || policy.version
    };
    return persist(entry);
  }

  async function setFailure(input, error, metadata = {}) {
    const cacheKey = keyOf(input);
    if (!cacheKey) return null;
    const at = now();
    const previous = await read(cacheKey);
    const entry = {
      cacheKey,
      providerId: metadata.providerId || input?.providerId || "unknown",
      capability: metadata.capability || input?.capability || "DEFAULT",
      cachedAt: at,
      failedUntil: at + Math.max(0, Number(metadata.failedTtlMs ?? failedTtlMs)),
      staleUntil: at + Math.max(0, Number(metadata.failedTtlMs ?? failedTtlMs)),
      expiresAt: at,
      status: CACHE_STATUSES.FAILED,
      errorCode: error?.code || "UNKNOWN_PROVIDER_ERROR",
      errorMessage: String(error?.message || error || "Provider request failed.").slice(0, 240),
      payload: previous?.payload ?? null,
      sourceObservedAt: previous?.sourceObservedAt ?? null,
      sourceRequestId: previous?.sourceRequestId ?? null,
      responseHash: previous?.responseHash ?? null,
      payloadHash: previous?.payloadHash ?? null,
      requestParams: previous?.requestParams ?? null,
      chain: previous?.chain ?? null,
      entityType: previous?.entityType ?? null,
      entityId: previous?.entityId ?? null
    };
    counters.failures += 1;
    emit({ type: "failure", cacheKey, status: CACHE_STATUSES.FAILED, errorCode: entry.errorCode });
    return persist(entry);
  }

  async function getOrFetch(input, {
    fetch,
    signal = null,
    allowStale = true,
    metadata = {}
  } = {}) {
    if (typeof fetch !== "function") throw new Error("fetch function is required.");
    const cacheKey = keyOf(input);
    const cached = await get(cacheKey, { allowStale });
    if (cached && cached.status === CACHE_STATUSES.FRESH) {
      return { value: clone(cached.payload), cacheStatus: cached.status, cacheHit: true, entry: cached };
    }
    if (cached && cached.status === CACHE_STATUSES.FAILED) {
      if (cached.payload && allowStale) {
        return {
          value: clone(cached.payload),
          cacheStatus: CACHE_STATUSES.FAILED,
          cacheHit: true,
          staleFallback: true,
          entry: cached,
          error: Object.assign(new Error(cached.errorMessage || "Provider request is temporarily unavailable."), { code: cached.errorCode })
        };
      }
      throw Object.assign(new Error(cached.errorMessage || "Provider request is temporarily unavailable."), { code: cached.errorCode });
    }
    const stale = cached?.status === CACHE_STATUSES.STALE_BUT_USABLE ? cached : null;
    let shared = running.get(cacheKey);
    if (!shared) {
      const ownerPromise = (async () => {
        try {
          const value = await fetch();
          const entry = await set(input, value, metadata);
          return { value: clone(value), cacheStatus: entry.status, cacheHit: false, entry };
        } catch (error) {
          await setFailure(input, error, metadata);
          if (stale) {
            emit({ type: "stale_fallback", cacheKey });
            return { value: clone(stale.payload), cacheStatus: CACHE_STATUSES.STALE_BUT_USABLE, cacheHit: true, staleFallback: true, entry: stale, error };
          }
          throw error;
        }
      })();
      shared = { promise: ownerPromise };
      running.set(cacheKey, shared);
      ownerPromise.finally(() => {
        if (running.get(cacheKey) === shared) running.delete(cacheKey);
      }).catch(() => {});
    } else {
      counters.coalesced += 1;
      emit({ type: "coalesced", cacheKey });
    }
    return await awaitWithAbort(shared.promise, signal);
  }

  function stats() {
    return {
      enabled: true,
      status: "ACTIVE",
      entries: entries.size,
      running: running.size,
      ...counters,
      hitRatio: counters.hits + counters.misses ? counters.hits / (counters.hits + counters.misses) : null,
      staleRatio: counters.hits ? counters.staleHits / counters.hits : 0
    };
  }

  return {
    get,
    set,
    setFailure,
    getOrFetch,
    stats,
    clear: () => entries.clear(),
    running
  };
}

module.exports = { createProviderCache, awaitWithAbort };