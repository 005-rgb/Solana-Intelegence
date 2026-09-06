const test = require("node:test");
const assert = require("node:assert/strict");
const { createSolanaRpcPool } = require("../solana-rpc-pool");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("RPC pool fails over from HTTP 429 and records provider telemetry", async () => {
  const calls = [];
  const pool = createSolanaRpcPool({
    endpoints: [
      { url: "https://helius.test/rpc", provider: "HELIUS" },
      { url: "https://zan.test/rpc", provider: "ZAN" }
    ],
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes("helius")) return new Response("", { status: 429, headers: { "Retry-After": "0" } });
      return jsonResponse({ jsonrpc: "2.0", id: "ignored", result: { slot: 123 } });
    },
    maxAttemptsPerEndpoint: 1,
    failureThreshold: 1,
    retryBaseMs: 0,
    cooldownMs: 1_000
  });

  const result = await pool.request("getHealth", []);
  const summary = pool.summary();

  assert.deepEqual(result, { slot: 123 });
  assert.deepEqual(calls, ["https://helius.test/rpc", "https://zan.test/rpc"]);
  assert.equal(summary.endpoints[0].rateLimited, 1);
  assert.equal(summary.endpoints[0].circuitOpen, true);
  assert.equal(summary.endpoints[0].failovers, 1);
  assert.equal(summary.endpoints[1].successes, 1);
  assert.equal(summary.endpoints[1].circuitOpen, false);
});

test("RPC pool fails over from retryable JSON-RPC batch quota errors", async () => {
  const calls = [];
  const requests = [
    { jsonrpc: "2.0", id: "one", method: "getHealth", params: [] },
    { jsonrpc: "2.0", id: "two", method: "getEpochInfo", params: [] }
  ];
  const pool = createSolanaRpcPool({
    endpoints: [
      { url: "https://primary.test/rpc", provider: "PRIMARY" },
      { url: "https://secondary.test/rpc", provider: "SECONDARY" }
    ],
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes("primary")) {
        return jsonResponse(requests.map(request => ({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32005, message: "Rate limit exceeded" }
        })));
      }
      return jsonResponse(requests.map(request => ({
        jsonrpc: "2.0",
        id: request.id,
        result: { ok: true }
      })));
    },
    maxAttemptsPerEndpoint: 1,
    failureThreshold: 1,
    retryBaseMs: 0
  });

  const result = await pool.batch(requests);
  const summary = pool.summary();

  assert.equal(result.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, requests);
  assert.equal(summary.endpoints[0].rateLimited, 1);
  assert.equal(summary.endpoints[0].lastFailureKind, "rate_limited");
  assert.equal(summary.endpoints[1].successes, 1);
});