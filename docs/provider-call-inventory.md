# Provider Call Inventory — M0 Baseline

**Baseline:** `m0-baseline-v1`
**Captured:** 2026-09-08
**Scope:** current single-process runtime before cache/queue/secondary-provider work

This inventory is a contract map, not a claim that every future provider is
already integrated. A provider call must be added here before it is added to the
runtime. Browser code does not call external providers directly.

## Outbound provider calls

| Call site | Provider | Capability | Cadence / trigger | Retry | Cache | Target phase |
|---|---|---|---|---|---|---|
| `fetchProviderJson()` discovery feeds | DexScreener | `DISCOVERY` | Each live scan; automatic scan baseline is 15s | Gateway bounded retry, `Retry-After`, backoff, circuit | None; M2 | M1/M2 |
| Pair fetch inside `fetchLiveTokens()` | DexScreener | `PAIR_MARKET` | Per discovered mint in a live scan; bounded concurrency | Gateway bounded retry, `Retry-After`, backoff, circuit | None; M2 | M1/M2 |
| `requestExecutionQuote()` buy/sell quote | Jupiter | `EXECUTION_QUOTE` | Only after active Phase 2 gates; per research size | Gateway bounded retry, timeout, circuit | None; M2 quote TTL | M1/M2 |
| `rpcPool.request()` | Solana RPC pool | `RPC_SINGLE` | Security verification during live scan | RPC-pool endpoint failover, timeout, circuit | None; M2/M5 | M1/M5 |
| `rpcPool.batch()` | Solana RPC pool | `RPC_BATCH` | Bounded holder/security enrichment during live scan | RPC-pool endpoint failover, timeout, circuit | None; M2/M5 | M1/M5 |

### Boundary verification

- HTTP market/quote calls are made through `provider-gateway.js`.
- JSON-RPC calls are intentionally isolated in `solana-rpc-pool.js`; the pool
  remains the RPC-specific adapter and does not bypass its own failover policy.
- There are no other `fetch`, `http.request`, or `https.request` call sites in
  the application runtime.
- Provider audit records are created once per gateway attempt and contain only
  redacted request metadata.

## Scheduler and timer inventory

| Timer | Interval / timeout | Responsibility | Baseline risk | Target phase |
|---|---:|---|---|---|
| Provider audit flush | 2s | Flush up to 50 bounded audit events to PostgreSQL | Queue is bounded; failed persistence is not retried forever in this baseline | M1/M8 |
| Automatic scan | 15s | Run one full synchronous live scan when no scan is running | Full-universe cadence is the known M3 limitation | M3 |
| Analysis checkpoint | 6h | Persist analysis checkpoint state | Slow workload remains in the web process | M7/M8 |
| Provider request timeout | 5s default | Bound one gateway request | Request is classified and surfaced as failed/unknown | M1 |
| Live scan deadline | 20s | Abort a scan that exceeds its hard budget | Last-known-good board is preserved | M3 |

## Mutation endpoint inventory

All mutations are origin-checked, rate-limited, bounded by the mutation lease,
and subject to the configured authentication guard.

| Endpoint | Operation | Idempotency | Durable audit / state |
|---|---|---|---|
| `POST /api/scan` | Manual live scan | `Idempotency-Key` supported | `ScanRun`, scan lease, correlation/request IDs |
| `POST /api/analysis` | Operator analysis checkpoint | Mutation lease | `RadarState` |
| `POST /api/trades` | Paper trade | `Idempotency-Key` supported | `PaperTrade`, account transaction |
| `POST /api/phase7/rollback` | Rollout rollback | Mutation lease | `RadarState.phase7` |
| `POST /api/watchlist/:mint` | Add/update watchlist | Mutation lease | `WatchlistEntry`, `WatchlistEvent` |
| `DELETE /api/watchlist/:mint` | Remove watchlist | Mutation lease | `WatchlistEvent` |
| `POST /api/alerts/:id/acknowledge` | Acknowledge alert | Request-scoped mutation | `AlertAcknowledgement` |
| `POST /api/alerts/:id/resolve` | Resolve alert | Request-scoped mutation | `AlertResolution` |

## Read endpoints

Read endpoints do not synchronously fetch providers:

`/api/state`, `/api/provider-health`, `/api/observability`,
`/api/provider-audit`, `/api/phase7`, `/api/evaluation`, `/api/outcomes`,
`/api/reactivation`, `/api/alerts`, and `/api/tokens/:mint/lineage`.

Every API response receives an `X-Request-ID`. Pagination is bounded on
history/audit reads, and provider credentials are never returned.

## Persistence and test inventory

### Observation and audit tables

- `ProviderRequest`: per-provider-attempt telemetry and lineage.
- `ScanRun`: scan lifecycle, counts, freshness, decision version, and source metrics.
- `TokenObservation`: immutable provider/pair observation lineage.
- `RadarDecisionSnapshot`: immutable decision contract output.
- `OutcomeCheckpoint`: delayed outcome labels.
- `EvaluationRun`: explicitly persisted evaluation reports.
- `ScanLease` / `MutationLease`: distributed safety controls.
- Alert/event tables and paper-trading tables: transactional operator state.

### Database-dependent tests

`test/phase0a.test.js`, `test/phase5.test.js`, `test/phase6.test.js`,
`test/phase7.test.js`, `test/runtime-smoke.test.js`, and the provider gateway
runtime audit checks use the development PostgreSQL database when
`DATABASE_URL` is available. Unit and contract tests remain network-free.

## Baseline status

The current baseline intentionally has no persistent cache or priority queue.
Those are M2/M3 deliverables. Their absence is exposed as
`NOT_IMPLEMENTED` in `/api/observability`; it is not reported as zero work or
as a healthy cache hit rate.