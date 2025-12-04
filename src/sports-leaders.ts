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
    const existing = db
      .prepare("SELECT condition_id, outcome FROM sports_positions_raw WHERE leader_wallet = ?")
      .all(wallet) as any[];
    const existingKeys = new Set(existing.map((r) => `${r.condition_id}||${r.outcome}`));

    const stmt = db.prepare(
      `INSERT INTO sports_positions_raw(leader_wallet, condition_id, outcome, size, avg_price, cur_price, current_value, title, slug, event_slug, category, updated_at, first_seen_at)
       VALUES (@leader_wallet, @condition_id, @outcome, @size, @avg_price, @cur_price, @current_value, @title, @slug, @event_slug, @category, @updated_at, @first_seen_at)
       ON CONFLICT(leader_wallet, condition_id, outcome) DO UPDATE SET
         size=excluded.size,
         avg_price=excluded.avg_price,
         cur_price=excluded.cur_price,
         current_value=excluded.current_value,
         title=excluded.title,
         slug=excluded.slug,
         event_slug=excluded.event_slug,
         category=excluded.category,
         updated_at=excluded.updated_at,
         first_seen_at=COALESCE(sports_positions_raw.first_seen_at, excluded.first_seen_at)`
    );

    const now = Date.now();
    const seen = new Set<string>();

    for (const p of positions) {
      const key = `${p.conditionId}||${p.outcome ?? ""}`;
      seen.add(key);
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
        first_seen_at: p.updatedAt ?? now,
      });
    }

    // Remove positions that are no longer open for this wallet
    for (const key of existingKeys) {
      if (!seen.has(key)) {
        const [condition_id, outcome] = key.split("||");
        db.prepare("DELETE FROM sports_positions_raw WHERE leader_wallet=? AND condition_id=? AND outcome=?").run(
          wallet,
          condition_id,
          outcome
        );
      }
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

  // Seed the cutoff after the first successful pass so initial load doesn't mark everything NEW
  const cutoffRow = db.prepare("SELECT value FROM sports_poll_state WHERE key='first_seen_cutoff'").get() as any;
  if (!cutoffRow) {
    const now = Date.now();
    db.prepare(
      "INSERT INTO sports_poll_state(key, value) VALUES('first_seen_cutoff', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(now));
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function scheduleNext(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loop, delay);
}

async function loop() {
  if (running) {
    // Skip overlapping runs to avoid DB lock contention
    await scheduleNext(2000);
    return;
  }
  running = true;
  try {
    await runOnce();
  } catch (err) {
    console.error("[sports] poll error", err);
    // small backoff on error
    await scheduleNext(Math.max(5000, SPORTS_POLL_INTERVAL_MS));
    running = false;
    return;
  }
  running = false;
  await scheduleNext(SPORTS_POLL_INTERVAL_MS);
}

export function startSportsPoller() {
  if (timer || SPORTS_LEADERS.length === 0) return;
  console.log(`Sports poller enabled for ${SPORTS_LEADERS.length} wallets every ${SPORTS_POLL_INTERVAL_MS} ms`);
  loop().catch((err) => console.error("[sports] initial run failed", err));
}

export function stopSportsPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function getAggregatedSportsPositions() {
  const rows = db
    .prepare(
      `SELECT
         sp.condition_id,
         sp.outcome,
         COALESCE(MAX(sp.title), '') AS title,
         COALESCE(MAX(sp.slug), '') AS slug,
         COALESCE(MAX(sp.event_slug), '') AS event_slug,
         COALESCE(MAX(sp.category), '') AS category,
         SUM(sp.size) AS total_size,
         AVG(sp.cur_price) AS mark_price,
         SUM(sp.current_value) AS total_usd,
         COUNT(DISTINCT sp.leader_wallet) AS wallet_count,
         GROUP_CONCAT(sp.leader_wallet, ',') AS holders,
         MAX(sp.updated_at) AS last_updated,
         MIN(sp.first_seen_at) AS first_seen,
         sr.reviewed_at AS reviewed_at
       FROM sports_positions_raw sp
       LEFT JOIN sports_reviews sr ON sr.condition_id = sp.condition_id AND sr.outcome = sp.outcome
       GROUP BY sp.condition_id, sp.outcome
       ORDER BY total_usd DESC`
    )
    .all();

  const last = db.prepare("SELECT value FROM sports_poll_state WHERE key='last_success'").get() as any;
  const cutoffRow = db.prepare("SELECT value FROM sports_poll_state WHERE key='first_seen_cutoff'").get() as any;
  const firstSeenCutoff = cutoffRow ? Number(cutoffRow.value) : null;
  let unreadCount = 0;
  return {
    lastUpdated: last ? Number(last.value) : null,
    firstSeenCutoff,
    rows: rows.map((r: any) => {
      const firstSeen = r.first_seen ? Number(r.first_seen) : null;
      const reviewedAt = r.reviewed_at ? Number(r.reviewed_at) : null;
      const reviewed = reviewedAt != null && (firstSeen == null || reviewedAt >= firstSeen);
      const isUnread =
        firstSeenCutoff != null &&
        firstSeen != null &&
        firstSeen > firstSeenCutoff &&
        !reviewed;
      if (isUnread) unreadCount += 1;
      return {
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
        firstSeen,
        reviewedAt,
        reviewed,
        isUnread,
      };
    }),
    unreadCount,
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
