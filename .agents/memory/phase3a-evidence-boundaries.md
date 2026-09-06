---
name: Phase 3A evidence boundaries
description: Manipulation and entity evidence must remain separate from predictive scores and fail closed when trade coverage is missing.
---

Phase 3A flags are observations, not verdicts. Trade-based flags stay `UNKNOWN` below the minimum sample or when the provider has no trade-level coverage; pool-drain evidence may be evaluated independently from liquidity history. Smart-money status requires explicit identity/funding lineage and prior entity history, never account concentration alone.

**Why:** Aggregate pair statistics cannot prove wash trading, coordinated wallets, or smart-money identity, and presenting an inferred relationship as fact would violate the Radar's research-first posture.

**How to apply:** Preserve the Phase 3A snapshot as an auditable layer alongside (not inside) Radar scores. Add provider adapters only when their coverage, timestamps, and entity lineage can be persisted and evaluated as-of without look-ahead.