# Solana 20× Radar

## Run

```bash
npm run dev
```

The server binds to `0.0.0.0:5000`.

## Live data and virtual trading

- DexScreener is the only market-data provider and the application always runs in LIVE mode.
- The server scans DexScreener every 30 seconds and keeps only Solana records.
- Token boost metadata is combined with the provider's live token-pair data when available, including price, liquidity, market cap, 24-hour change, and pair URL.
- Missing provider fields remain `UNKNOWN`; the app does not invent market values.
- Paper trading uses virtual funds only: a $100,000 starting balance, fixed $100 entries, and a simulated 0.3% fee. No wallet, private key, signing, or real-fund transaction is supported.
- On first startup after the LIVE-only migration, old non-live records are removed and the virtual account is reset to $100,000 with no open positions.

## Architecture

- `server.js`: HTTP API, DexScreener provider boundary, automatic scan scheduler, and paper-trade logic.
- `db.js`: Prisma repository layer, LIVE-only cleanup, watchlist events, paper trades, and scan runs.
- `prisma/schema.prisma`: PostgreSQL schema for live tokens, signals, watchlists, paper trading, and scan observability.
- `public/`: responsive research UI.

## Database

The app uses PostgreSQL through Prisma 6.19.0:

```bash
npm run db:generate
npm run db:push
```

`DATABASE_URL` is read only on the server. The database is the runtime source of truth after initialization.