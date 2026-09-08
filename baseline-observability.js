"use strict";

const MAX_LATENCY_SAMPLES = 512;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quantile(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[index];
}

function createBaselineObservability({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const providerRequests = {
    total: 0,
    retries: 0,
    byStatus: {},
    byProviderCapability: {},
    latencySamples: []
  };
  const scans = {
    started: 0,
    completed: 0,
    byStatus: {},
    durationSamples: [],
    providerFreshnessSamples: [],
    rpcFreshnessSamples: []
  };
  let lastSuccessfulScanAt = null;

  function count(target, key) {
    const normalized = String(key || "UNKNOWN").slice(0, 80);
    target[normalized] = (target[normalized] || 0) + 1;
  }

  function boundedSample(target, value) {
    const number = finiteNumber(value);
    if (number == null || number < 0) return;
    target.push(Math.round(number));
    if (target.length > MAX_LATENCY_SAMPLES) target.shift();
  }

  function recordProviderRequest(event = {}) {
    providerRequests.total += 1;
    count(providerRequests.byStatus, event.status);
    count(providerRequests.byProviderCapability, `${event.providerId || "unknown"}:${event.capability || "DEFAULT"}`);
    const attempt = Math.max(0, Number.parseInt(event.attempt, 10) || 0);
    if (attempt > 1) providerRequests.retries += attempt - 1;
    boundedSample(providerRequests.latencySamples, event.latencyMs);
  }

  function recordScanStarted() {
    scans.started += 1;
  }

  function recordScanOutcome({
    status,
    durationMs,
    providerFreshnessMs,
    rpcFreshnessMs,
    finishedAt = now()
  } = {}) {
    const normalizedStatus = String(status || "UNKNOWN").slice(0, 40);
    scans.completed += 1;
    count(scans.byStatus, normalizedStatus);
    boundedSample(scans.durationSamples, durationMs);
    boundedSample(scans.providerFreshnessSamples, providerFreshnessMs);
    boundedSample(scans.rpcFreshnessSamples, rpcFreshnessMs);
    if (normalizedStatus === "SUCCESS") {
      lastSuccessfulScanAt = finishedAt instanceof Date ? finishedAt.getTime() : finiteNumber(finishedAt) || now();
    }
  }

  function seedLastKnownGood(value) {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) lastSuccessfulScanAt = timestamp;
  }

  function snapshot(at = now()) {
    const generatedAt = Number.isFinite(Number(at)) ? Number(at) : now();
    const lastKnownGoodAgeMs = lastSuccessfulScanAt == null
      ? null
      : Math.max(0, generatedAt - lastSuccessfulScanAt);
    return {
      version: "m0-observability-v1",
      generatedAt: new Date(generatedAt).toISOString(),
      process: {
        startedAt: new Date(startedAt).toISOString(),
        uptimeMs: Math.max(0, generatedAt - startedAt)
      },
      provider: {
        requests: providerRequests.total,
        retries: providerRequests.retries,
        byStatus: { ...providerRequests.byStatus },
        byProviderCapability: { ...providerRequests.byProviderCapability },
        latencyMs: {
          sampleSize: providerRequests.latencySamples.length,
          p50: quantile(providerRequests.latencySamples, 0.5),
          p95: quantile(providerRequests.latencySamples, 0.95),
          max: providerRequests.latencySamples.length ? Math.max(...providerRequests.latencySamples) : null
        }
      },
      scan: {
        started: scans.started,
        completed: scans.completed,
        byStatus: { ...scans.byStatus },
        durationMs: {
          sampleSize: scans.durationSamples.length,
          p50: quantile(scans.durationSamples, 0.5),
          p95: quantile(scans.durationSamples, 0.95),
          max: scans.durationSamples.length ? Math.max(...scans.durationSamples) : null
        }
      },
      cache: {
        enabled: false,
        status: "NOT_IMPLEMENTED",
        hits: 0,
        misses: 0
      },
      queue: {
        enabled: false,
        status: "NOT_IMPLEMENTED",
        queued: 0,
        running: 0,
        deferred: 0,
        failed: 0,
        deadLettered: 0
      },
      freshness: {
        providerMs: {
          sampleSize: scans.providerFreshnessSamples.length,
          p50: quantile(scans.providerFreshnessSamples, 0.5),
          p95: quantile(scans.providerFreshnessSamples, 0.95)
        },
        rpcMs: {
          sampleSize: scans.rpcFreshnessSamples.length,
          p50: quantile(scans.rpcFreshnessSamples, 0.5),
          p95: quantile(scans.rpcFreshnessSamples, 0.95)
        },
        lastKnownGoodAgeMs
      }
    };
  }

  return {
    recordProviderRequest,
    recordScanStarted,
    recordScanOutcome,
    seedLastKnownGood,
    snapshot
  };
}

module.exports = { createBaselineObservability };