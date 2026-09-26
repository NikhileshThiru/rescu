import { PublicKey } from "@solana/web3.js";
import idl from "./idl/rescu.json" with { type: "json" };

export const PROGRAM_ID = new PublicKey(idl.address);

/** Relief dollars mirror USDC: 6 decimals. */
export const DECIMALS = 6;
export const BASE_UNITS_PER_USD = 1_000_000n;

export const SEEDS = {
  authority: Buffer.from("authority"),
  mint: Buffer.from("mint"),
  declaration: Buffer.from("decl"),
  wallet: Buffer.from("wallet"),
  merchant: Buffer.from("merchant"),
  extraAccountMetas: Buffer.from("extra-account-metas"),
} as const;

export const SIM = {
  HOUR: 3_600,
  DAY: 86_400,
  /** One sim day per real minute (the demo default). */
  ONE_DAY_PER_MINUTE: 1_440,
} as const;

export const DEFAULT_RULES = {
  perOrderCapUsd: 200,
  dailyCapUsd: 300,
  aidDurationSecs: 30 * SIM.DAY,
} as const;

/** Dollars (up to cents) to base units. */
export function usd(dollars: number): bigint {
  return BigInt(Math.round(dollars * 100)) * (BASE_UNITS_PER_USD / 100n);
}

/** Base units to dollars (display only). */
export function toUsd(amount: bigint | number): number {
  return Number(amount) / Number(BASE_UNITS_PER_USD);
}

export const MERCHANT_CATEGORY = {
  pharmacy: 0,
  grocery: 1,
  hardware: 2,
  general: 3,
} as const;
export type MerchantCategory = keyof typeof MERCHANT_CATEGORY;
