import { WALLETS, PAPER_SLIPPAGE_BPS, HISTORICAL_INGEST_ENABLED } from "./config.js";
import { db, initDb } from "./db.js";
import { fetchTradesForWallet, fetchMarketByConditionId } from "./polymarket.js";
import { setTimeout as sleep } from "timers/promises";
import { runPaperOnce } from "./paper.js";
import { startRTDS } from "./rtds.js";

const LOOP_MS = Number(process.env.PAPER_LOOP_MS ?? 10000);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT ?? 10000);

async function ingestOnce() {
  const insertTrade = db.prepare(`
    INSERT OR IGNORE INTO leader_trades
      (proxy_wallet, transaction_hash, condition_id, asset_id, side, size, price, timestamp, market_slug, market_title)
    VALUES
      (@proxyWallet, @transactionHash, @conditionId, @assetId, @side, @size, @price, @timestamp, @marketSlug, @marketTitle);
  `);
  for (const w of WALLETS) {
    const trades = await fetchTradesForWallet(w, 500);
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
}

async function saveTrade(t: any) {
  const insertTrade = db.prepare(`
    INSERT OR IGNORE INTO leader_trades
      (proxy_wallet, transaction_hash, condition_id, asset_id, side, size, price, timestamp, market_slug, market_title)
    VALUES
      (@proxyWallet, @transactionHash, @conditionId, @assetId, @side, @size, @price, @timestamp, @marketSlug, @marketTitle);
  `);
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
  await fetchMarketByConditionId(t.conditionId);
}

async function loop() {
  initDb();

  // Start RTDS listener: save trade, then process pending trades without pulling history
  startRTDS(async (trade) => {
    await saveTrade(trade);
    try {
      await runPaperOnce({ fetchHistorical: false });
    } catch (err) {
      console.error("paper loop (RTDS) error", err);
    }
  });

  while (true) {
    try {
      // Always run ingest to avoid missing RTDS drops; HISTORICAL_INGEST_ENABLED keeps backward compatibility for full history pulls.
      if (HISTORICAL_INGEST_ENABLED) {
        await ingestOnce();
      } else {
        // Light ingest even when historical disabled to catch recent trades.
        await ingestOnce();
      }
      await runPaperOnce({ fetchHistorical: HISTORICAL_INGEST_ENABLED });
    } catch (err) {
      console.error("daemon error", err);
    }
    await sleep(LOOP_MS);
  }
}

loop();
