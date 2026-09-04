# Solana 20× Radar

## Run

```bash
npm run dev
```

The server binds to `0.0.0.0:5000`.

## Data modes

- **DEMO MODE** (default): uses a clearly labelled, controlled dataset for development and UI/engine validation. It is not production market data.
- **LIVE MODE**: set `RADAR_MODE=live` and run a scan. The server calls the configured `DEXSCREENER_API_URL` or its public default endpoint. Unavailable fields remain `UNKNOWN`.

No API keys are hard-coded or sent to the browser. The application never asks for seed phrases/private keys and only supports simulated paper trading.

## Architecture

- `server.js`: server-side HTTP API, provider boundary, 30-second scheduler, durable local state, scan and paper-trade logic.
- `public/`: responsive institutional research UI.
- `.data/radar-state.json`: local durable development state; do not treat this as a production database.

## Current limitation

The imported workspace did not include a database or provider credentials. The app therefore ships with a durable local storage adapter and explicit demo/live boundaries. For production, connect PostgreSQL and an indexed Solana/RPC provider before treating values as live intelligence.