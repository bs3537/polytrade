import { initDb, db } from "./db.js";
import { WALLETS, POLL_INTERVAL_MS } from "./config.js";
import { fetchTradesForWalletPaged, fetchMarketByConditionId } from "./polymarket.js";

initDb();

const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO leader_trades
    (proxy_wallet, transaction_hash, condition_id, asset_id, side, size, price, timestamp, market_slug, market_title)
  VALUES
    (@proxyWallet, @transactionHash, @conditionId, @assetId, @side, @size, @price, @timestamp, @marketSlug, @marketTitle);
`);

const upsertMarket = db.prepare(`
  INSERT INTO markets (condition_id, slug, title, category, end_date, updated_at)
  VALUES (@conditionId, @slug, @title, @category, @endDate, strftime('%s','now')*1000)
  ON CONFLICT(condition_id) DO UPDATE SET
    slug=excluded.slug,
    title=excluded.title,
    category=excluded.category,
    end_date=excluded.end_date,
    updated_at=excluded.updated_at;
`);

async function handleMarket(conditionId: string) {
  if (!conditionId) return;
  const exists = db
    .prepare("SELECT 1 FROM markets WHERE condition_id = ?")
    .get(conditionId);
  if (exists) return;
  const market = await fetchMarketByConditionId(conditionId);
  if (market) {
    upsertMarket.run(market);
  }
}

async function ingestOnce() {
  if (WALLETS.length === 0) {
    console.error("Configure WALLETS before running ingestion.");
    process.exit(1);
  }

  for (const wallet of WALLETS) {
    try {
      const tsRow = db.prepare("SELECT MAX(timestamp) as ts FROM leader_trades WHERE proxy_wallet = ?").get(wallet) as
        | { ts?: number }
        | undefined;
      const latest = tsRow?.ts ?? 0;

      const trades = await fetchTradesForWalletPaged(wallet, {
        sinceTimestamp: latest || undefined,
        limit: 500,
        maxPages: 40,
      });
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
        await handleMarket(t.conditionId);
      }
      console.log(
        `Synced ${trades.length} trades for ${wallet} (since ${latest ? new Date(latest).toISOString() : "beginning"})`
      );
    } catch (err) {
      console.error(`Error ingesting ${wallet}`, err);
    }
  }
}

async function main() {
  await ingestOnce();
  if (POLL_INTERVAL_MS > 0) {
    setInterval(ingestOnce, POLL_INTERVAL_MS);
  } else {
    process.exit(0);
  }
}

main();
