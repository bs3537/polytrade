# Polymarket Copy-Trading MVP (per Plan.MD)

Minimal scaffolding to ingest top-trader activity, persist it locally, and generate simulated copy-order intents.

## Quick start

1. **Install deps**
   ```bash
   npm install
   ```
2. **Configure**
   - Copy `.env.example` to `.env` and edit `WALLETS` with proxy wallet addresses you want to follow.
   - (Optional) adjust `POLL_INTERVAL_MS` and `DB_PATH`.
   - Tune `follow-rules.json` for sizing and category filters.
3. **Ingest trades (polling)**
   ```bash
   npm run ingest
   ```
   Stores trades in SQLite at `data/trades.db` under tables `leader_trades` and `markets`.
4. **Simulate copy orders**
   ```bash
   npm run simulate
   ```
   Generates `copy_orders_intent` rows (no live trading) based on `follow-rules.json`.
5. **Paper-trading mode (equal split across leaders)**
   ```bash
   npm run paper
   ```
   - Uses starting equity from `.env` (`PAPER_START_EQUITY`, default 100000).
   - Allocates equally across all `WALLETS` (13 leaders).
   - Copies new leader trades into `paper_positions`/`paper_fills`, updates `paper_portfolio`.
6. **Dashboard (paper mode)**
   ```bash
   npm run dashboard
   ```
   Opens a local Fastify server (default http://localhost:3000) with a dark UI showing equity, cash, open positions, and recent paper fills.
7. **Reset paper account to starting equity**
   ```bash
   npm run paper:reset
   ```
   Clears paper tables/state and restores cash/equity to `PAPER_START_EQUITY`.

## What’s implemented vs Plan.MD
- ✅ Data ingestion via Data-API polling (`/trades`) and Gamma metadata lookup.
- ✅ Local DB schema for leaders, markets, and copy intents.
- ✅ Rule-based simulator (COPY/COUNTER, fixed USDC sizing, category filter).
- ✅ Paper-mode simulator with equal-per-leader allocation and $100k default start.
- ✅ Dashboard UI for paper mode (Fastify + static HTML/JS).
- ⬜️ RTDS low-latency stream (add next).
- ⬜️ CLOB execution (use `@polymarket/clob-client` once keys are ready).
- ⬜️ UI/alerts/backtester polish.

## Next steps
- Add RTDS WebSocket listener for lower latency, fallback to polling.
- Wire `@polymarket/clob-client` for live orders with slippage/time-in-force controls.
- Expand rules to include pct-of-leader sizing, per-market caps, latency windows.
- Add nightly metrics updater for leader performance and a simple dashboard.
