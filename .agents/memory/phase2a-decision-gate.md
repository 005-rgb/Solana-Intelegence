---
name: Phase 2A decision gate
description: Execution-safety evidence is a mandatory final gate for actionable research candidates.
---

Candidates may be selected for quote collection after Phase 2 market gates, but they must not reach the board as actionable research unless the final execution-safety evaluation is `ACTIONABLE_RESEARCH`. Missing or rejected execution evidence remains fail-closed.

**Why:** Routeability, sellability, quote freshness, simulation, and token-program behavior are distinct from market-quality and authority checks; omitting the final gate can present an untested candidate as actionable.

**How to apply:** Preserve the two-stage flow: collect execution evidence only for candidates passing the earlier gates, then re-evaluate the candidate with `executionSafety` attached before persisting/presenting it.