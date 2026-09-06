const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveCandidateLifecycle,
  ALERT_COOLDOWN_MS
} = require("../candidate-lifecycle");
const {
  prisma,
  readCandidateStates,
  recordCandidateLifecycle,
  disconnectDb
} = require("../db");

function candidate(overrides = {}) {
  return {
    mint: `phase5-${process.pid}-${Date.now()}`,
    symbol: "P5",
    name: "Phase Five",
    radar: 82,
    risk: 20,
    updatedAt: new Date().toISOString(),
    details: {
      observedAt: new Date().toISOString(),
      security: {
        verified: true,
        status: "VERIFIED",
        reasons: []
      },
      marketQuality: {
        status: "PASSED",
        passed: true,
        metrics: { marketDataAgeMs: 30_000 }
      },
      executionSafety: { status: "ACTIONABLE_RESEARCH" },
      scorecard: {
        version: "phase4-v1",
        decisionVersion: "phase4-v1",
        decisionState: "QUALIFYING",
        eligibility: { qualifying: true },
        components: { entryQuality: 70, chaseRisk: 20, risk: 20 },
        phase4a: { thesis: { state: "VALIDATING" } },
        scoreWarnings: []
      }
    },
    ...overrides
  };
}

test("Phase 5 emits meaningful transitions and deduplicates stable state", () => {
  const now = Date.now();
  const first = candidate({ mint: `phase5-pure-${process.pid}-${now}` });
  const initial = deriveCandidateLifecycle(first, null, now);
  assert.equal(initial.fromState, "OBSERVED");
  assert.equal(initial.toState, "ACTIONABLE_RESEARCH");
  assert.equal(initial.transition.transitionReason, "QUALIFIED_WITH_EXECUTION_SAFETY");
  assert.equal(initial.alert.eventType, "CANDIDATE_QUALIFYING");

  const persisted = {
    currentState: initial.currentState,
    lastScore: initial.lastScore,
    securityState: initial.securityState,
    marketQualityState: initial.marketQualityState,
    thesisState: initial.thesisState
  };
  const stable = deriveCandidateLifecycle(first, persisted, now + 15_000);
  assert.equal(stable.transition, null);
  assert.equal(stable.alert, null);

  const invalidated = deriveCandidateLifecycle({
    ...first,
    details: {
      ...first.details,
      security: { verified: false, status: "REJECTED", reasons: ["FREEZE_AUTHORITY_PRESENT"] }
    }
  }, persisted, now + 30_000);
  assert.equal(invalidated.toState, "INVALIDATED");
  assert.equal(invalidated.alert.status, "INVALIDATED");
  assert.equal(invalidated.alert.eventType, "CANDIDATE_INVALIDATED");
});

test("Phase 5 persists state, transition, delivery, and supersession atomically", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const mint = `phase5-db-${suffix}`;
  const first = candidate({ mint, symbol: "P5DB" });
  const now = Date.now();
  const initial = deriveCandidateLifecycle(first, null, now);
  const created = await recordCandidateLifecycle([initial]);
  assert.equal(created.transitions.length, 1);
  assert.equal(created.alerts.length, 1);

  const state = (await readCandidateStates([mint]))[0];
  assert.equal(state.currentState, "ACTIONABLE_RESEARCH");
  assert.equal(state.decisionVersion, "phase4-v1");
  assert.equal(Math.floor(now / ALERT_COOLDOWN_MS), initial.cooldownBucket);

  const stable = deriveCandidateLifecycle(first, state, now + 15_000);
  const replay = await recordCandidateLifecycle([stable]);
  assert.equal(replay.alerts.length, 0);
  assert.equal(await prisma.alertEvent.count({ where: { mint } }), 1);
  assert.equal(await prisma.alertDelivery.count({ where: { alertEvent: { mint } } }), 1);
  assert.equal(await prisma.alertOutbox.count({ where: { alertEvent: { mint } } }), 1);

  const invalidated = deriveCandidateLifecycle({
    ...first,
    details: {
      ...first.details,
      security: { verified: false, status: "REJECTED", reasons: ["FREEZE_AUTHORITY_PRESENT"] }
    }
  }, state, now + 30_000);
  await recordCandidateLifecycle([invalidated]);
  const events = await prisma.alertEvent.findMany({ where: { mint }, orderBy: { createdAt: "asc" } });
  assert.equal(events.length, 2);
  assert.equal(events[0].status, "INVALIDATED");
  assert.equal(events[1].status, "INVALIDATED");

  await prisma.alertEvent.deleteMany({ where: { mint } });
  await prisma.candidateState.deleteMany({ where: { mint } });
  await prisma.alert.deleteMany({ where: { token: "P5DB" } });
  await disconnectDb();
});