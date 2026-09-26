import {
  ChainTxError,
  createConnection,
  type DeclarationInput,
  type MerchantCategory,
  RescuClient,
  reliefAta,
  usd,
} from "@rescu/chain";
import idl from "@rescu/chain/idl";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";
import { expect } from "vitest";

export const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
export const connection = createConnection(RPC_URL, { maxSockets: 512 });

/** 2024-09-27 03:30:00 UTC, just after Helene's landfall (on the half hour, so small drift never crosses an hour). */
export const T0 = 1_727_407_800;
export const HOUR = 3_600;
export const DAY = 86_400;

export function errorCode(name: string): number {
  const e = idl.errors.find((x) => x.name === name);
  if (!e) throw new Error(`unknown error ${name}`);
  return e.code;
}

export async function airdrop(to: PublicKey, sol: number) {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

export async function funded(sol = 5): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey, sol);
  return kp;
}

let idCounter = 0;
/** Unique per process and per call so suites never collide on one validator. */
export function nextDeclarationId(): bigint {
  idCounter += 1;
  return BigInt(Date.now()) * 1_000n + BigInt(process.pid % 100) * 10n + BigInt(idCounter);
}

export interface World {
  client: RescuClient;
  relayer: Keypair;
  admin: Keypair;
  oracle: Keypair;
  mint: PublicKey;
  declaration: PublicKey;
  id: bigint;
}

export async function createWorld(overrides: Partial<DeclarationInput> = {}): Promise<World> {
  const relayer = await funded(1_000);
  const admin = await funded(5);
  const oracle = Keypair.generate();
  const client = new RescuClient(connection, relayer);
  const id = overrides.id ?? nextDeclarationId();
  const { mint, declaration } = await client.createDeclaration(admin, {
    id,
    name: "Helene 2024",
    oracle: oracle.publicKey,
    budget: usd(1_000_000),
    timeScale: 1,
    simStart: T0,
    ...overrides,
  });
  return { client, relayer, admin, oracle, mint, declaration, id };
}

/** Enrolls `n` fresh residents (0 SOL each) and disburses `grantUsd` to each. */
export async function addResidents(w: World, n: number, grantUsd = 1_000): Promise<Keypair[]> {
  const residents = Array.from({ length: n }, () => Keypair.generate());
  for (let i = 0; i < n; i += 4) {
    const batch = residents.slice(i, i + 4);
    await w.client.enrollResidents(
      w.admin,
      w.mint,
      batch.map((r, j) => ({ owner: r.publicKey, householdId: BigInt(i + j) })),
    );
  }
  if (grantUsd > 0) {
    await w.client.disburse(
      w.admin,
      w.mint,
      residents.map((r) => ({ owner: r.publicKey, amount: usd(grantUsd) })),
    );
  }
  return residents;
}

export async function addMerchant(
  w: World,
  opts: { category?: MerchantCategory; approved?: boolean } = {},
): Promise<Keypair> {
  const merchant = Keypair.generate();
  await w.client.registerMerchant(w.admin, w.mint, merchant.publicKey, opts);
  return merchant;
}

/** A relief-dollar account for someone who is neither a resident nor a merchant here. */
export async function createAta(w: World, owner: PublicKey) {
  await w.client.send([
    createAssociatedTokenAccountIdempotentInstruction(
      w.relayer.publicKey,
      reliefAta(owner, w.mint),
      owner,
      w.mint,
      TOKEN_2022_PROGRAM_ID,
    ),
  ]);
  return reliefAta(owner, w.mint);
}

/** Asserts the promise fails with the named on-chain rule and returns the error. */
export async function expectRejected(promise: Promise<unknown>, name: string): Promise<ChainTxError> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof ChainTxError)) throw err;
    expect(err.decoded?.name, err.logs.join("\n")).toBe(name);
    return err;
  }
  throw new Error(`expected rejection ${name}, but the transaction succeeded`);
}
