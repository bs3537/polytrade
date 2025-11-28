import axios from "axios";
import { DATA_API_BASE, GAMMA_API_BASE } from "./config";

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
  const resp = await axios.get(url, {
    params: {
      user: wallet,
      limit,
      takerOnly: true,
    },
    timeout: 10000,
  });

  const trades = resp.data?.data ?? resp.data ?? [];
  return trades.map((t: any) => ({
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
  }));
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
  const resp = await axios.get(url, {
    params: { user: userWallet },
    timeout: 8000,
  });
  const value = resp.data?.value ?? resp.data?.data?.value;
  return Number(value ?? 0);
}
