"use strict";

const PRIORITIES = Object.freeze({
  BACKGROUND: 20,
  WATCHLIST: 60,
  INTERACTIVE: 100
});

function createScanWorkQueue({
  now = () => Date.now(),
  maxQueue = 32,
  maxAttempts = 2,
  budgets = {},
  onEvent = null
} = {}) {
  const pending = [];
  const known = new Map();
  const starts = new Map();
  let pumping = false;
  let pumpScheduled = false;
  let stopped = false;
  let sequence = 0;
  const counters = {
    enqueued: 0,
    completed: 0,
    failed: 0,
    deferred: 0,
    dropped: 0,
    deduplicated: 0,
    retried: 0
  };

  function emit(event) {
    try {
      onEvent?.({ ...event });
    } catch {
      // Queue telemetry must never change scheduling behavior.
    }
  }

  function budgetFor(className) {
    const configured = budgets[className] || budgets.default || {};
    return {
      windowMs: Math.max(1, Number(configured.windowMs || 60_000)),
      maxStarts: Math.max(1, Number(configured.maxStarts || 1))
    };
  }

  function pruneStarts(className, at = now()) {
    const window = budgetFor(className);
    const entries = starts.get(className) || [];
    const fresh = entries.filter(timestamp => timestamp > at - window.windowMs);
    starts.set(className, fresh);
    return { entries: fresh, budget: window };
  }

  function budgetState(className, at = now()) {
    const { entries, budget } = pruneStarts(className, at);
    return {
      className,
      used: entries.length,
      limit: budget.maxStarts,
      remaining: Math.max(0, budget.maxStarts - entries.length),
      resetsAt: entries.length ? new Date(Math.min(...entries) + budget.windowMs).toISOString() : null
    };
  }

  function canStart(className, at = now()) {
    return budgetState(className, at).remaining > 0;
  }

  function deferUntil(className, at = now()) {
    const state = budgetState(className, at);
    return state.resetsAt ? Date.parse(state.resetsAt) : at + budgetFor(className).windowMs;
  }

  function recordStart(className, at = now()) {
    const list = starts.get(className) || [];
    list.push(at);
    starts.set(className, list);
  }

  function compare(left, right) {
    return right.priority - left.priority || left.enqueuedAt - right.enqueuedAt || left.sequence - right.sequence;
  }

  function sortPending() {
    pending.sort(compare);
  }

  function schedulePump(delayMs = 0) {
    if (stopped) return;
    if (delayMs <= 0) {
      if (pumpScheduled) return;
      pumpScheduled = true;
      queueMicrotask(() => {
        pumpScheduled = false;
        pump().catch(error => emit({ type: "worker_error", error: error.message }));
      });
      return;
    }
    setTimeout(() => pump().catch(error => emit({ type: "worker_error", error: error.message })), Math.max(1, delayMs));
  }

  async function execute(item) {
    item.status = "RUNNING";
    item.attempts += 1;
    recordStart(item.budgetClass);
    emit({ type: "started", id: item.id, dedupeKey: item.dedupeKey, budgetClass: item.budgetClass, attempt: item.attempts });
    try {
      const result = await item.run({ attempt: item.attempts, budgetClass: item.budgetClass });
      item.status = "COMPLETED";
      counters.completed += 1;
      known.delete(item.dedupeKey);
      emit({ type: "completed", id: item.id, dedupeKey: item.dedupeKey });
      item.resolve?.(result);
    } catch (error) {
      if (item.attempts < maxAttempts && !stopped) {
        item.status = "DEFERRED";
        item.notBefore = now() + Math.min(10_000, 500 * (2 ** (item.attempts - 1)));
        counters.retried += 1;
        pending.push(item);
        sortPending();
        emit({ type: "retry", id: item.id, dedupeKey: item.dedupeKey, attempt: item.attempts, error: error.message });
      } else {
        item.status = "FAILED";
        counters.failed += 1;
        known.delete(item.dedupeKey);
        emit({ type: "failed", id: item.id, dedupeKey: item.dedupeKey, attempts: item.attempts, error: error.message });
        item.reject?.(error);
      }
    }
  }

  async function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (!stopped) {
        sortPending();
        const at = now();
        const index = pending.findIndex(item => item.notBefore <= at && canStart(item.budgetClass, at));
        if (index < 0) {
          const next = pending.filter(item => item.notBefore > at || !canStart(item.budgetClass, at))
            .map(item => item.notBefore > at ? item.notBefore : deferUntil(item.budgetClass, at))
            .sort((left, right) => left - right)[0];
          if (next != null && pending.length) schedulePump(Math.max(1, next - at));
          break;
        }
        const [item] = pending.splice(index, 1);
        await execute(item);
      }
    } finally {
      pumping = false;
    }
  }

  function enqueue({
    id = `scan-${++sequence}`,
    dedupeKey = id,
    priority = PRIORITIES.BACKGROUND,
    budgetClass = "background",
    run
  } = {}) {
    if (typeof run !== "function") throw new Error("A scan work item must provide a run function.");
    const existing = known.get(dedupeKey);
    if (existing) {
      counters.deduplicated += 1;
      emit({ type: "deduplicated", id, dedupeKey, existingId: existing.id });
      return { accepted: false, duplicate: true, item: existing };
    }
    const item = {
      id,
      dedupeKey,
      priority: Number(priority) || PRIORITIES.BACKGROUND,
      budgetClass: String(budgetClass || "background"),
      run,
      attempts: 0,
      status: "QUEUED",
      enqueuedAt: now(),
      notBefore: now(),
      sequence,
      promise: null,
      resolve: null,
      reject: null
    };
    item.promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    item.promise.catch(() => {});
    if (pending.length >= maxQueue) {
      sortPending();
      const lowest = pending[pending.length - 1];
      if (!lowest || item.priority <= lowest.priority) {
        counters.dropped += 1;
        emit({ type: "dropped", id, dedupeKey, reason: "queue_full" });
        item.status = "DROPPED";
        item.reject(new Error("Scan queue is full; work was deferred."));
        return { accepted: false, dropped: true, reason: "queue_full", item };
      }
      pending.pop();
      known.delete(lowest.dedupeKey);
      lowest.status = "DROPPED";
      counters.dropped += 1;
      lowest.reject(new Error("Scan queue was displaced by higher-priority work."));
      emit({ type: "dropped", id: lowest.id, dedupeKey: lowest.dedupeKey, reason: "lower_priority" });
    }
    known.set(dedupeKey, item);
    pending.push(item);
    counters.enqueued += 1;
    emit({ type: "enqueued", id, dedupeKey, priority: item.priority, budgetClass: item.budgetClass });
    schedulePump();
    return { accepted: true, duplicate: false, item };
  }

  function snapshot(at = now()) {
    const byStatus = {};
    for (const item of pending) byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    return {
      enabled: true,
      status: stopped ? "STOPPED" : pumping ? "RUNNING" : "READY",
      maxQueue,
      queued: pending.length,
      running: pumping ? 1 : 0,
      deferred: byStatus.DEFERRED || 0,
      failed: counters.failed,
      deadLettered: 0,
      ...counters,
      budgets: Object.keys(budgets).reduce((result, key) => {
        result[key] = budgetState(key, at);
        return result;
      }, {})
    };
  }

  function stop() {
    stopped = true;
    for (const item of pending.splice(0)) {
      item.status = "DROPPED";
      known.delete(item.dedupeKey);
      item.reject(new Error("Scan queue stopped."));
    }
  }

  return { enqueue, snapshot, stop, PRIORITIES };
}

module.exports = { createScanWorkQueue, PRIORITIES };