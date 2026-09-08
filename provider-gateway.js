const crypto = require("crypto");
const { URL } = require("url");

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;
const DEFAULT_JITTER_MS = 250;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_CAPACITY = 120;
const DEFAULT_REFILL_PER_MINUTE = 120;
const DEFAULT_RESERVED_CAPACITY = 10;
const DEFAULT_MAX_CONCURRENCY = 4;

class ProviderGatewayError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ProviderGatewayError";
    this.code = code;
    Object.assign(this, details);
  }
}

function endpointLabel(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid-endpoint";
  }
}

function errorCode(error) {
  return error?.code || "UNKNOWN_PROVIDER_ERROR";
}

function retryAfterMs(response, fallbackMs, maxMs) {
  const header = response?.headers?.get("retry-after");
  if (header != null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxMs, seconds * 1_000);
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) return Math.min(maxMs, Math.max(0, dateMs - Date.now()));
  }
  return Math.min(maxMs, fallbackMs);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (!signal) return;
    const abort = () => {
      clearTimeout(timer);
      reject(new ProviderGatewayError("Provider request aborted.", "REQUEST_ABORTED"));
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}

function requestHash({ method, endpoint, headers, body }) {
  const safeHeaders = Object.keys(headers || {})
    .filter(key => key.toLowerCase() !== "authorization" && key.toLowerCase() !== "cookie")
    .sort()
    .map(key => `${key.toLowerCase()}:${String(headers[key])}`)
    .join("|");
  return crypto.createHash("sha256")
    .update(JSON.stringify({ method, endpoint: endpointLabel(endpoint), headers: safeHeaders, body: body || null }))
    .digest("hex");
}

function createProviderGateway({
  providers = {},
  fetchImpl = globalThis.fetch,
  onRequest = null,
  now = () => Date.now(),
  random = Math.random,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  defaultMaxAttempts = DEFAULT_MAX_ATTEMPTS,
  defaultRetryBaseMs = DEFAULT_RETRY_BASE_MS,
  defaultRetryMaxMs = DEFAULT_RETRY_MAX_MS,
  defaultJitterMs = DEFAULT_JITTER_MS,
  defaultFailureThreshold = DEFAULT_FAILURE_THRESHOLD,
  defaultCooldownMs = DEFAULT_COOLDOWN_MS
} = {}) {
  const normalizedProviders = new Map(Object.entries(providers).map(([providerId, config]) => [
    providerId,
    {
      capacity: Number(config.capacity ?? DEFAULT_CAPACITY),
      refillPerMinute: Number(config.refillPerMinute ?? DEFAULT_REFILL_PER_MINUTE),
      reservedCapacity: Number(config.reservedCapacity ?? DEFAULT_RESERVED_CAPACITY),
      maxConcurrency: Math.max(1, Number(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)),
      failureThreshold: Math.max(1, Number(config.failureThreshold ?? defaultFailureThreshold)),
      cooldownMs: Math.max(1, Number(config.cooldownMs ?? defaultCooldownMs)),
      maxAttempts: Math.max(1, Number(config.maxAttempts ?? defaultMaxAttempts)),
      timeoutMs: Math.max(1, Number(config.timeoutMs ?? defaultTimeoutMs)),
      retryBaseMs: Math.max(0, Number(config.retryBaseMs ?? defaultRetryBaseMs)),
      retryMaxMs: Math.max(0, Number(config.retryMaxMs ?? defaultRetryMaxMs)),
      jitterMs: Math.max(0, Number(config.jitterMs ?? defaultJitterMs)),
      ...config
    }
  ]));
  const health = new Map();
  const buckets = new Map();
  const semaphores = new Map();

  function configFor(providerId) {
    return normalizedProviders.get(providerId) || {
      capacity: DEFAULT_CAPACITY,
      refillPerMinute: DEFAULT_REFILL_PER_MINUTE,
      reservedCapacity: DEFAULT_RESERVED_CAPACITY,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      failureThreshold: defaultFailureThreshold,
      cooldownMs: defaultCooldownMs,
      maxAttempts: defaultMaxAttempts,
      timeoutMs: defaultTimeoutMs,
      retryBaseMs: defaultRetryBaseMs,
      retryMaxMs: defaultRetryMaxMs,
      jitterMs: defaultJitterMs
    };
  }

  function keyFor(providerId, capability) {
    return `${providerId}:${capability || "DEFAULT"}`;
  }

  function stateFor(providerId, capability, endpoint) {
    const key = `${keyFor(providerId, capability)}:${endpointLabel(endpoint)}`;
    const current = health.get(key) || {
      providerId,
      capability: capability || "DEFAULT",
      endpoint: endpointLabel(endpoint),
      failures: 0,
      attempts: 0,
      successes: 0,
      retries: 0,
      rateLimited: 0,
      timeouts: 0,
      failovers: 0,
      lastStatus: null,
      lastErrorCode: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      openedAt: 0,
      cooldowns: 0,
      recoveries: 0
    };
    if (current.openedAt && now() >= current.openedAt + configFor(providerId).cooldownMs) {
      current.openedAt = 0;
      current.failures = 0;
      current.recoveries += 1;
    }
    health.set(key, current);
    return current;
  }

  function bucketFor(providerId, capability) {
    const key = keyFor(providerId, capability);
    const config = configFor(providerId);
    const current = buckets.get(key) || {
      tokens: Math.max(0, config.capacity),
      lastRefillAt: now()
    };
    const elapsedMs = Math.max(0, now() - current.lastRefillAt);
    current.tokens = Math.min(
      config.capacity,
      current.tokens + elapsedMs * (config.refillPerMinute / 60_000)
    );
    current.lastRefillAt = now();
    buckets.set(key, current);
    return { key, current, config };
  }

  function consumeQuota(providerId, capability, priority) {
    const { current, config } = bucketFor(providerId, capability);
    const floor = priority === "emergency" ? 0 : Math.max(0, config.reservedCapacity);
    if (current.tokens < 1 || current.tokens - 1 < floor) {
      throw new ProviderGatewayError(
        `Provider budget exhausted for ${keyFor(providerId, capability)}.`,
        "BUDGET_EXHAUSTED",
        { providerId, capability, availableTokens: current.tokens }
      );
    }
    current.tokens -= 1;
    return Math.floor(current.tokens);
  }

  async function acquireSlot(providerId, capability) {
    const key = keyFor(providerId, capability);
    const config = configFor(providerId);
    const current = semaphores.get(key) || { active: 0, waiters: [] };
    semaphores.set(key, current);
    if (current.active < config.maxConcurrency) {
      current.active += 1;
      return () => releaseSlot(key, current);
    }
    await new Promise(resolve => current.waiters.push(resolve));
    current.active += 1;
    return () => releaseSlot(key, current);
  }

  function releaseSlot(key, current) {
    current.active = Math.max(0, current.active - 1);
    current.waiters.shift()?.();
    if (!current.active && !current.waiters.length) semaphores.delete(key);
  }

  function emit(event) {
    if (typeof onRequest !== "function") return;
    try {
      const result = onRequest(event);
      if (result?.catch) result.catch(() => {});
    } catch {
      // Telemetry must never change provider behavior.
    }
  }

  function recordFailure(state, status, code) {
    state.failures += 1;
    state.lastStatus = status ?? null;
    state.lastErrorCode = code;
    state.lastFailureAt = new Date(now()).toISOString();
    if (status === 429 || code === "RATE_LIMITED") state.rateLimited += 1;
    if (code === "TIMEOUT") state.timeouts += 1;
    const config = configFor(state.providerId);
    if (state.failures >= config.failureThreshold && !state.openedAt) {
      state.openedAt = now();
      state.cooldowns += 1;
    }
  }

  function recordSuccess(state) {
    state.failures = 0;
    state.lastStatus = null;
    state.lastErrorCode = null;
    state.lastSuccessAt = new Date(now()).toISOString();
    state.successes += 1;
  }

  function classifyHttp(status) {
    if (status === 429) return "RATE_LIMITED";
    if (status >= 500) return "HTTP_5XX";
    if (status >= 400) return "HTTP_4XX";
    return null;
  }

  function retryable(code) {
    return ["RATE_LIMITED", "HTTP_5XX", "TIMEOUT", "NETWORK_ERROR"].includes(code);
  }

  async function request({
    providerId,
    capability = "DEFAULT",
    endpoint,
    method = "GET",
    headers = {},
    body = null,
    signal = null,
    timeoutMs,
    maxAttempts,
    retryBaseMs,
    retryMaxMs,
    jitterMs,
    priority = "normal",
    correlationId = null,
    requestId = crypto.randomUUID(),
    parse = async response => response.json()
  }) {
    if (typeof fetchImpl !== "function") {
      throw new ProviderGatewayError("No fetch implementation is available.", "NETWORK_ERROR");
    }
    if (!providerId || !endpoint) {
      throw new ProviderGatewayError("Provider ID and endpoint are required.", "INVALID_REQUEST");
    }
    const config = configFor(providerId);
    const state = stateFor(providerId, capability, endpoint);
    if (state.openedAt && now() < state.openedAt + config.cooldownMs) {
      emit({
        providerId, capability, endpoint: state.endpoint, requestId, correlationId,
        requestHash: requestHash({ method, endpoint, headers, body }),
        attempt: 0, status: "CIRCUIT_OPEN", errorCode: "CIRCUIT_OPEN",
        startedAt: new Date(now()).toISOString(), completedAt: new Date(now()).toISOString()
      });
      throw new ProviderGatewayError(`Provider circuit open for ${state.endpoint}.`, "CIRCUIT_OPEN", { providerId, capability });
    }
    const release = await acquireSlot(providerId, capability);
    const attemptsLimit = Math.max(1, Number(maxAttempts ?? config.maxAttempts));
    const requestTimeoutMs = Math.max(1, Number(timeoutMs ?? config.timeoutMs));
    const baseMs = Math.max(0, Number(retryBaseMs ?? config.retryBaseMs));
    const retryLimitMs = Math.max(0, Number(retryMaxMs ?? config.retryMaxMs));
    const jitterLimitMs = Math.max(0, Number(jitterMs ?? config.jitterMs));
    const hash = requestHash({ method, endpoint, headers, body });
    let lastError;
    try {
      for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
        const startedAt = now();
        let status = null;
        let eventCode = null;
        let retryAfterDelayMs = null;
        let responseHash = null;
        let responseBytes = null;
        state.attempts += 1;
        try {
          const availableTokens = consumeQuota(providerId, capability, priority);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
          let response;
          try {
            const requestSignal = signal
              ? AbortSignal.any([controller.signal, signal])
              : controller.signal;
            response = await fetchImpl(endpoint, {
              method,
              signal: requestSignal,
              headers,
              ...(body == null ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
            });
            status = response.status;
          } finally {
            clearTimeout(timeout);
          }
          const httpCode = classifyHttp(response.status);
          if (httpCode) {
            eventCode = httpCode;
            const error = new ProviderGatewayError(
              `Provider HTTP ${response.status} at ${state.endpoint}.`,
              httpCode,
              { status: response.status }
            );
            lastError = error;
            recordFailure(state, response.status, httpCode);
            if (attempt < attemptsLimit && retryable(httpCode)) {
              state.retries += 1;
              const exponential = Math.min(retryLimitMs, baseMs * (2 ** (attempt - 1)));
              retryAfterDelayMs = retryAfterMs(response, exponential, retryLimitMs);
              await sleep(retryAfterDelayMs + Math.floor(random() * (jitterLimitMs + 1)), signal);
              continue;
            }
            throw error;
          }
          if (!response.ok) {
            eventCode = "HTTP_4XX";
            const error = new ProviderGatewayError(
              `Provider HTTP ${response.status} at ${state.endpoint}.`,
              "HTTP_4XX",
              { status: response.status }
            );
            lastError = error;
            recordFailure(state, response.status, eventCode);
            throw error;
          }
          try {
            const bytes = Buffer.from(await response.clone().arrayBuffer());
            responseBytes = bytes.length;
            responseHash = crypto.createHash("sha256").update(bytes).digest("hex");
          } catch {
            // Response fingerprinting is best-effort and never blocks parsing.
          }
          const parsed = await parse(response);
          recordSuccess(state);
          return parsed;
        } catch (error) {
          if (signal?.aborted) {
            eventCode = "REQUEST_ABORTED";
            throw new ProviderGatewayError("Provider request aborted.", eventCode);
          }
          if (error instanceof ProviderGatewayError && error.code === "HTTP_4XX") throw error;
          if (error instanceof ProviderGatewayError && ["RATE_LIMITED", "HTTP_5XX"].includes(error.code)) {
            eventCode = error.code;
          } else if (error instanceof ProviderGatewayError && error.code === "SCHEMA_INVALID") {
            eventCode = error.code;
            throw error;
          } else {
            eventCode = error?.name === "AbortError" ? "TIMEOUT" : errorCode(error) === "BUDGET_EXHAUSTED" ? "BUDGET_EXHAUSTED" : "NETWORK_ERROR";
            if (eventCode === "BUDGET_EXHAUSTED") throw error;
            recordFailure(state, error?.status ?? null, eventCode);
            lastError = new ProviderGatewayError(
              eventCode === "TIMEOUT" ? `Provider timeout at ${state.endpoint}.` : `Provider network failure at ${state.endpoint}.`,
              eventCode,
              { cause: error }
            );
          }
          if (attempt >= attemptsLimit || !retryable(eventCode)) throw lastError || error;
          state.retries += 1;
          const exponential = Math.min(retryLimitMs, baseMs * (2 ** (attempt - 1)));
          await sleep(exponential + Math.floor(random() * (jitterLimitMs + 1)), signal);
        } finally {
          emit({
            providerId, capability, endpoint: state.endpoint, requestId, correlationId,
            requestHash: hash, attempt, status: eventCode ? "FAILED" : "SUCCESS",
            httpStatus: status, errorCode: eventCode,
            startedAt: new Date(startedAt).toISOString(), completedAt: new Date(now()).toISOString(),
            latencyMs: Math.max(0, now() - startedAt),
            retryAfterMs: retryAfterDelayMs,
            responseHash,
            responseBytes
          });
        }
      }
    } finally {
      release();
    }
    throw lastError || new ProviderGatewayError("Provider request failed.", "UNKNOWN_PROVIDER_ERROR");
  }

  async function requestJson(options) {
    return request({
      ...options,
      parse: async response => {
        try {
          return await response.json();
        } catch {
          throw new ProviderGatewayError("Provider returned invalid JSON.", "SCHEMA_INVALID");
        }
      }
    });
  }

  function summary() {
    const providerSummary = {};
    for (const state of health.values()) {
      const key = `${state.providerId}:${state.capability}`;
      if (!providerSummary[key]) {
        providerSummary[key] = {
          providerId: state.providerId,
          capability: state.capability,
          endpoints: []
        };
      }
      providerSummary[key].endpoints.push({
        endpoint: state.endpoint,
        failures: state.failures,
        attempts: state.attempts,
        successes: state.successes,
        retries: state.retries,
        rateLimited: state.rateLimited,
        timeouts: state.timeouts,
        circuitOpen: Boolean(state.openedAt),
        cooldownUntil: state.openedAt
          ? new Date(state.openedAt + configFor(state.providerId).cooldownMs).toISOString()
          : null,
        lastStatus: state.lastStatus,
        lastErrorCode: state.lastErrorCode,
        lastFailureAt: state.lastFailureAt,
        lastSuccessAt: state.lastSuccessAt
      });
    }
    const budgets = {};
    for (const [key, bucket] of buckets.entries()) {
      const providerId = key.split(":")[0];
      const config = configFor(providerId);
      budgets[key] = {
        tokens: Math.floor(bucket.tokens),
        capacity: config.capacity,
        refillPerMinute: config.refillPerMinute,
        reservedCapacity: config.reservedCapacity
      };
    }
    return { providers: Object.values(providerSummary), budgets };
  }

  return { request, requestJson, summary };
}

module.exports = {
  ProviderGatewayError,
  createProviderGateway,
  endpointLabel,
  retryAfterMs
};