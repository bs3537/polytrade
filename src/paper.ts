import { db, initDb } from "./db.js";
import { WALLETS, PAPER_START_EQUITY, PAPER_SLIPPAGE_BPS, PAPER_SIZE_MODE } from "./config.js";
import { fetchMarketByConditionId, fetchTradesForWallet, fetchLeaderValue } from "./polymarket.js";

type LeaderTradeRow = {
  id: number;
  proxy_wallet: string;
  condition_id: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  timestamp: number;
};

// Ensure tables exist before preparing statements
initDb();

const getState = db.prepare("SELECT value FROM paper_state WHERE key = ?");
const setState = db.prepare(
  "INSERT INTO paper_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);

function getLastProcessedId(): number {
  const row = getState.get("last_trade_id") as any;
  return row ? Number(row.value) : 0;
}

function setLastProcessedId(id: number) {
  setState.run("last_trade_id", String(id));
}

function getStartTimestamp(): number {
  const row = getState.get("paper_start_ts") as any;
  if (row) return Number(row.value);
  const now = Date.now();
  setState.run("paper_start_ts", String(now));
  return now;
}

function ensureStartingPortfolio() {
  const cashRow = getState.get("paper_cash") as any;
  if (!cashRow) {
    setState.run("paper_cash", String(PAPER_START_EQUITY));
  }
  const realizedRow = getState.get("paper_realized") as any;
  if (!realizedRow) {
    setState.run("paper_realized", "0");
  }
  const exists = db.prepare("SELECT 1 FROM paper_portfolio LIMIT 1").get();
  if (!exists) {
    db.prepare(
      "INSERT INTO paper_portfolio(timestamp, equity, cash, unrealized, realized) VALUES (strftime('%s','now')*1000, ?, ?, 0, 0)"
    ).run(PAPER_START_EQUITY, PAPER_START_EQUITY);
  }
}

function currentCash(): number {
  const row = getState.get("paper_cash") as any;
  return row ? Number(row.value) : PAPER_START_EQUITY;
}

function currentRealized(): number {
  const row = getState.get("paper_realized") as any;
  return row ? Number(row.value) : 0;
}

function addRealized(delta: number) {
  const nowVal = currentRealized() + delta;
  setState.run("paper_realized", String(nowVal));
}

function upsertPosition(
  conditionId: string,
  outcome: string | null,
  leaderWallet: string,
  side: "BUY" | "SELL",
  size: number,
  price: number,
  timestamp: number
): number /* realizedDelta */ {
  const row = db
    .prepare(
      "SELECT size, avg_price FROM paper_positions WHERE condition_id=? AND outcome IS ? AND leader_wallet=?"
    )
    .get(conditionId, outcome, leaderWallet) as any;

  let newSize = size * (side === "BUY" ? 1 : -1);
  let newAvg = price;
  let realizedDelta = 0;

  if (row) {
    const prevSize = Number(row.size);
    const prevAvg = Number(row.avg_price);
    const signedPrev = prevSize;
    const signedAdd = newSize;
    const combined = signedPrev + signedAdd;

    if (combined === 0) {
      if (Math.sign(signedPrev) !== Math.sign(signedAdd)) {
        realizedDelta += (price - prevAvg) * Math.min(Math.abs(size), Math.abs(prevSize));
      }
      db.prepare(
        "DELETE FROM paper_positions WHERE condition_id=? AND outcome IS ? AND leader_wallet=?"
      ).run(conditionId, outcome, leaderWallet);
      return realizedDelta;
    }

    if (Math.sign(signedPrev) === Math.sign(combined)) {
      // same direction -> vwap
      const prevNotional = prevAvg * Math.abs(prevSize);
      const addNotional = price * Math.abs(size);
      newAvg = (prevNotional + addNotional) / (Math.abs(prevSize) + Math.abs(size));
    } else {
      // reducing or flipping
      const reduceQty = Math.min(Math.abs(size), Math.abs(prevSize));
      realizedDelta += (price - prevAvg) * reduceQty;
      newAvg = prevAvg;
    }
    newSize = combined;
  }

  db.prepare(
    "INSERT INTO paper_positions(condition_id, outcome, leader_wallet, size, avg_price, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(condition_id, outcome, leader_wallet) DO UPDATE SET size=excluded.size, avg_price=excluded.avg_price, updated_at=excluded.updated_at"
  ).run(conditionId, outcome, leaderWallet, newSize, newAvg, timestamp);

  return realizedDelta;
}

function adjustCash(delta: number) {
  const cash = currentCash() + delta;
  setState.run("paper_cash", String(cash));
}

function recordFill(t: LeaderTradeRow, size: number, price: number, ruleLabel = "paper") {
  db.prepare(
    `INSERT INTO paper_fills(leader_trade_id, leader_wallet, condition_id, side, price, size, notional, timestamp, rule_label, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,strftime('%s','now')*1000)`
  ).run(
    t.id,
    t.proxy_wallet,
    t.condition_id,
    t.side,
    price,
    size,
    size * price * (t.side === "BUY" ? 1 : -1),
    t.timestamp,
    ruleLabel
  );
}

function latestPricesMap(): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT condition_id, price FROM leader_trades lt WHERE timestamp = (SELECT MAX(timestamp) FROM leader_trades lt2 WHERE lt2.condition_id = lt.condition_id)"
    )
    .all() as any[];
  return rows.reduce((m: Record<string, number>, r: any) => {
    m[r.condition_id] = Number(r.price);
    return m;
  }, {});
}

function getPositionValue(): number {
    const rows = db.prepare("SELECT size, avg_price, condition_id FROM paper_positions").all() as any[];
  const latest = latestPricesMap();
  return rows.reduce((acc, r) => {
    const mark = latest[r.condition_id] ?? Number(r.avg_price);
    return acc + Number(r.size) * mark;
  }, 0);
}

function snapshotPortfolio() {
  const cash = currentCash();
  const posRows = db.prepare("SELECT size, avg_price, condition_id FROM paper_positions").all() as any[];
  const latest = latestPricesMap();
  const posValue = posRows.reduce((acc, r) => {
    const mark = latest[r.condition_id] ?? Number(r.avg_price);
    return acc + Number(r.size) * mark;
  }, 0);
  const unreal = posRows.reduce((acc, r) => {
    const mark = latest[r.condition_id] ?? Number(r.avg_price);
    return acc + Number(r.size) * (mark - Number(r.avg_price));
  }, 0);
  const realized = currentRealized();
  const equity = cash + posValue + unreal;
  db.prepare(
    "INSERT INTO paper_portfolio(timestamp, equity, cash, unrealized, realized) VALUES (strftime('%s','now')*1000, ?, ?, ?, ?)"
  ).run(equity, cash, unreal, realized);
}

export async function runPaperOnce() {
  if (WALLETS.length === 0) {
    console.error("Set WALLETS in .env");
    process.exit(1);
  }

  initDb();
  ensureStartingPortfolio();
  const startTs = getStartTimestamp();

  // Pull fresh trades for all wallets and store them in leader_trades table for consistency.
  // (Reuse ingest logic lightly: fetch and insert.)
  const insertTrade = db.prepare(`
    INSERT OR IGNORE INTO leader_trades
      (proxy_wallet, transaction_hash, condition_id, asset_id, side, size, price, timestamp, market_slug, market_title)
    VALUES
      (@proxyWallet, @transactionHash, @conditionId, @assetId, @side, @size, @price, @timestamp, @marketSlug, @marketTitle);
  `);

  for (const w of WALLETS) {
    const trades = await fetchTradesForWallet(w);
    for (const t of trades) {
      insertTrade.run({
        proxyWallet: t.proxyWallet,
        transactionHash: t.transactionHash,
        conditionId: t.conditionId,
        assetId: t.assetId,
        side: t.side,
        size: t.size,
        price: t.price,
        timestamp: t.timestamp,
        marketSlug: t.marketSlug,
        marketTitle: t.marketQuestion,
      });
    }
  }

  const lastId = getLastProcessedId();
  const pending = db
    .prepare(
      "SELECT id, proxy_wallet, condition_id, side, size, price, timestamp FROM leader_trades WHERE id > ? AND timestamp >= ? ORDER BY id ASC"
    )
    .all(lastId, startTs) as any as LeaderTradeRow[];

  if (pending.length === 0) {
    console.log("No new leader trades to simulate.");
    return;
  }

  const equityNow = currentCash() + getPositionValue();
  const perLeaderAllocation = equityNow / WALLETS.length;

  for (const t of pending) {
    const leaderWallet = t.proxy_wallet.toLowerCase();
    if (!WALLETS.map((w) => w.toLowerCase()).includes(leaderWallet)) continue;

    // Determine fill price with simple slippage model
    const slip = PAPER_SLIPPAGE_BPS / 10000;
    const price =
      t.side === "BUY" ? t.price * (1 + slip) : t.price * (1 - slip);

    // Compute existing position notional for this leader
  const posRow = db
    .prepare(
      "SELECT size, avg_price FROM paper_positions WHERE condition_id=? AND outcome IS NULL AND leader_wallet=?"
    )
    .get(t.condition_id, leaderWallet) as any;
    const currentExposure = posRow ? Number(posRow.size) * Number(posRow.avg_price) : 0;
    const leaderNotional = t.size * t.price;
    const leaderValue = PAPER_SIZE_MODE === "LEADER_PCT" ? await fetchLeaderValue(t.proxy_wallet) : 0;

    let desiredNotional = 0;
    if (PAPER_SIZE_MODE === "LEADER_PCT") {
      const leaderPct = leaderValue > 0 ? leaderNotional / leaderValue : 0.10; // fallback 10%
      const target = leaderPct * perLeaderAllocation;
      if (t.side === "BUY") {
        const available = perLeaderAllocation - currentExposure;
        desiredNotional = Math.max(0, Math.min(available, target));
      } else {
        // SELL: close proportionally but not beyond position
        const maxSell = Math.abs(currentExposure);
        desiredNotional = Math.max(0, Math.min(maxSell, target));
      }
    } else {
      if (t.side === "BUY") {
        const available = perLeaderAllocation - currentExposure;
        desiredNotional = Math.max(0, Math.min(available, leaderNotional));
      } else {
        // SELL: allow closing up to current exposure, but not shorting
        desiredNotional = Math.max(0, Math.min(Math.abs(currentExposure), leaderNotional));
      }
    }
    if (desiredNotional <= 0) continue;

    // Do not exceed available cash on BUY
    if (t.side === "BUY") {
      const cashAvail = currentCash();
      if (cashAvail <= 0) continue;
      desiredNotional = Math.min(desiredNotional, cashAvail);
      if (desiredNotional <= 0) continue;
    }

    const copySize = desiredNotional / price;

    // cash impact
    const cashDelta = t.side === "BUY" ? -copySize * price : copySize * price;
    adjustCash(cashDelta);

    const realizedDelta = upsertPosition(t.condition_id, null, leaderWallet, t.side, copySize, price, t.timestamp);
    if (realizedDelta !== 0) addRealized(realizedDelta);
    recordFill(t, copySize, price, "paper");
    setLastProcessedId(t.id);
  }

  snapshotPortfolio();
  console.log(`Simulated ${pending.length} leader trades. Portfolio snapshot recorded.`);
}

if (process.argv[1]?.endsWith("paper.ts") || process.argv[1]?.endsWith("paper.js")) {
  runPaperOnce().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
