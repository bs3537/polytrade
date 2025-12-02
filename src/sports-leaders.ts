import { db } from "./db.js";
import {
  SPORTS_CATEGORY,
  SPORTS_LEADERS,
  SPORTS_POLL_INTERVAL_MS,
  SPORTS_SIZE_THRESHOLD,
} from "./config.js";
import {
  Position,
  fetchMarketByConditionId,
  fetchPositionsForWallet,
} from "./polymarket.js";

// Simple in-memory cache for market metadata to avoid hammering Gamma API
const marketCache = new Map<string, { title?: string; slug?: string; eventSlug?: string; category?: string; ts: number }>();
const MARKET_TTL_MS = 15 * 60 * 1000;

async function ensureMarketMeta(conditionId: string): Promise<{ title?: string; slug?: string; eventSlug?: string; category?: string }> {
  const now = Date.now();
  const cached = marketCache.get(conditionId);
  if (cached && now - cached.ts < MARKET_TTL_MS) return cached;

  const m = await fetchMarketByConditionId(conditionId);
  const record = {
    title: m?.title,
    slug: m?.slug,
    eventSlug: m?.eventSlug,
    category: m?.category?.toLowerCase(),
    ts: now,
  };
  marketCache.set(conditionId, record);

  if (m) {
    db.prepare(
      `INSERT INTO markets(condition_id, slug, title, category, end_date, updated_at)
       VALUES(@condition_id, @slug, @title, @category, @end_date, strftime('%s','now')*1000)
       ON CONFLICT(condition_id) DO UPDATE SET slug=excluded.slug, title=excluded.title, category=excluded.category, end_date=excluded.end_date, updated_at=excluded.updated_at`
    ).run({
      condition_id: conditionId,
      slug: m.slug,
      title: m.title,
      category: m.category,
      end_date: m.endDate,
    });
  }

  return record;
}

function upsertSportsRows(wallet: string, positions: Position[]) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM sports_positions_raw WHERE leader_wallet = ?").run(wallet);
    const stmt = db.prepare(
      `INSERT INTO sports_positions_raw(leader_wallet, condition_id, outcome, size, avg_price, cur_price, current_value, title, slug, event_slug, category, updated_at)
       VALUES (@leader_wallet, @condition_id, @outcome, @size, @avg_price, @cur_price, @current_value, @title, @slug, @event_slug, @category, @updated_at)`
    );
    const now = Date.now();
    for (const p of positions) {
      stmt.run({
        leader_wallet: wallet,
        condition_id: p.conditionId,
        outcome: p.outcome ?? "",
        size: p.size,
        avg_price: p.avgPrice,
        cur_price: p.markPrice,
        current_value: p.currentValue,
        title: p.title ?? null,
        slug: p.slug ?? null,
        event_slug: p.eventSlug ?? null,
        category: p.category ?? null,
        updated_at: p.updatedAt ?? now,
      });
    }
    db.prepare(
      "INSERT INTO sports_poll_state(key, value) VALUES('last_success', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(now));
  });
  tx();
}

async function pollWallet(wallet: string) {
  const positions = await fetchPositionsForWallet(wallet, { sizeThreshold: SPORTS_SIZE_THRESHOLD });

  // Normalize metadata & filter to sports category
  const enriched: Position[] = [];
  for (const p of positions) {
    let category = p.category?.toLowerCase();
    if (!category || category === "") {
      const meta = await ensureMarketMeta(p.conditionId);
      category = meta.category;
      p.title = p.title ?? meta.title;
      p.slug = p.slug ?? meta.slug;
      p.eventSlug = p.eventSlug ?? meta.eventSlug;
      p.category = category;
    }
    if (category && category !== SPORTS_CATEGORY) continue;
    enriched.push(p);
  }

  upsertSportsRows(wallet, enriched);
}

async function runOnce() {
  if (SPORTS_LEADERS.length === 0) return;

  // Small concurrency: process 3 wallets at a time
  const batchSize = 3;
  for (let i = 0; i < SPORTS_LEADERS.length; i += batchSize) {
    const slice = SPORTS_LEADERS.slice(i, i + batchSize);
    await Promise.all(
      slice.map(async (w) => {
        try {
          await pollWallet(w);
          console.log(`[sports] updated wallet ${w}`);
        } catch (err: any) {
          console.error(`[sports] failed wallet ${w}:`, err?.message ?? err);
        }
      })
    );
  }
}

let timer: NodeJS.Timeout | null = null;

export function startSportsPoller() {
  if (timer || SPORTS_LEADERS.length === 0) return;
  console.log(`Sports poller enabled for ${SPORTS_LEADERS.length} wallets every ${SPORTS_POLL_INTERVAL_MS} ms`);
  // Kick once immediately, then interval
  runOnce().catch((err) => console.error("[sports] initial run failed", err));
  timer = setInterval(() => runOnce().catch((err) => console.error("[sports] poll error", err)), SPORTS_POLL_INTERVAL_MS);
}

export function stopSportsPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function getAggregatedSportsPositions() {
  const rows = db
    .prepare(
      `SELECT
         condition_id,
         outcome,
         COALESCE(MAX(title), '') AS title,
         COALESCE(MAX(slug), '') AS slug,
         COALESCE(MAX(event_slug), '') AS event_slug,
         COALESCE(MAX(category), '') AS category,
         SUM(size) AS total_size,
         AVG(cur_price) AS mark_price,
         SUM(current_value) AS total_usd,
         COUNT(DISTINCT leader_wallet) AS wallet_count,
         GROUP_CONCAT(leader_wallet, ',') AS holders,
         MAX(updated_at) AS last_updated
       FROM sports_positions_raw
       GROUP BY condition_id, outcome
       ORDER BY total_usd DESC`
    )
    .all();

  const last = db.prepare("SELECT value FROM sports_poll_state WHERE key='last_success'").get() as any;
  return {
    lastUpdated: last ? Number(last.value) : null,
    rows: rows.map((r: any) => ({
      conditionId: r.condition_id,
      outcome: r.outcome,
      title: r.title || r.condition_id,
      slug: r.slug || null,
      eventSlug: r.event_slug || null,
      category: r.category || null,
      totalSize: Number(r.total_size ?? 0),
      markPrice: Number(r.mark_price ?? 0),
      totalUsd: Number(r.total_usd ?? 0),
      walletCount: Number(r.wallet_count ?? 0),
      holders: (r.holders ?? "")
        .split(",")
        .filter((h: string) => h)
        .slice(0, 5),
      lastUpdated: Number(r.last_updated ?? 0),
    })),
  };
}

export function getRawSportsPositions() {
  return db
    .prepare(
      `SELECT leader_wallet, condition_id, outcome, size, avg_price, cur_price, current_value, title, slug, event_slug, category, updated_at
       FROM sports_positions_raw
       ORDER BY updated_at DESC`
    )
    .all();
}
