const test = require("node:test");
const assert = require("node:assert/strict");

const domain = process.env.REPLIT_DEV_DOMAIN;

test("runtime smoke contract exposes a healthy read surface", { skip: !domain }, async () => {
  const base = `https://${domain}`;
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type") || "", /text\/html/);

  const state = await fetch(`${base}/api/state`);
  assert.equal(state.status, 200);
  assert.match(state.headers.get("x-request-id") || "", /^[A-Za-z0-9._:-]+$/);
  const stateBody = await state.json();
  assert.equal(stateBody.mode, "live");
  assert.ok(stateBody.system);

  const observability = await fetch(`${base}/api/observability`);
  assert.equal(observability.status, 200);
  const observabilityBody = await observability.json();
  assert.equal(observabilityBody.ok, true);
  assert.equal(observabilityBody.version, "m0-observability-v1");
  assert.equal(observabilityBody.cache.status, "ACTIVE");
  assert.equal(observabilityBody.cache.enabled, true);
  assert.equal(observabilityBody.queue.status, "NOT_IMPLEMENTED");

  const providerHealth = await fetch(`${base}/api/provider-health`);
  assert.equal(providerHealth.status, 200);
  const providerHealthBody = await providerHealth.json();
  assert.equal(providerHealthBody.ok, true);
  assert.ok(providerHealthBody.gateway);
  assert.ok(providerHealthBody.audit);

  const providerAudit = await fetch(`${base}/api/provider-audit?limit=1&offset=0`);
  assert.equal(providerAudit.status, 200);
  const providerAuditBody = await providerAudit.json();
  assert.equal(providerAuditBody.ok, true);
  assert.ok(Array.isArray(providerAuditBody.records));
  assert.equal(providerAuditBody.pagination.limit, 1);
  for (const record of providerAuditBody.records) {
    assert.equal("requestBody" in record, false);
    assert.equal("responseBody" in record, false);
    assert.equal("authorization" in record, false);
  }

  const [phase7, evaluation] = await Promise.all([
    fetch(`${base}/api/phase7`),
    fetch(`${base}/api/evaluation`)
  ]);
  assert.equal(phase7.status, 200);
  assert.equal(evaluation.status, 200);
  assert.equal((await phase7.json()).ok, true);
  const evaluationBody = await evaluation.json();
  assert.equal(evaluationBody.ok, true);
  assert.ok(evaluationBody.report);
  assert.equal(typeof evaluationBody.report.efficacyClaimAllowed, "boolean");
});

test("runtime smoke contract validates mutation input without changing state", { skip: !domain }, async () => {
  const base = `https://${domain}`;
  const response = await fetch(`${base}/api/trades`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: base
    },
    body: JSON.stringify({})
  });
  if (process.env.RADAR_AUTH_TOKEN || process.env.RADAR_REQUIRE_AUTH === "true" || process.env.NODE_ENV === "production") {
    assert.equal(response.status, 403);
    return;
  }
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /valid mint and BUY or SELL/i);
});