const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  prisma,
  ensureScanLease,
  acquireScanLease,
  releaseScanLease,
  ensureMutationLease,
  acquireMutationLease,
  releaseMutationLease,
  reconcileInterruptedScans,
  recordSkippedScan,
  findScanByIdempotencyKey,
  recordAlertsAtomic
} = require("../db");

const integrationEnabled = Boolean(process.env.DATABASE_URL);

test("Phase 0A database controls are exclusive, recoverable, and atomic", { skip: !integrationEnabled }, async () => {
  const suffix = crypto.randomUUID();
  const scanOwnerA = `phase0a-scan-a-${suffix}`;
  const scanOwnerB = `phase0a-scan-b-${suffix}`;
  const mutationOwnerA = `phase0a-mutation-a-${suffix}`;
  const mutationOwnerB = `phase0a-mutation-b-${suffix}`;
  const idempotencyKey = `phase0a-skip-${suffix}`;
  const tradeKey = `phase0a-trade-${suffix}`;
  let scanRunId;
  let skippedRunId;
  let alertId;

  try {
    await ensureScanLease();
    await releaseScanLease(scanOwnerA);
    assert.equal(await acquireScanLease(scanOwnerA, 10_000), true);
    assert.equal(await acquireScanLease(scanOwnerB, 10_000), false);
    assert.equal((await prisma.scanLease.findUnique({ where: { id: 1 } })).owner, scanOwnerA);
    await releaseScanLease(scanOwnerA);
    assert.equal(await acquireScanLease(scanOwnerB, 10_000), true);
    await releaseScanLease(scanOwnerB);

    await ensureMutationLease();
    await releaseMutationLease(mutationOwnerA);
    assert.equal(await acquireMutationLease(mutationOwnerA, 10_000), true);
    assert.equal(await acquireMutationLease(mutationOwnerB, 10_000), false);
    await releaseMutationLease(mutationOwnerA);
    assert.equal(await acquireMutationLease(mutationOwnerB, 10_000), true);
    await releaseMutationLease(mutationOwnerB);

    const activeOwner = `phase0a-active-${suffix}`;
    assert.equal(await acquireScanLease(activeOwner, 10_000), true);
    const running = await prisma.scanRun.create({
      data: {
        manual: true,
        status: "RUNNING",
        startedAt: new Date(),
        provider: "phase0a-test",
        correlationId: `phase0a-correlation-${suffix}`
      }
    });
    scanRunId = running.id;
    const activeRecovery = await reconcileInterruptedScans();
    assert.equal(activeRecovery.active, true);
    assert.equal((await prisma.scanRun.findUnique({ where: { id: scanRunId } })).status, "RUNNING");
    await releaseScanLease(activeOwner);
    const orphanRecovery = await reconcileInterruptedScans();
    assert.equal(orphanRecovery.active, false);
    const interrupted = await prisma.scanRun.findUnique({ where: { id: scanRunId } });
    assert.equal(interrupted.status, "INTERRUPTED");
    assert.equal(interrupted.timeoutReason, "process_restart");

    const skipped = await recordSkippedScan({
      manual: true,
      provider: "phase0a-test",
      correlationId: `phase0a-skip-correlation-${suffix}`,
      requestId: `phase0a-request-${suffix}`,
      idempotencyKey,
      reason: "overlapping_scan"
    });
    skippedRunId = skipped.id;
    const replayed = await recordSkippedScan({
      manual: true,
      provider: "phase0a-test",
      correlationId: `phase0a-skip-replay-${suffix}`,
      requestId: `phase0a-request-replay-${suffix}`,
      idempotencyKey,
      reason: "overlapping_scan"
    });
    assert.equal(replayed.id, skipped.id);
    assert.equal((await findScanByIdempotencyKey(idempotencyKey)).status, "SKIPPED");

    const alerts = await recordAlertsAtomic([{
      type: "PHASE0A_TEST",
      token: `phase0a-${suffix}`,
      text: "Phase 0A atomic outbox test",
      tone: "blue",
      time: new Date().toISOString()
    }]);
    alertId = alerts[0].id;
    const outbox = await prisma.alertOutbox.findFirst({ where: { alertId } });
    assert.ok(outbox);
    assert.equal(outbox.eventType, "ALERT_CREATED");
    assert.equal(outbox.payload.token, `phase0a-${suffix}`);

    const account = await prisma.paperAccount.findUnique({ where: { id: 1 } });
    if (!account) {
      await prisma.paperAccount.create({
        data: { id: 1, starting: 100_000, cash: 100_000, realized: 0, fees: 0, trades: 0 }
      });
    }
    await prisma.paperTrade.create({
      data: { accountId: 1, symbol: "P0A", side: "BUY", amount: 1, price: 1, idempotencyKey: tradeKey }
    });
    await assert.rejects(
      () => prisma.paperTrade.create({
        data: { accountId: 1, symbol: "P0A", side: "BUY", amount: 1, price: 1, idempotencyKey: tradeKey }
      }),
      error => error.code === "P2002"
    );
  } finally {
    await prisma.paperTrade.deleteMany({ where: { idempotencyKey: tradeKey } });
    if (alertId) await prisma.alert.delete({ where: { id: alertId } }).catch(() => {});
    if (skippedRunId) await prisma.scanRun.delete({ where: { id: skippedRunId } }).catch(() => {});
    if (scanRunId) await prisma.scanRun.delete({ where: { id: scanRunId } }).catch(() => {});
    await releaseScanLease(scanOwnerA);
    await releaseScanLease(scanOwnerB);
    await releaseMutationLease(mutationOwnerA);
    await releaseMutationLease(mutationOwnerB);
    await prisma.$disconnect();
  }
});