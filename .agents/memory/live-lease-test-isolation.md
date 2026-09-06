---
name: Live lease test isolation
description: Why database lease integration tests can fail while the live scheduler is running
---

Integration tests for scan-lease exclusivity share the same PostgreSQL lease row as the running application. The scheduler can legitimately own that row during a live scan, making the test's first acquisition fail even when lease code is correct.

**Why:** The application workflow and the database-backed test suite use the same environment and lease record.

**How to apply:** Run the lease integration test with the live lease released or with the application worker stopped, then restart the workflow before preview verification.