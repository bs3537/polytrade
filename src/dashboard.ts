import path from "path";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { db, initDb } from "./db.js";
import { PAPER_MODE, LIVE_TRADING_ENABLED } from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

const fastify = Fastify({ logger: false });

function latestPricesMap() {
  const rows = db
    .prepare(
      `
        SELECT lt.condition_id, lt.price
        FROM leader_trades lt
        JOIN (
          SELECT condition_id, MAX(id) AS max_id
          FROM leader_trades
          GROUP BY condition_id
        ) last ON last.max_id = lt.id
      `
    )
    .all() as any[];
  return rows.reduce((m: Record<string, number>, r: any) => {
    m[r.condition_id] = Number(r.price);
    return m;
  }, {});
}

function computePaperPortfolio() {
  const positions = db
    .prepare("SELECT size, avg_price, condition_id FROM paper_positions")
    .all() as any[];
  const latest = latestPricesMap();
  const unreal = positions.reduce((acc, r) => {
    const mark = latest[r.condition_id] ?? Number(r.avg_price);
    return acc + Number(r.size) * (mark - Number(r.avg_price));
  }, 0);
  const posValue = positions.reduce((acc, r) => {
    const mark = latest[r.condition_id] ?? Number(r.avg_price);
    return acc + Number(r.size) * mark;
  }, 0);
  const cashRow = db.prepare("SELECT value FROM paper_state WHERE key='paper_cash'").get() as any;
  const cash = cashRow ? Number(cashRow.value) : 0;
  const realizedRow = db.prepare("SELECT value FROM paper_state WHERE key='paper_realized'").get() as any;
  const realized = realizedRow ? Number(realizedRow.value) : 0;
  const equity = cash + posValue;
  return { equity, cash, unrealized: unreal, realized };
}

function computeLivePortfolio() {
  // Rebuild positions and cash from live_fills (non-failed)
  const fills = db
    .prepare(
      `SELECT condition_id, side, price, size, notional
       FROM live_fills
       WHERE status != 'FAILED'
       ORDER BY id ASC`
    )
    .all() as any[];

  let cash = 0;
  const pos = new Map<
    string,
    { size: number; avg: number }
  >();

  for (const f of fills) {
    const key = f.condition_id;
    const signedSize = Number(f.size) * (f.side === "BUY" ? 1 : -1);
    // cash updates
    cash += f.side === "BUY" ? -Number(f.notional) : Number(f.notional);
    // position updates (VWAP)
    const entry = pos.get(key) ?? { size: 0, avg: 0 };
    const prevSize = entry.size;
    const prevAvg = entry.avg;
    const combined = prevSize + signedSize;
    let newAvg = prevAvg;
    if (combined === 0) {
      pos.delete(key);
      continue;
    }
    if (Math.sign(prevSize) === Math.sign(combined)) {
      // same direction -> vwap
      const prevNotional = Math.abs(prevSize) * prevAvg;
      const addNotional = Math.abs(signedSize) * Number(f.price);
      newAvg = (prevNotional + addNotional) / Math.abs(combined);
    } else {
      // reducing/flip: keep avg
      newAvg = prevAvg;
    }
    pos.set(key, { size: combined, avg: newAvg });
  }

  const latest = latestPricesMap();
  let unreal = 0;
  let posValue = 0;
  for (const [cond, { size, avg }] of pos.entries()) {
    const mark = latest[cond] ?? avg;
    unreal += size * (mark - avg);
    posValue += size * mark;
  }
  const realized = 0; // we do not track realized yet
  const equity = cash + posValue;
  return { equity, cash, unrealized: unreal, realized };
}

async function build() {
  initDb();
  fastify.addHook("onRequest", (req, _reply, done) => {
    console.log(`[req] ${req.method} ${req.url}`);
    done();
  });
  await fastify.register(fastifyCors, { origin: "*" });
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    wildcard: false,
  });

  fastify.get("/healthz", async () => ({ ok: true }));

  fastify.get("/api/portfolio", async () => {
    console.log("portfolio: start");
    const data =
      !PAPER_MODE && LIVE_TRADING_ENABLED ? computeLivePortfolio() : computePaperPortfolio();
    return { ...data, timestamp: Date.now(), mode: !PAPER_MODE && LIVE_TRADING_ENABLED ? "live" : "paper" };
  });

  fastify.get("/api/positions", async () => {
    if (!PAPER_MODE && LIVE_TRADING_ENABLED) {
      // Aggregate from live_fills
      const fills = db
        .prepare(
          `SELECT condition_id, side, price, size
           FROM live_fills
           WHERE status != 'FAILED'
           ORDER BY id ASC`
        )
        .all() as any[];
      const latest = latestPricesMap();
      const pos = new Map<
        string,
        { size: number; avg: number }
      >();
      for (const f of fills) {
        const key = f.condition_id;
        const signedSize = Number(f.size) * (f.side === "BUY" ? 1 : -1);
        const entry = pos.get(key) ?? { size: 0, avg: 0 };
        const prevSize = entry.size;
        const prevAvg = entry.avg;
        const combined = prevSize + signedSize;
        let newAvg = prevAvg;
        if (combined === 0) {
          pos.delete(key);
          continue;
        }
        if (Math.sign(prevSize) === Math.sign(combined)) {
          const prevNotional = Math.abs(prevSize) * prevAvg;
          const addNotional = Math.abs(signedSize) * Number(f.price);
          newAvg = (prevNotional + addNotional) / Math.abs(combined);
        }
        pos.set(key, { size: combined, avg: newAvg });
      }
      return Array.from(pos.entries()).map(([condition_id, { size, avg }]) => {
        const mark = latest[condition_id] ?? avg;
        const unreal = size * (mark - avg);
        const notional = size * avg;
        return {
          leader_wallet: "live",
          condition_id,
          size,
          avg_price: avg,
          updated_at: null,
          title: null,
          mark_price: mark,
          unrealized: unreal,
          notional,
        };
      });
    } else {
      const rows = db
        .prepare(
          `SELECT
              p.leader_wallet,
              p.condition_id,
              SUM(p.size) AS size,
              SUM(p.size * p.avg_price) / NULLIF(SUM(p.size),0) AS avg_price,
              MAX(p.updated_at) AS updated_at,
              m.title,
              (
                SELECT price FROM leader_trades lt
                WHERE lt.condition_id = p.condition_id
                ORDER BY lt.timestamp DESC
                LIMIT 1
              ) AS mark_price
           FROM paper_positions p
           LEFT JOIN markets m ON m.condition_id = p.condition_id
           GROUP BY p.leader_wallet, p.condition_id, m.title`
        )
        .all();
      return rows.map((r: any) => {
        const mark = Number(r.mark_price ?? r.avg_price);
        const unreal = Number(r.size) * (mark - Number(r.avg_price));
        const notional = Number(r.size) * Number(r.avg_price);
        return { ...r, mark_price: mark, unrealized: unreal, notional };
      });
    }
  });

  fastify.get("/api/closed", async (req) => {
    const limit = Number((req.query as any)?.limit ?? 50);
    const rows = db
      .prepare(
        `SELECT f.id, f.leader_wallet, f.condition_id, f.side, f.price, f.size, f.notional,
                f.timestamp, COALESCE(m.title, lt.market_title) as title
         FROM paper_fills f
         LEFT JOIN leader_trades lt ON lt.id = f.leader_trade_id
         LEFT JOIN markets m ON m.condition_id = f.condition_id
         WHERE f.side = 'SELL' -- proxy: sells often close/reduce; we compute realized from fills
         ORDER BY f.id DESC
         LIMIT ?`
      )
      .all(limit);
    return rows;
  });

  fastify.get("/api/fills", async (req) => {
    const limit = Number((req.query as any)?.limit ?? 50);
    if (!PAPER_MODE && LIVE_TRADING_ENABLED) {
      return db
        .prepare(
          `SELECT leader_wallet, condition_id, side, price, size, notional, submitted_at as timestamp,
                  status, tx_hash
           FROM live_fills
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(limit);
    } else {
      const rows = db
        .prepare(
          `SELECT f.leader_wallet, f.condition_id, f.side, f.price, f.size, f.notional, f.timestamp,
                  COALESCE(m.title, lt.market_title) as title
           FROM paper_fills f
           LEFT JOIN leader_trades lt ON lt.id = f.leader_trade_id
           LEFT JOIN markets m ON m.condition_id = f.condition_id
           ORDER BY f.id DESC
           LIMIT ?`
        )
        .all(limit);
      return rows;
    }
  });

  fastify.get("/api/equity", async (req) => {
    const q = (req.query ?? {}) as any;
    const intervalSec = Number(q.intervalSec ?? 300); // default 5m
    const limit = Number(q.limit ?? 288); // default ~24h at 5m

    if (!PAPER_MODE && LIVE_TRADING_ENABLED) {
      // Build synthetic equity series from live_fills snapshots (simple approach: latest point only)
      const portfolio = computeLivePortfolio();
      return [
        {
          timestamp: Date.now(),
          equity: portfolio.equity,
          cash: portfolio.cash,
          unrealized: portfolio.unrealized,
          realized: portfolio.realized,
        },
      ];
    } else {
      // Pick the latest sample per bucket
      const rows = db
        .prepare(
          `
          WITH buckets AS (
            SELECT CAST(timestamp/1000/? AS INT) AS bucket, MAX(timestamp) AS max_ts
            FROM paper_portfolio
            GROUP BY bucket
            ORDER BY max_ts DESC
            LIMIT ?
          )
          SELECT p.timestamp, p.equity, p.cash, p.unrealized, p.realized
          FROM paper_portfolio p
          JOIN buckets b ON p.timestamp = b.max_ts
          ORDER BY p.timestamp ASC
        `
        )
        .all(intervalSec, limit);
      return rows;
    }
  });

  fastify.setNotFoundHandler((req, reply) => {
    reply.redirect("/");
  });

  fastify.setErrorHandler((error, _request, reply) => {
    console.error("dashboard error", error);
    reply.status(500).send({ error: error.message ?? "internal error" });
  });

  const port = Number(process.env.PORT ?? process.env.DASHBOARD_PORT ?? 3000);
  await fastify.listen({ port, host: "0.0.0.0" });
  console.log(`Dashboard running at http://localhost:${port}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
