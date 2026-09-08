const test = require("node:test");
const assert = require("node:assert/strict");
const { createScanWorkQueue, PRIORITIES } = require("../scan-work-queue");

test("scan queue deduplicates full scans and runs higher-priority work first", async () => {
  const order = [];
  const queue = createScanWorkQueue({
    maxQueue: 4,
    budgets: { background: { maxStarts: 10 }, interactive: { maxStarts: 10 } }
  });
  const first = queue.enqueue({
    dedupeKey: "full-scan",
    priority: PRIORITIES.BACKGROUND,
    budgetClass: "background",
    run: async () => { order.push("background"); return "background-result"; }
  });
  const duplicate = queue.enqueue({
    dedupeKey: "full-scan",
    priority: PRIORITIES.INTERACTIVE,
    budgetClass: "interactive",
    run: async () => { order.push("duplicate"); }
  });
  const urgent = queue.enqueue({
    dedupeKey: "manual-scan",
    priority: PRIORITIES.INTERACTIVE,
    budgetClass: "interactive",
    run: async () => { order.push("interactive"); return "interactive-result"; }
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(await first.item.promise, "background-result");
  assert.equal(await urgent.item.promise, "interactive-result");
  assert.deepEqual(order, ["interactive", "background"]);
  assert.equal(queue.snapshot().deduplicated, 1);
  queue.stop();
});

test("scan queue defers starts after a bounded budget and then resumes", async () => {
  let now = 1_000;
  const started = [];
  const queue = createScanWorkQueue({
    now: () => now,
    budgets: { background: { windowMs: 100, maxStarts: 1 } }
  });
  const first = queue.enqueue({
    dedupeKey: "first",
    budgetClass: "background",
    run: async () => { started.push("first"); }
  });
  await first.item.promise;
  const second = queue.enqueue({
    dedupeKey: "second",
    budgetClass: "background",
    run: async () => { started.push("second"); }
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(started, ["first"]);
  now += 101;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(started, ["first", "second"]);
  await second.item.promise;
  queue.stop();
});