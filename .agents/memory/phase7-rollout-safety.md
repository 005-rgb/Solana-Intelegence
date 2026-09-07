---
name: Phase 7 rollout safety
description: Controlled rollout must use persisted operational and outcome evidence without weakening the baseline or turning unknowns into passes.
---

Phase 7 promotion is an evidence gate, not a mode switch: unknown outcome, completeness, adverse-excursion, security, provider, latency, or explanation evidence keeps the champion on BASELINE. A failed provider scan may still have a successfully persisted audit row; database persistence must be measured separately from scan success.

**Why:** Operational availability and research efficacy are different failure domains. Conflating them can either hide a database failure or promote a scorer during an unhealthy data window.

**How to apply:** Keep monitoring, promotion eligibility, and rollback state separate. Preserve the last-known-good board during degraded provider/RPC states, and never infer readiness or probability claims from missing evidence.