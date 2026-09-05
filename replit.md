# Solana 20× Radar

## Run

```bash
npm run dev
```

The server binds to `0.0.0.0:5000`.

## Data modes

- **DEMO MODE** (default): uses a clearly labelled, controlled dataset for development and UI/engine validation. It is not production market data.
- **LIVE MODE**: set `RADAR_MODE=live` and run a scan. The server calls the configured `DEXSCREENER_API_URL` or its public default endpoint, keeps only Solana records, and preserves DexScreener metadata such as provider URL, icon, header, description, links, CTO flag, boost amounts, and provider update time. Unavailable market/intelligence fields remain `UNKNOWN`.

No API keys are hard-coded or sent to the browser. The application never asks for seed phrases/private keys and only supports simulated paper trading.

## Architecture

- `server.js`: server-side HTTP API, provider boundary, server-side automatic scan every 30 seconds, scan and paper-trade logic.
- `db.js`: Prisma repository layer for PostgreSQL-backed state, watchlist events, paper trades, and scan runs.
- `prisma/schema.prisma`: PostgreSQL schema and indexes for tokens, signals, watchlists, paper trading, and scan observability.
- `public/`: responsive institutional research UI.

## Database

The app uses Replit's PostgreSQL database through Prisma 6.19.0:

```bash
npm run db:generate
npm run db:push
```

`DATABASE_URL` is read server-side from the Replit environment. The existing local JSON state is used only as a one-time seed when the Prisma database is empty; after boot, runtime reads and writes PostgreSQL.

## Data modes

- **DEMO MODE** (default): controlled dataset for development and UI/engine validation. It is explicitly labeled and is not production market data.
- **LIVE MODE**: set `RADAR_MODE=live` and run a scan. The server calls `DEXSCREENER_API_URL` or its public default endpoint, keeps only Solana records, and preserves DexScreener metadata such as provider URL, icon, header, description, links, CTO flag, boost amounts, and provider update time. Unavailable market/intelligence fields remain `UNKNOWN`.

No API keys are hard-coded or sent to the browser. The application never asks for seed phrases/private keys and only supports simulated paper trading.

## Automatic scanning

The scheduler runs on the server every 30 seconds. The browser only displays the countdown and is not responsible for triggering scans. Overlapping scans are rejected, and each run is stored in `ScanRun` with status, duration, provider, and processed-record counts.