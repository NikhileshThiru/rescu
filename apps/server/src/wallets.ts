import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { Keypair } from "@solana/web3.js";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/**
 * Deterministic sim wallets: sha256(seed : label) is the ed25519 seed. Node's native crypto
 * derives the public key (~50x faster than web3.js), so 20,000 residents take well under a second.
 */
export function deriveKeypair(seed: string, label: string): Keypair {
  const secret = createHash("sha256").update(`${seed}:${label}`).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, secret]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  const pub = spki.subarray(spki.length - 32);
  return Keypair.fromSecretKey(Buffer.concat([secret, pub]), { skipValidation: true });
}

/** Residents keep their wallet across runs of the same storm (the resident app can pick one). */
export const residentKey = (seed: string, slug: string, i: number) => deriveKeypair(seed, `resident:${slug}:${i}`);
/** Merchant accounts are one per owner on-chain, so every run registers fresh merchant keys. */
export const merchantKey = (seed: string, runId: bigint, i: number) => deriveKeypair(seed, `merchant:${runId}:${i}`);
/** Stores that never registered: rule-breaking residents try to pay them. */
export const rogueStoreKey = (seed: string, runId: bigint, i: number) => deriveKeypair(seed, `rogue-store:${runId}:${i}`);
export const feePayerKey = (seed: string, i: number) => deriveKeypair(seed, `fee-payer:${i}`);
