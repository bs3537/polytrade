import { ethers } from "ethers";
import { RPC_URL, CHAIN_ID } from "./config.js";

let provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!RPC_URL) {
    throw new Error("RPC_URL is required for provider");
  }
  if (!provider) {
    // Pass chain id to skip network auto-detect (prevents startup spam/rate-limit retries)
    provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  }
  return provider;
}
