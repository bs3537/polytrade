import axios from "axios";
import { DATA_API_BASE, GAMMA_API_BASE } from "./config.js";

export type Trade = {
  transactionHash: string;
  conditionId: string;
  assetId: string;
  proxyWallet: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  timestamp: number;
  marketSlug?: string;
  marketQuestion?: string;
};

export async function fetchTradesForWallet(wallet: string, limit = 100): Promise<Trade[]> {
  const url = `${DATA_API_BASE}/trades`;
  let lastErr: any;
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await axios.get(url, {
        params: {
          user: wallet,
          limit,
          takerOnly: true,
        },
        timeout: 10000,
      });
      const trades = resp.data?.data ?? resp.data ?? [];
      return trades.map(mapTrade);
    } catch (err: any) {
      lastErr = err;
      // Retry on 429/5xx, else break
      const status = err?.response?.status;
      if (status && status < 500 && status !== 429) break;
      if (i < 2) {
        const backoff = 300 * (i + 1) + Math.random() * 100;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr ?? new Error("fetchTradesForWallet failed");
}

// Fetch all trades for a wallet, walking back in time in pages until we
// either exhaust results or reach a provided lower bound timestamp.
export async function fetchTradesForWalletPaged(
  wallet: string,
  opts: { sinceTimestamp?: number; limit?: number; maxPages?: number } = {}
): Promise<Trade[]> {
  const { sinceTimestamp, limit = 500, maxPages = 30 } = opts;
  const url = `${DATA_API_BASE}/trades`;
  const all: Trade[] = [];
  let offset = 0;
  let lastErr: any;

  for (let page = 0; page < maxPages; page++) {
    try {
      const resp = await axios.get(url, {
        params: {
          user: wallet,
          limit,
          offset,
          takerOnly: true,
        },
        timeout: 12000,
      });
      const raw = resp.data?.data ?? resp.data ?? [];
      const trades = raw.map(mapTrade);
      if (trades.length === 0) break;

      all.push(...trades);

      const oldestTs = Math.min(...trades.map((t) => t.timestamp));
      const hitLowerBound = sinceTimestamp !== undefined && oldestTs <= sinceTimestamp;
      if (trades.length < limit || hitLowerBound) break;

      offset += limit;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      // Retry on 429/5xx and keep paging, otherwise stop early.
      if (status && status < 500 && status !== 429) break;
      await new Promise((r) => setTimeout(r, 250 * (page + 1)));
    }
  }

  if (all.length === 0 && lastErr) {
    throw lastErr;
  }

  return all;
}

function mapTrade(t: any): Trade {
  return {
    transactionHash: t.transactionHash,
    conditionId: t.conditionId ?? t.conditionIdV2 ?? "",
    assetId: t.assetId,
    proxyWallet: t.proxyWallet,
    price: Number(t.price),
    size: Number(t.size),
    side: t.side?.toUpperCase() === "SELL" ? "SELL" : "BUY",
    timestamp: Number(t.timestamp) * 1000, // API returns seconds
    marketSlug: t.market?.slug ?? t.slug ?? undefined,
    marketQuestion: t.market?.question ?? t.question ?? undefined,
  };
}

export async function fetchMarketByConditionId(conditionId: string) {
  const url = `${GAMMA_API_BASE}/markets`;
  const resp = await axios.get(url, {
    params: {
      conditionId,
    },
    timeout: 10000,
  });

  const market = resp.data?.markets?.[0];
  if (!market) return null;

  return {
    conditionId,
    slug: market.slug,
    title: market.title ?? market.question,
    category: market.category,
    endDate: market.endDate,
  };
}

export async function fetchPortfolioValue(userWallet: string): Promise<number> {
  if (!userWallet) throw new Error("userWallet is required for fetchPortfolioValue");
  const url = `${DATA_API_BASE}/value`;
  let lastErr: any;
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await axios.get(url, {
        params: { user: userWallet },
        timeout: 8000,
      });
      const value = resp.data?.value ?? resp.data?.data?.value;
      return Number(value ?? 0);
    } catch (err) {
      lastErr = err;
      if (i < 2) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr ?? new Error("fetchPortfolioValue failed");
}

export async function fetchLeaderValue(userWallet: string): Promise<number> {
  try {
    return await fetchPortfolioValue(userWallet);
  } catch {
    return 0;
  }
}
