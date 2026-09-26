/**
 * Devnet proof: one small relief declaration on the real devnet program, one good payment and
 * four payments the transfer hook refuses, each landing on-chain (skipPreflight) with its rule.
 *
 *   pnpm --filter @rescu/chain-tests devnet-proof [--out proof.json]
 *
 * Funding is one transfer from the CLI wallet (SOLANA_KEYPAIR, default ~/.config/solana/id.json),
 * never airdrops. Transactions go out one at a time with a pause, so public RPC isn't hammered.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  ChainTxError,
  decodeLogs,
  PROGRAM_ID,
  RescuClient,
  reliefAta,
  usd,
} from "@rescu/chain";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

const RPC_URL = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR = process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/solana/id.json`;
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
const PAUSE_MS = 1_500;
/** 2024-09-27 03:30:00 UTC, just after Helene's landfall. */
const T0 = 1_727_407_800;

// Plain Connection so web3.js backs off on 429s; confirmations poll over HTTP because public
// devnet rate-limits new WebSocket connections.
const connection = new Connection(RPC_URL, { commitment: "confirmed" });
connection.confirmTransaction = (async (strategy: { signature: string; lastValidBlockHeight: number }) => {
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    const { value } = await connection.getSignatureStatuses([strategy.signature]);
    const status = value[0];
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return { context: { slot: status.slot }, value: { err: status.err } };
    }
    if ((await connection.getBlockHeight("confirmed")) > strategy.lastValidBlockHeight) {
      throw new Error(`transaction ${strategy.signature} expired before confirming`);
    }
  }
}) as unknown as Connection["confirmTransaction"];
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
const relayer = Keypair.generate();
const admin = Keypair.generate();
const oracle = Keypair.generate();
const client = new RescuClient(connection, relayer);

const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const addr = (a: { toBase58(): string }) => `https://explorer.solana.com/address/${a.toBase58()}?cluster=devnet`;
const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));

interface Step { step: string; ok: boolean; rule?: string; signature: string; url: string }
const steps: Step[] = [];

async function ok(step: string, run: () => Promise<string>) {
  const signature = await run();
  steps.push({ step, ok: true, signature, url: tx(signature) });
  console.log(`  ok        ${step}\n            ${tx(signature)}`);
  await pause();
  return signature;
}

async function refused(step: string, rule: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof ChainTxError) || !err.signature) throw err;
    let name = err.decoded?.name;
    for (let i = 0; !name && i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1_500));
      const info = await connection.getTransaction(err.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      name = decodeLogs(info?.meta?.logMessages ?? [])?.name;
    }
    if (name !== rule) throw new Error(`${step}: expected ${rule}, chain said ${name ?? "unknown"} (${tx(err.signature)})`);
    steps.push({ step, ok: false, rule, signature: err.signature, url: tx(err.signature) });
    console.log(`  REFUSED   ${step}: ${rule}\n            ${tx(err.signature)}`);
    await pause();
    return;
  }
  throw new Error(`${step}: expected ${rule}, but the payment went through`);
}

async function main() {
  const program = await connection.getAccountInfo(PROGRAM_ID);
  if (!program?.executable) throw new Error(`program ${PROGRAM_ID.toBase58()} is not deployed on ${RPC_URL}`);
  const before = await connection.getBalance(payer.publicKey);
  console.log(`devnet proof: program ${PROGRAM_ID.toBase58()}, funder ${payer.publicKey.toBase58()} (${before / LAMPORTS_PER_SOL} SOL)`);

  const fund = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: relayer.publicKey, lamports: 0.4 * LAMPORTS_PER_SOL }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: admin.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    ),
    [payer],
    { commitment: "confirmed" },
  );
  steps.push({ step: "Fund relayer + admin from the CLI wallet (transfer, no airdrop)", ok: true, signature: fund, url: tx(fund) });
  console.log(`  ok        fund relayer + admin\n            ${tx(fund)}`);
  await pause();

  const id = BigInt(Date.now()) * 1_000n;
  let mint!: Keypair["publicKey"];
  let declaration!: Keypair["publicKey"];
  await ok("Declare Helene 2024 (Token-2022 mint with transfer hook, $200/order, $300/24 h)", async () => {
    const d = await client.createDeclaration(admin, {
      id,
      name: "Helene 2024",
      oracle: oracle.publicKey,
      budget: usd(2_000),
      timeScale: 1,
      simStart: T0,
    });
    mint = d.mint;
    declaration = d.declaration;
    return d.signature;
  });

  const grocer = Keypair.generate();
  const pharmacy = Keypair.generate();
  const stranger = Keypair.generate();
  await ok("Register + approve a grocery store", () => client.registerMerchant(admin, mint, grocer.publicKey, { category: "grocery" }));
  await ok("Register + approve a pharmacy", () => client.registerMerchant(admin, mint, pharmacy.publicKey, { category: "pharmacy" }));
  await ok("Unregistered shop opens a relief-dollar account", () =>
    client.send([
      createAssociatedTokenAccountIdempotentInstruction(relayer.publicKey, reliefAta(stranger.publicKey, mint), stranger.publicKey, mint, TOKEN_2022_PROGRAM_ID),
    ]),
  );

  const alice = Keypair.generate();
  const bob = Keypair.generate();
  await ok("Enroll 2 households (0 SOL each)", () =>
    client.enrollResidents(admin, mint, [
      { owner: alice.publicKey, householdId: 1n },
      { owner: bob.publicKey, householdId: 2n },
    ]),
  );
  await ok("Disburse $1,000 to each household", () =>
    client.disburse(admin, mint, [
      { owner: alice.publicKey, amount: usd(1_000) },
      { owner: bob.publicKey, amount: usd(1_000) },
    ]),
  );

  const pay = (merchant: Keypair, dollars: number, destination?: Keypair["publicKey"]) =>
    client.pay({ mint, resident: alice.publicKey, signer: alice, merchant: merchant.publicKey, amount: usd(dollars), destination, skipPreflight: true });

  await ok("Good payment: $42.50 at the grocery store (resident has 0 SOL, relayer pays the fee)", () => pay(grocer, 42.5));
  await refused("Pay a shop that isn't a registered relief merchant", "NotRegisteredMerchant", () => pay(stranger, 20));
  await refused("A $250 order (over the $200 per-order cap)", "OverOrderCap", () => pay(grocer, 250));
  await refused("Send aid to another resident (resale)", "ResaleBlocked", () => pay(bob, 50, reliefAta(bob.publicKey, mint)));
  await ok("Oracle suspends the pharmacy on-chain", () => client.setMerchantStatus(oracle, mint, pharmacy.publicKey, "suspended"));
  await refused("Pay the suspended pharmacy", "MerchantSuspended", () => pay(pharmacy, 30));

  const after = await connection.getBalance(payer.publicKey);
  const result = {
    cluster: "devnet",
    program: PROGRAM_ID.toBase58(),
    programUrl: addr(PROGRAM_ID),
    mint: mint.toBase58(),
    mintUrl: addr(mint),
    declaration: declaration.toBase58(),
    costSol: (before - after) / LAMPORTS_PER_SOL,
    at: new Date().toISOString(),
    steps,
  };
  console.log(`\nprogram ${result.programUrl}\nmint    ${result.mintUrl}\ncost    ${result.costSol} SOL`);
  if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err instanceof ChainTxError ? `${err.message}\n${err.logs.join("\n")}` : err);
  process.exit(1);
});
