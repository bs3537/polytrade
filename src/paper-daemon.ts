import { WALLETS, PAPER_SLIPPAGE_BPS } from "./config.js";
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

  // Start RTDS listener
  startRTDS(async (trade) => {
    await saveTrade(trade);
  });

  while (true) {
    try {
      await ingestOnce();
      await runPaperOnce();
    } catch (err) {
      console.error("daemon error", err);
    }
    await sleep(LOOP_MS);
  }
}

loop();
