import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair } from "@solana/web3.js";

export const REPO_ROOT = new URL("../../../", import.meta.url);

try {
  process.loadEnvFile(new URL(".env", REPO_ROOT));
} catch {
  // On the server the environment is set directly.
}

const num = (name: string, fallback: number) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
};

function keypairFile(envName: string, fallback: string): Keypair {
  const path = (process.env[envName] || fallback).replace(/^~(?=\/)/, homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export const config = {
  port: num("PORT", 4000),
  rpcUrl: process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
  /** What Solana Explorer should fetch from (the validator's public URL in production). */
  explorerRpcUrl: process.env.PUBLIC_RPC_URL || process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899",
  tigerUrl: process.env.TIGER_DATABASE_URL ?? "",
  seed: process.env.SIM_WALLET_SEED ?? "",
  /** On-chain households per run (sampled from the full-scale allocation). */
  households: num("SIM_HOUSEHOLDS", 20_000),
  merchantsMax: num("SIM_MERCHANTS_MAX", 500),
  /** Payment transactions per second the sim may send (disbursements always go first). */
  maxTps: num("SIM_MAX_TPS", 400),
  feePayers: num("SIM_FEE_PAYERS", 8),
  defaultStorm: process.env.SIM_DEFAULT_STORM || "helene-2024",
  /** The public site (token metadata image and links). */
  siteUrl: (process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://rescu.tech").replace(/\/$/, ""),
  /** Required to control the shared run and act as oracle/merchant/break-it on a public deploy; empty = open (local dev). */
  presenterKey: process.env.PRESENTER_KEY ?? "",
};

export function loadKeys() {
  return {
    admin: keypairFile("ADMIN_KEYPAIR", "~/.config/rescu/admin.json"),
    oracle: keypairFile("ORACLE_KEYPAIR", "~/.config/rescu/oracle.json"),
    relayer: keypairFile("RELAYER_KEYPAIR", "~/.config/rescu/relayer.json"),
    agent: keypairFile("AGENT_KEYPAIR", "~/.config/rescu/agent.json"),
  };
}
export type Keys = ReturnType<typeof loadKeys>;
