const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderGateway } = require("../provider-gateway");

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

test("provider gateway retries 429 with Retry-After and emits one audit event per attempt", async () => {
  const calls = [];
  const events = [];
  const gateway = createProviderGateway({
    providers: {
      demo: {
        capacity: 10,
        reservedCapacity: 0,
        maxAttempts: 2,
        retryBaseMs: 0,
        retryMaxMs: 0,
        jitterMs: 0
      }
    },
    fetchImpl: async (endpoint, options) => {
      calls.push({ endpoint, options });
      return calls.length === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
        : jsonResponse({ ok: true });
    },
    onRequest: event => events.push(event)
  });

  const result = await gateway.requestJson({
    providerId: "demo",
    capability: "DISCOVERY",
    endpoint: "https://demo.test/feed",
    requestId: "request-1",
    correlationId: "scan-1"
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(events.map(event => event.status), ["FAILED", "SUCCESS"]);
  assert.equal(events[0].errorCode, "RATE_LIMITED");
  assert.equal(events[0].httpStatus, 429);
  assert.equal(events[1].attempt, 2);
  assert.equal(events[0].endpoint, "demo.test");
  assert.equal(events[0].requestId, "request-1");
  assert.match(events[0].requestHash, /^[a-f0-9]{64}$/);
});

test("provider gateway opens a circuit and fails closed without another network call", async () => {
  let calls = 0;
  const gateway = createProviderGateway({
    providers: {
      demo: {
        capacity: 10,
        reservedCapacity: 0,
        maxAttempts: 1,
        failureThreshold: 1,
        cooldownMs: 60_000
      }
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response("", { status: 503 });
    }
  });

  await assert.rejects(
    gateway.requestJson({ providerId: "demo", capability: "PAIR", endpoint: "https://demo.test/pair" }),
    error => error.code === "HTTP_5XX"
  );
  await assert.rejects(
    gateway.requestJson({ providerId: "demo", capability: "PAIR", endpoint: "https://demo.test/pair" }),
    error => error.code === "CIRCUIT_OPEN"
  );
  assert.equal(calls, 1);
  assert.equal(gateway.summary().providers[0].endpoints[0].circuitOpen, true);
});

test("provider gateway enforces normal quota while allowing reserved emergency capacity", async () => {
  const gateway = createProviderGateway({
    providers: {
      demo: {
        capacity: 2,
        reservedCapacity: 1,
        maxAttempts: 1
      }
    },
    fetchImpl: async () => jsonResponse({ ok: true })
  });

  await gateway.requestJson({ providerId: "demo", capability: "DISCOVERY", endpoint: "https://demo.test/a" });
  await assert.rejects(
    gateway.requestJson({ providerId: "demo", capability: "DISCOVERY", endpoint: "https://demo.test/b" }),
    error => error.code === "BUDGET_EXHAUSTED"
  );
  const emergency = await gateway.requestJson({
    providerId: "demo",
    capability: "DISCOVERY",
    endpoint: "https://demo.test/c",
    priority: "emergency"
  });
  assert.deepEqual(emergency, { ok: true });
  assert.equal(gateway.summary().budgets["demo:DISCOVERY"].tokens, 0);
});

test("provider gateway caps concurrent requests per provider and capability", async () => {
  let active = 0;
  let maximum = 0;
  const gateway = createProviderGateway({
    providers: {
      demo: {
        capacity: 10,
        reservedCapacity: 0,
        maxConcurrency: 1,
        maxAttempts: 1
      }
    },
    fetchImpl: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return jsonResponse({ ok: true });
    }
  });

  await Promise.all([1, 2, 3].map(index => gateway.requestJson({
    providerId: "demo",
    capability: "DISCOVERY",
    endpoint: `https://demo.test/${index}`
  })));

  assert.equal(maximum, 1);
});