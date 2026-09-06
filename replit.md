# Solana 20× Radar

## Run

```bash
npm run dev
```

The server binds to `0.0.0.0:5000`.

Required environment variables:

- `DATABASE_URL`: PostgreSQL connection string used by Prisma.
- `SOLANA_RPC_URL`: one Helius or another Solana JSON-RPC endpoint used for live token security verification.
- `SOLANA_RPC_URLS` (optional): multiple RPC endpoints in one secret, separated by commas or new lines. The server rotates healthy endpoints and fails over on timeout, HTTP 429, or 5xx; `SOLANA_RPC_URL` remains supported for compatibility.
- `SOLANA_RPC_URLS` also accepts a JSON array/object or labeled lines such as `HELIUS=https://...`. Direct RPC URLs from multiple providers are accepted; dashboard/API-key management URLs are rejected and reported without exposing their values. Restart the workflow after changing the secret because the pool is loaded at process startup.
- `DEXSCREENER_NEW_PAIRS_API_URL` (optional): a provider endpoint returning a validated `{ "pairs": [...] }` payload for latest/new Solana pair discovery. Pair base-token addresses are normalized into the Phase 1 universe; the source stays optional and never weakens baseline gates.
- `RADAR_INDEXED_DISCOVERY_URL` (optional): an indexed discovery adapter endpoint returning a validated array of `{ tokenAddress, chainId, updatedAt, ... }` records. It is an additive source boundary, not a trust signal or score.
- Copy-ready secret configuration is documented in `docs/solana-rpc-pool-template.md`.

After importing or changing the schema, initialize the local database client with:

```bash
npm install
npm run db:generate
npm run db:push
```

## Live data and virtual trading

- DexScreener is the only market-data provider and the application always runs in LIVE mode.
- The server scans DexScreener every 15 seconds and keeps only Solana records.
- Token boost metadata is combined with the provider's live token-pair data when available, including price, liquidity, market cap, 24-hour change, and pair URL.
- Missing provider fields remain `UNKNOWN`; the app does not invent market values.
- Paper trading uses virtual funds only: a $100,000 starting balance, fixed $100 entries, and a simulated 0.3% fee. No wallet, private key, signing, or real-fund transaction is supported.
- On first startup after the LIVE-only migration, old non-live records are removed and the virtual account is reset to $100,000 with no open positions.

## Architecture

- `server.js`: HTTP API, DexScreener provider boundary, automatic scan scheduler, and paper-trade logic.
- `db.js`: Prisma repository layer, LIVE-only cleanup, watchlist events, paper trades, scan runs, and immutable provider observations.
- `radar-core.js`: pure baseline-v1 reason-code and count-reconciliation helpers, plus deferred phase2-v1 pair-selection and market-quality helpers.
- `prisma/schema.prisma`: PostgreSQL schema for live tokens, signals, watchlists, paper trading, scan observability, and `TokenObservation` lineage rows.
- `public/`: responsive research UI.

The authoritative product specification is
[`docs/integrated-radar-core-market-brain-prd.md`](docs/integrated-radar-core-market-brain-prd.md).
It integrates the existing Radar Core implementation plan with the project-first
Market Brain architecture. `docs/radar-core-system-phased-plan.md` remains the
detailed Radar Core phase reference; where the documents overlap, the integrated
PRD defines the product model and the phased plan defines implementation
detail.

## Baseline-v1 auditability

The current Radar board is a fail-closed research filter, not a validated prediction engine. Phase 0 records every scan as a durable `ScanRun` with:

- provider universe and checked/accepted/rejected/unresolved counts that reconcile exactly;
- stable rejection reason codes and the exact active filter configuration;
- provider pair/price/liquidity coverage, security verified/unknown/rejected counts, and gate-specific rejection counts;
- scan start/end/duration, provider/RPC freshness, RPC commitment, timeout state, quality state, and correlation ID;
- source-specific discovery denominators and `tokensPersisted`;
- one immutable `TokenObservation` per examined provider token/pair with source endpoint, request ID, response hash, timestamps, market windows, and quality reasons.

If a provider or security scan fails, the last known good Radar board remains visible. A filtered scan persists its observations and audit record without replacing the board. `baseline-v1` intentionally leaves Radar, opportunity, flow, risk, and confidence fields as `UNKNOWN` until later scoring and outcome phases.

## Phase 1 discovery and observations

- Discovery merges DexScreener token boosts, latest token profiles, and active watchlist mints.
- Latest pair discovery and an optional indexed discovery adapter can add non-boosted mints without changing the active decision contract. Disabled optional sources are reported as `NOT CONFIGURED`, not as empty successful feeds.
- Mints are deduplicated deterministically with watchlist priority; every Solana pair returned for a mint is retained as an immutable `TokenObservation`.
- The primary pair policy is explicit: Solana only, price and liquidity required, then highest liquidity, freshest `updatedAt`, newest `pairCreatedAt`, and stable pair address tie-break.
- Boost data is stored as attention metadata and never acts as a quality score by itself.
- Missing provider fields remain `null`/`UNKNOWN`; source endpoint, per-request ID, response hash, observation time, provider update time, and quality reasons are persisted. Discovery and pair-fetch lineage remain separate.
- The scan audit exposes source health, overlap, deduplicated mint/pair counts, pair policy, and primary/secondary observation lineage.
- Provider feed and pair payloads are validated against `dexscreener-v1`; malformed records, negative/non-finite values, invalid timestamps, and future clock skew are counted as schema diagnostics instead of being treated as an empty feed.
- Provider requests use bounded pair-fetch concurrency, bounded retries with `Retry-After`/exponential backoff, and an endpoint circuit breaker. A provider failure preserves the last known board.
- Solana RPC security checks use a bounded RPC pool. Each endpoint has independent health/cooldown state, and the audit exposes endpoint host, failure count, circuit state, and last HTTP status without exposing secret URLs.

## Phase 1A account taxonomy

- Largest-account evidence is explicitly labeled `ACCOUNT_CONCENTRATION_ONLY` until holder account classification is available.
- Account classes are fail-closed: `EOA_OR_WALLET`, `ASSOCIATED_TOKEN_ACCOUNT`, `AMM_POOL`, `POOL_VAULT`, `PROGRAM_OWNED`, `ESCROW_OR_LOCK`, `TREASURY`, and `UNKNOWN_ACCOUNT`.
- Pool and vault labels require explicit pool evidence; a pair address alone cannot turn a token account into a wallet or pool owner.
- A system-owned non-executable owner remains `UNKNOWN_ACCOUNT` unless separate evidence distinguishes an EOA from a PDA.
- A bounded top-holder RPC enrichment resolves account and owner evidence without weakening the existing security gates. Unresolved owners remain unknown.
- Immutable `TokenObservation` rows persist account taxonomy, pool evidence, and separated account/wallet concentration metrics.
- The UI calls the data token-account concentration and shows the taxonomy status; it does not present unresolved token accounts as wallet holders.
- Wallet concentration is calculated only from explicit wallet-owner evidence. An associated token account remains an ATA unless its owner is independently identified.
- Pool evidence is normalized with AMM, program, vault, LP, lock/burn, authority, slot, and source fields; malformed numeric, slot, or timestamp values remain `null`.
- Pool-adjusted wallet concentration excludes `AMM_POOL` and `POOL_VAULT` accounts before ranking, and taxonomy confidence is capped while accounts remain unresolved.

## Phase 0 active baseline

Live scans use the immutable `baseline-v1` decision contract. The accepted board preserves the current hard-filter behavior: renounced mint and freeze authorities, largest account at or below 80% of supply, available price, liquidity of at least $10,000, positive provider-reported 24-hour change, and no CTO flag. Every candidate is classified as accepted, rejected, or unresolved, and the three outcome counts reconcile exactly.

Phase 2 market-quality evidence may be captured in observations for later work, but it does not change the Phase 0 accepted board.

## Deferred Phase 2 security and market-quality evidence

The code retains a versioned `phase2-v1` contract for later activation while preserving `baseline-v1` as the active decision. Security verification already records parsed supported SPL mint evidence, positive supply, complete largest-account data, RPC slot context, and internally valid numeric amounts. Missing, malformed, partial, or stale RPC evidence remains `UNVERIFIED` and fails closed; an unsupported account type is `REJECTED`.

Security observations identify `SPL_TOKEN` versus `TOKEN_2022`, retain reviewed Token-2022 extensions, and expose warnings for transfer-fee, transfer-hook, permanent-delegate, default-state, non-transferable, confidential-transfer, and metadata-pointer extensions. RPC evidence includes commitment, observation time, response/request counts, and per-response slot contexts.

Market eligibility combines the existing $10,000 liquidity floor with liquidity/market-cap ratio, a transparent estimated impact proxy for a configured $100 research entry, 24-hour volume/liquidity ratio, pair age, and provider freshness. Missing inputs are `UNKNOWN`, never zero, and cannot qualify a candidate. Gate metrics and stable reason codes are persisted in token observations and scan audit data. These are research safety gates, not executable sell simulations or predictive scores.

## Phase 0A platform safety

The server keeps scan execution safe across restarts and concurrent callers:

- PostgreSQL-backed scan lease prevents overlapping scans across processes; overlapping requests are recorded as `SKIPPED`.
- Startup reconciliation marks orphaned `RUNNING` scans as `INTERRUPTED` and releases the lease.
- Manual scans and paper trades accept bounded `Idempotency-Key` values; the request fingerprint is persisted so reusing a key for a different operation returns a conflict instead of silently replaying.
- Every request receives an `X-Request-ID`; scan runs persist request and correlation IDs.
- API rate limits, same-origin mutation checks, security headers, bounded JSON bodies, a 5-second body timeout, and a 30-second response timeout are enabled.
- Scan outcome finalization and the corresponding durable radar snapshot commit in one PostgreSQL transaction, so a restart cannot leave a successful/failed run disconnected from the state that describes it.
- Watchlist changes, paper trades, and alert creation use database transactions; alert creation also writes a durable outbox event.

Mutation authentication can be enforced by setting the `RADAR_AUTH_TOKEN` secret. Without it, the app remains suitable for the trusted Replit preview boundary, not an unauthenticated public deployment.

Run the baseline unit matrix with:

```bash
npm test
```

## Database

The app uses PostgreSQL through Prisma 6.19.0:

```bash
npm run db:generate
npm run db:push
```

`DATABASE_URL` is read only on the server. The database is the runtime source of truth after initialization.