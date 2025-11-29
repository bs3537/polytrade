import "dotenv/config";
import { db, initDb } from "../dist/db.js";
import { PAPER_START_EQUITY } from "../dist/config.js";

// Deploy-time start: 2025-11-29 00:14:54 local
const DEPLOY_START = new Date("2025-11-29T00:14:54").getTime();

initDb();

function main() {
  const maxIdRow = db.prepare("SELECT MAX(id) as maxId FROM leader_trades").get() as any;
  const maxId = Number(maxIdRow?.maxId ?? 0);

  db.prepare("INSERT INTO paper_state(key,value) VALUES('paper_cash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    PAPER_START_EQUITY
  );
  db.prepare("INSERT INTO paper_state(key,value) VALUES('paper_realized','0') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  db.prepare("INSERT INTO paper_state(key,value) VALUES('paper_start_ts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    DEPLOY_START
  );
  db.prepare("INSERT INTO paper_state(key,value) VALUES('last_trade_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    maxId
  );

  console.log("paper_state updated:");
  console.log(`  paper_cash      = ${PAPER_START_EQUITY}`);
  console.log("  paper_realized  = 0");
  console.log(`  paper_start_ts  = ${DEPLOY_START} (${new Date(DEPLOY_START).toString()})`);
  console.log(`  last_trade_id   = ${maxId}`);
}

main();
