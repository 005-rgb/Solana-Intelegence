const { URL } = require("url");

const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 5_000;

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid-endpoint";
  }
}

function retryableRpcError(error) {
  const code = Number(error?.code);
  const message = String(error?.message || error || "");
  return [-32004, -32005, -32009].includes(code)
    || /rate.?limit|too many requests|quota|temporar|overload|server busy|try again/i.test(message);
}

function delayMs(response, attempt, retryBaseMs) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(2_000, retryAfter * 1_000)
    : Math.min(2_000, retryBaseMs * (2 ** attempt));
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error("Solana RPC request aborted by scan deadline."));
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Solana RPC request aborted by scan deadline."));
    }, { once: true });
  });
}

function createSolanaRpcPool({
  endpoints = [],
  fetchImpl = globalThis.fetch,
  maxConcurrent = 1,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  maxAttemptsPerEndpoint = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryBaseMs = 250
} = {}) {
  const normalizedEndpoints = endpoints
    .map(endpoint => typeof endpoint === "string" ? { url: endpoint, provider: null } : endpoint)
    .filter(endpoint => endpoint?.url)
    .map(endpoint => ({ url: endpoint.url, provider: endpoint.provider || endpointHost(endpoint.url) }));
  const health = new Map();
  const waiters = [];
  let roundRobin = 0;
  let inFlight = 0;

  function endpointState(endpoint) {
    const current = health.get(endpoint.url) || {
      failures: 0,
      attempts: 0,
      successes: 0,
      rateLimited: 0,
      retries: 0,
      failovers: 0,
      cooldowns: 0,
      recoveries: 0,
      openedAt: 0,
      lastStatus: null,
      lastFailureKind: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastRecoveryAt: null
    };
    if (current.openedAt && Date.now() - current.openedAt >= cooldownMs) {
      current.openedAt = 0;
      current.failures = 0;
      current.recoveries += 1;
      current.lastRecoveryAt = new Date().toISOString();
    }
    health.set(endpoint.url, current);
    return current;
  }

  function recordFailure(endpoint, status, kind) {
    const current = endpointState(endpoint);
    current.attempts += 1;
    current.failures += 1;
    current.lastStatus = status;
    current.lastFailureKind = kind;
    current.lastFailureAt = new Date().toISOString();
    if (kind === "rate_limited" || status === 429) current.rateLimited += 1;
    if (current.failures >= failureThreshold && !current.openedAt) {
      current.openedAt = Date.now();
      current.cooldowns += 1;
    }
  }

  function recordSuccess(endpoint) {
    const current = endpointState(endpoint);
    current.attempts += 1;
    current.successes += 1;
    current.failures = 0;
    current.lastStatus = null;
    current.lastFailureKind = null;
    current.lastSuccessAt = new Date().toISOString();
  }

  function candidates() {
    const healthy = normalizedEndpoints.filter(endpoint => !endpointState(endpoint).openedAt);
    const pool = healthy.length
      ? healthy
      : [...normalizedEndpoints].sort((left, right) => endpointState(left).openedAt - endpointState(right).openedAt).slice(0, 1);
    if (!pool.length) return [];
    const offset = roundRobin++ % pool.length;
    return [...pool.slice(offset), ...pool.slice(0, offset)];
  }

  function recordFailover(from, to) {
    if (from) endpointState(from).failovers += 1;
    return { from: from?.provider || endpointHost(from?.url), to: to.provider || endpointHost(to.url) };
  }

  async function acquireSlot() {
    if (inFlight < maxConcurrent) {
      inFlight += 1;
      return;
    }
    await new Promise(resolve => waiters.push(resolve));
    inFlight += 1;
  }

  function releaseSlot() {
    inFlight -= 1;
    waiters.shift()?.();
  }

  async function execute(requests, signal, isBatch) {
    if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available for Solana RPC.");
    await acquireSlot();
    try {
      let lastError;
      let previous = null;
      const tried = [];
      for (const endpoint of candidates()) {
        if (previous) recordFailover(previous, endpoint);
        previous = endpoint;
        tried.push(endpointHost(endpoint.url));
        for (let attempt = 0; attempt < maxAttemptsPerEndpoint; attempt += 1) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const requestSignal = signal
              ? AbortSignal.any([controller.signal, signal])
              : controller.signal;
            const response = await fetchImpl(endpoint.url, {
              method: "POST",
              signal: requestSignal,
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify(isBatch ? requests : requests[0])
            });
            if (response.status === 429 || response.status >= 500) {
              lastError = new Error(`Solana RPC HTTP ${response.status} at ${endpointHost(endpoint.url)}`);
              lastError.status = response.status;
              recordFailure(endpoint, response.status, response.status === 429 ? "rate_limited" : "server_error");
              if (attempt + 1 < maxAttemptsPerEndpoint) {
                endpointState(endpoint).retries += 1;
                await abortableDelay(delayMs(response, attempt, retryBaseMs), signal);
              }
              continue;
            }
            if (!response.ok) {
              lastError = new Error(`Solana RPC HTTP ${response.status} at ${endpointHost(endpoint.url)}`);
              lastError.status = response.status;
              recordFailure(endpoint, response.status, "http_error");
              break;
            }
            const payload = await response.json();
            if (!isBatch && payload?.error) {
              lastError = new Error(payload.error.message || "Solana RPC request failed");
              lastError.status = payload.error.code || null;
              const rateLimited = retryableRpcError(payload.error);
              recordFailure(endpoint, lastError.status, rateLimited ? "rate_limited" : "rpc_error");
              if (rateLimited && attempt + 1 < maxAttemptsPerEndpoint) {
                endpointState(endpoint).retries += 1;
                await abortableDelay(delayMs(response, attempt, retryBaseMs), signal);
                continue;
              }
              break;
            }
            if (isBatch) {
              if (!Array.isArray(payload)) {
                lastError = new Error(`Solana RPC batch response was invalid at ${endpointHost(endpoint.url)}`);
                recordFailure(endpoint, null, "invalid_response");
                break;
              }
              const expectedIds = new Set(requests.map(request => String(request.id)));
              const responseIds = new Set(payload.map(item => String(item?.id)));
              if (responseIds.size < expectedIds.size || [...expectedIds].some(id => !responseIds.has(id))) {
                lastError = new Error(`Solana RPC batch response was incomplete at ${endpointHost(endpoint.url)}`);
                recordFailure(endpoint, null, "incomplete_response");
                break;
              }
              const quotaError = payload.map(item => item?.error).find(retryableRpcError);
              if (quotaError) {
                lastError = new Error(quotaError.message || "Solana RPC provider rate limit.");
                lastError.status = quotaError.code || null;
                recordFailure(endpoint, lastError.status, "rate_limited");
                if (attempt + 1 < maxAttemptsPerEndpoint) {
                  endpointState(endpoint).retries += 1;
                  await abortableDelay(delayMs(response, attempt, retryBaseMs), signal);
                }
                continue;
              }
            }
            recordSuccess(endpoint);
            return isBatch ? payload : payload.result;
          } catch (error) {
            if (signal?.aborted) throw new Error("Solana RPC request aborted by scan deadline.");
            if (error.name === "AbortError") {
              error.message = `Solana RPC timeout at ${endpointHost(endpoint.url)}`;
            }
            lastError = error;
            recordFailure(endpoint, error.status || null, error.name === "AbortError" ? "timeout" : "network_error");
            if (attempt + 1 < maxAttemptsPerEndpoint) {
              endpointState(endpoint).retries += 1;
              await abortableDelay(retryBaseMs * (2 ** attempt), signal);
            }
          } finally {
            clearTimeout(timeout);
          }
        }
      }
      throw lastError || new Error(`No Solana RPC endpoint responded. Tried: ${tried.join(", ")}`);
    } finally {
      releaseSlot();
    }
  }

  function request(method, params) {
    return execute([{ jsonrpc: "2.0", id: `${Date.now()}:${method}`, method, params }], null, false);
  }

  function batch(requests, signal) {
    return execute(requests, signal, true);
  }

  function summary() {
    return {
      configuredEndpoints: normalizedEndpoints.length,
      endpoints: normalizedEndpoints.map(endpoint => {
        const current = endpointState(endpoint);
        return {
          provider: endpoint.provider,
          endpoint: endpointHost(endpoint.url),
          failures: current.failures,
          attempts: current.attempts,
          successes: current.successes,
          rateLimited: current.rateLimited,
          retries: current.retries,
          failovers: current.failovers,
          cooldowns: current.cooldowns,
          recoveries: current.recoveries,
          circuitOpen: Boolean(current.openedAt),
          cooldownUntil: current.openedAt ? new Date(current.openedAt + cooldownMs).toISOString() : null,
          lastStatus: current.lastStatus,
          lastFailureKind: current.lastFailureKind,
          lastFailureAt: current.lastFailureAt,
          lastSuccessAt: current.lastSuccessAt,
          lastRecoveryAt: current.lastRecoveryAt
        };
      })
    };
  }

  return { request, batch, summary };
}

module.exports = { createSolanaRpcPool, retryableRpcError };