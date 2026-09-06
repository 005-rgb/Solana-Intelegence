---
name: Phase 0A safety boundaries
description: Durable rules for idempotent mutations and scan audit/state consistency.
---

Mutation idempotency keys must be bound to a request fingerprint. Reusing a key for a different operation or payload must return a conflict rather than replaying the first result.

**Why:** A unique key alone prevents duplicate rows but can silently acknowledge the wrong mutation when a client retries with changed intent.

**How to apply:** Persist the fingerprint beside the idempotency key for scan and paper-trade mutations, handle concurrent unique-key races as replays, and return a conflict for mismatches.

Scan outcome finalization and the durable radar snapshot must commit in one database transaction.

**Why:** Finishing a ScanRun separately from the state snapshot can leave a successful or failed audit row disconnected from the board after a process crash.

**How to apply:** Include the ScanRun final status update in the same transaction that persists the state used to describe that outcome; let startup recovery handle a run that remains RUNNING.