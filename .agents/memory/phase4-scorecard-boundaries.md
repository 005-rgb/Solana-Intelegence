---
name: Phase 4 scorecard boundaries
description: Durable rules for deterministic Phase 4 scoring and evidence caps.
---

Phase 4 scorecards are a transparent evidence-ranking layer. They must remain versioned and configuration-hashed, expose component scores and reasons, and keep missing evidence as `UNKNOWN` or an explicit cap. Phase 4A promotion is fail-closed on both temporal holdout and model-guardian validation, with immutable decision lineage. They must not be described as profit probabilities or replace the Phase 2/2A acceptance gates.

**Why:** The current provider does not prove project traction, catalysts, verified entity history, or trade-level coverage for every candidate. Treating absent evidence as a numeric positive would make the research board look more certain than its sources justify.

**How to apply:** Any new Phase 4 input needs source lineage and an as-of boundary. Persist the exact score configuration with the decision snapshot. If evidence or guardian checks are unavailable, preserve the existing cap/warning behavior and keep wallet execution disabled.