# Paper-Mode Simulator Plan (start equity: $100,000)

Goal: Run a fully local, read-only simulator that mirrors the 13 leader wallets with equal capital slices, tracks fills/PnL, and is ready to flip to live trading later.

## Core assumptions
- Starting portfolio equity: **$100,000**.
- Equal allocation: `equity_per_leader = current_equity / 13` recomputed each cycle.
- Data sources: Polymarket Data-API (`/trades`, `/positions` for leaders), Gamma for market metadata, CLOB order book for pricing (read-only).
- Fills: paper orders fill at **leader trade price**, or at current best ask/bid with optional slippage tolerance; configurable.

## Implementation steps
1) **Config**
   - Add `PAPER_MODE=true`, `PAPER_START_EQUITY=100000` in `.env`.
   - Keep `MY_WALLET` for identity, but paper mode won’t sign/place live orders.

2) **State & DB schema**
   - Add tables:
     - `paper_positions(condition_id, outcome, size, avg_price, leader_wallet, updated_at)`
     - `paper_portfolio(value, cash, timestamp)`
     - `paper_fills(id, leader_trade_id, side, price, size, notional, timestamp, leader_wallet, rule_label)`
     - Reuse `copy_orders_intent` for intent logging.

3) **Allocation engine**
   - On each ingest loop:
     - Fetch latest portfolio equity: `paper_cash + MTM(paper_positions)`.
     - Compute `equity_per_leader = equity / 13`.
     - For each new leader trade, target notional = `equity_per_leader - current_exposure_for_leader` (capped ≥ 0 for buys; for sells, min(current position, leader size at leader price)).

4) **Pricing model**
   - Leader price as baseline.
   - Optional: pull best bid/ask from CLOB market channel; fill at min(max(bid/ask, leader price), leader price * (1+slip)).
   - Slippage config: `PAPER_SLIPPAGE_BPS` (default 50 bps).

5) **Fill simulation**
   - Insert a `paper_fills` row per copied trade.
   - Update `paper_positions` (size, VWAP).
   - Deduct/add cash accordingly from `paper_cash`.

6) **Mark-to-market**
   - For each held position, fetch current fair price:
     - If book available: mid of best bid/ask; else last leader price.
   - MTM PnL = (mark - avg_price) * size.
   - Persist snapshot to `paper_portfolio`.

7) **Reporting**
   - CLI command `npm run paper`:
     - Prints equity, cash, unrealized PnL, realized PnL.
     - Top open positions by notional; PnL per leader.

8) **Backfill & replay (optional)**
   - Script to pull historical leader trades and replay with a specified latency assumption to test robustness.

9) **Exit criteria / live switch**
   - Keep interfaces identical to live executor; swapping `paperExecutor` → `clobExecutor` should be 1-2 function changes when U.S. access opens.

## Minimal work order
1) Add env + schema migrations for paper tables.
2) Implement `paperExecutor` that consumes leader trades -> intents -> fills -> positions.
3) Add MTM/pricing helper using book mid or leader price.
4) Add `npm run paper` command for status report.
5) Optional: backfill/replay script.
