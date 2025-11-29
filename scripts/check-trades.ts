import "dotenv/config";
import { fetchTradesForWallet } from "../dist/polymarket.js";

const wallets =
  process.env.WALLETS?.split(",")
    .map((w) => w.trim())
    .filter(Boolean) ?? [];

if (wallets.length === 0) {
  console.error("No wallets found in WALLETS env var.");
  process.exit(1);
}

// Target window: after deployment at 12:14:54 AM local today until now.
const startLocal = new Date("2025-11-29T00:14:54");
const endLocal = new Date();
const startMs = startLocal.getTime();
const endMs = endLocal.getTime();

function fmt(ts: number | undefined) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.toLocaleString()} (${d.toISOString()})`;
}

async function fetchForWallet(wallet: string) {
  try {
    const trades = await fetchTradesForWallet(wallet, 500);
    const windowTrades = trades
      .filter((t) => t.timestamp >= startMs && t.timestamp <= endMs)
      .sort((a, b) => a.timestamp - b.timestamp);

    const { length } = windowTrades;
    const firstTs = windowTrades[0]?.timestamp;
    const lastTs = windowTrades[length - 1]?.timestamp;

    return {
      wallet,
      count: length,
      first: firstTs,
      last: lastTs,
      sample: windowTrades.slice(-3), // show most recent few
    };
  } catch (err) {
    return { wallet, error: (err as Error).message };
  }
}

async function main() {
  console.log(
    `Checking trades for ${wallets.length} wallets between ${fmt(startMs)} and ${fmt(endMs)}`
  );

  const results = await Promise.all(wallets.map((w) => fetchForWallet(w)));

  console.log("\nPer-wallet counts:");
  results.forEach((r) => {
    if ("error" in r) {
      console.log(`${r.wallet}: ERROR ${r.error}`);
    } else {
      console.log(
        `${r.wallet}: ${r.count} trades (first: ${fmt(r.first)}, last: ${fmt(
          r.last
        )})`
      );
    }
  });

  console.log("\nSamples of most recent trades within window (up to 3 each):");
  results.forEach((r) => {
    if ("error" in r) {
      console.log(`\n${r.wallet}: ERROR ${r.error}`);
      return;
    }
    console.log(`\n${r.wallet}: ${r.count} trade(s)`);
    (r.sample ?? []).forEach((t) => {
      console.log(
        `  ${fmt(t.timestamp)} | ${t.side} ${t.size} @ ${t.price} | market: ${t.marketSlug ?? t.marketQuestion ?? ""} | tx ${t.transactionHash}`
      );
    });
  });
}

main().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});
