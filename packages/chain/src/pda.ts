import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, SEEDS } from "./constants.js";

const find = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

/**
 * PDA derivation is pure-JS curve math (~0.2 ms each, several per payment), so the sim would be
 * CPU-bound on it. Addresses never change, so cache them.
 */
const cache = new Map<string, PublicKey>();
function memo(kind: string, key: PublicKey, derive: () => PublicKey): PublicKey {
  const k = `${kind}:${key.toBase58()}`;
  let hit = cache.get(k);
  if (!hit) {
    hit = derive();
    cache.set(k, hit);
  }
  return hit;
}
export const clearPdaCache = () => cache.clear();

function u64le(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

/** Mint, freeze and permanent-delegate authority for every relief mint. */
export const authorityPda = () => find([SEEDS.authority]);
export const mintPda = (declarationId: bigint) => find([SEEDS.mint, u64le(declarationId)]);
export const declarationPda = (mint: PublicKey) =>
  memo("decl", mint, () => find([SEEDS.declaration, mint.toBuffer()]));
export const extraAccountMetasPda = (mint: PublicKey) =>
  memo("metas", mint, () => find([SEEDS.extraAccountMetas, mint.toBuffer()]));
/** Keyed by the resident's token account, so owner- and delegate-signed payments hit the same state. */
export const walletPda = (tokenAccount: PublicKey) =>
  memo("wallet", tokenAccount, () => find([SEEDS.wallet, tokenAccount.toBuffer()]));
export const merchantPda = (owner: PublicKey) =>
  memo("merchant", owner, () => find([SEEDS.merchant, owner.toBuffer()]));

/** Relief-dollar associated token account (Token-2022, ImmutableOwner). */
export const reliefAta = (owner: PublicKey, mint: PublicKey) =>
  memo(`ata:${mint.toBase58()}`, owner, () => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID));

/** Every address a declaration needs, derived from its id. */
export function declarationAddresses(declarationId: bigint) {
  const mint = mintPda(declarationId);
  return {
    mint,
    declaration: declarationPda(mint),
    extraAccountMetas: extraAccountMetasPda(mint),
    authority: authorityPda(),
  };
}
