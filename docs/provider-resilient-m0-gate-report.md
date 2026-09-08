# M0 Gate Report — Baseline Freeze and Observability

**Gate:** M0 / G0
**Artifact version:** `m0-baseline-v1`
**Date:** 2026-09-08
**Mode:** observe-only; no Radar decision contract changes

## Scope completed

- Provider, RPC, scheduler, mutation, persistence, and database-test inventory:
  [`provider-call-inventory.md`](provider-call-inventory.md)
- Non-blocking baseline observability registry:
  `baseline-observability.js`
- Read-only metrics surface:
  `GET /api/observability`
- Scan audit integration through the `observability` JSON snapshot.
- Synthetic network-free fixtures for 10, 100, and 1,000 tokens, 100 watchlist
  entries, 429, timeout, and malformed provider responses:
  `fixtures/provider-resilient-baseline.js`
- Unit coverage for bounded metrics and fixture determinism:
  `test/baseline-observability.test.js`

## Metrics contract

The M0 snapshot is versioned as `m0-observability-v1` and reports:

- provider request count, status counts, retries, bounded latency p50/p95/max;
- scan starts, completions, status counts, and bounded duration p50/p95/max;
- provider and RPC freshness samples;
- last-known-good age;
- explicit cache and queue placeholders marked `NOT_IMPLEMENTED`.

The registry is in-memory by design for M0. Durable scan records retain the
snapshot, while M2/M3 will add persistent cache and queue metrics without
changing the read contract.

## Gate checks

| Check | Result | Evidence |
|---|---|---|
| All current outbound calls are inventoried | PASS | `docs/provider-call-inventory.md` |
| Metrics are non-blocking and bounded | PASS | `test/baseline-observability.test.js` |
| Network-free 10/100/1,000 fixtures exist | PASS | `fixtures/provider-resilient-baseline.js` |
| Provider failure fixtures exist | PASS | 429, timeout, malformed response cases |
| Baseline runtime metrics are readable | PASS | `GET /api/observability` |
| Scan audit keeps metrics lineage | PASS | `ScanRun.sourceMetrics.baselineObservability` |
| Phase 2 acceptance gate unchanged | PASS | Existing Phase 2/2A tests |
| Last-known-good remains explicit | PASS | `freshness.lastKnownGoodAgeMs` |
| Full test suite | PASS | 92 tests passed |

## No-go conditions checked

- No direct external HTTP call was added outside the existing gateway/RPC
  boundaries.
- No credential, provider secret, or raw provider payload was added to the
  fixture or metrics output.
- No database DDL or startup-time migration was added.
- No missing evidence is converted to zero or a positive decision.
- No Phase 2–7 safety contract was relaxed.

## Gate decision

**GO for M1 work.** M0 establishes a reproducible call inventory, bounded
observability contract, synthetic failure fixtures, and a read surface before
further provider changes are made.