"use strict";

const crypto = require("crypto");

function normalize(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.keys(value).sort().reduce((out, key) => {
      out[String(key)] = normalize(value[key]);
      return out;
    }, {});
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return String(value);
}

function normalizedEndpoint(endpoint) {
  try {
    const url = new URL(String(endpoint));
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    return `${url.toString()}${params.length ? `?${new URLSearchParams(params).toString()}` : ""}`;
  } catch {
    return String(endpoint || "");
  }
}

function stableJson(value) {
  return JSON.stringify(normalize(value));
}

function buildCacheKey({
  providerId,
  capability,
  chain = null,
  entityType = null,
  entityId = null,
  endpoint = null,
  params = null,
  commitment = null,
  slotBucket = null,
  requestBody = null
} = {}) {
  const input = {
    provider: String(providerId || "unknown").toLowerCase(),
    capability: String(capability || "DEFAULT").toUpperCase(),
    chain: chain == null ? null : String(chain).toLowerCase(),
    entityType: entityType == null ? null : String(entityType),
    entityId: entityId == null ? null : String(entityId),
    endpoint: endpoint == null ? null : normalizedEndpoint(endpoint),
    params: normalize(params),
    commitment: commitment == null ? null : String(commitment),
    slotBucket: slotBucket == null ? null : String(slotBucket),
    requestBody: normalize(requestBody)
  };
  const digest = crypto.createHash("sha256").update(stableJson(input)).digest("hex");
  return `m2:${input.provider}:${input.capability}:${digest}`;
}

module.exports = { buildCacheKey, normalize, normalizedEndpoint, stableJson };