# Solana 20× Radar

## Run

```bash
npm run dev
```

The server binds to `0.0.0.0:5000`.

Required environment variables:

- `DATABASE_URL`: PostgreSQL connection string used by Prisma.
- `SOLANA_RPC_URL`: Helius or another Solana JSON-RPC endpoint used for live token security verification.

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
- `radar-core.js`: pure baseline-v1 reason-code, count-reconciliation, and deterministic pair-selection helpers.
- `prisma/schema.prisma`: PostgreSQL schema for live tokens, signals, watchlists, paper trading, scan observability, and `TokenObservation` lineage rows.
- `public/`: responsive research UI.

## Baseline-v1 auditability

The current Radar board is a fail-closed research filter, not a validated prediction engine. Phase 0 records every scan as a durable `ScanRun` with:

- provider universe and checked/accepted/rejected/unresolved counts that reconcile exactly;
- stable rejection reason codes and the exact active filter configuration;
- provider pair/price/liquidity coverage, security verified/unknown/rejected counts, and gate-specific rejection counts;
- scan start/end/duration, provider/RPC freshness, RPC commitment, timeout state, quality state, and correlation ID;
- source-specific discovery denominators and `tokensPersisted`;
- one immutable `TokenObservation` per examined provider token/pair with source endpoint, request ID, response hash, timestamps, market windows, and quality reasons.

If a provider or security scan fails, the last known good Radar board remains visible. A filtered scan persists its observations and audit record without replacing the board. `baseline-v1` intentionally leaves Radar, opportunity, flow, risk, and confidence fields as `UNKNOWN` until later scoring and outcome phases.

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