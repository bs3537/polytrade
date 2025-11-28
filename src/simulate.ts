import fs from "fs";
import path from "path";
import { db, initDb } from "./db.ts";

type Rule = {
  label: string;
  wallets: string[];
  mode: "COPY" | "COUNTER";
  sizeMode: "FIXED_USDC";
  fixedUsdc: number;
  maxUsdcPerTrade?: number;
  allowedCategories?: string[];
};

const rulesPath = path.resolve("follow-rules.json");
const rules: Rule[] = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));

initDb();

const trades = db
  .prepare(
    `
    SELECT lt.id, lt.proxy_wallet, lt.condition_id, lt.side, lt.size, lt.price, lt.timestamp,
           m.category
    FROM leader_trades lt
    LEFT JOIN markets m ON m.condition_id = lt.condition_id
    ORDER BY lt.timestamp ASC
  `
  )
  .all();

const insertIntent = db.prepare(`
  INSERT OR IGNORE INTO copy_orders_intent
    (leader_trade_id, proxy_wallet, condition_id, side, desired_size, desired_notional, rule_label, created_at)
  VALUES
    (@leaderTradeId, @proxyWallet, @conditionId, @side, @desiredSize, @desiredNotional, @ruleLabel, strftime('%s','now')*1000);
`);

const existingIntent = db.prepare(
  "SELECT 1 FROM copy_orders_intent WHERE leader_trade_id = ? AND rule_label = ?"
);

let generated = 0;

for (const t of trades) {
  for (const rule of rules) {
    if (!rule.wallets.map((w) => w.toLowerCase()).includes(String(t.proxy_wallet).toLowerCase())) {
      continue;
    }
    if (rule.allowedCategories && rule.allowedCategories.length > 0) {
      if (!rule.allowedCategories.includes(t.category ?? "")) continue;
    }
    if (existingIntent.get(t.id, rule.label)) {
      continue;
    }

    const targetNotional =
      rule.sizeMode === "FIXED_USDC"
        ? Math.min(rule.fixedUsdc, rule.maxUsdcPerTrade ?? Number.MAX_SAFE_INTEGER)
        : 0;

    const followerSide = rule.mode === "COUNTER" ? (t.side === "BUY" ? "SELL" : "BUY") : t.side;
    const desiredSize = targetNotional / Number(t.price || 1);

    insertIntent.run({
      leaderTradeId: t.id,
      proxyWallet: t.proxy_wallet,
      conditionId: t.condition_id,
      side: followerSide,
      desiredSize,
      desiredNotional: targetNotional,
      ruleLabel: rule.label,
    });
    generated += 1;
  }
}

console.log(`Generated ${generated} simulated copy order intents.`);
