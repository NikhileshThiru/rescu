/**
 * Chain benchmark against a running validator (pnpm chain:validator, then pnpm chain:bench).
 * Measures what the sim and the pitch need: CU per hooked payment, recipients per disburse
 * transaction, time-to-aid for one household, and sustained payment throughput.
 *   RESIDENTS=400 MERCHANTS=20 PAYMENTS=2000 CONCURRENCY=128 pnpm chain:bench
 */
import { paymentInstruction, reliefAta, TxSender, usd } from "@rescu/chain";
import { Keypair, type PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { connection, createWorld, funded } from "./fixtures.js";

const RESIDENTS = Number(process.env.RESIDENTS ?? 400);
const MERCHANTS = Number(process.env.MERCHANTS ?? 20);
const PAYMENTS = Number(process.env.PAYMENTS ?? 2_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 128);
/** Fee payers are always write-locked; a pool lets the validator run payments in parallel. */
const FEE_PAYERS = Number(process.env.FEE_PAYERS ?? 8);
const TX_LIMIT = 1_232;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

function txSize(ixs: TransactionInstruction[], feePayer: PublicKey, signers: number) {
  const tx = new Transaction({ feePayer, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0 }).add(...ixs);
  return tx.serializeMessage().length + 1 + 64 * signers;
}

async function maxPerTx(build: (n: number) => Promise<TransactionInstruction[]>, feePayer: PublicKey, signers: number) {
  let n = 1;
  while (txSize(await build(n + 1), feePayer, signers) <= TX_LIMIT) n++;
  return n;
}

async function cuOf(signature: string) {
  const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return tx?.meta?.computeUnitsConsumed ?? 0;
}

async function main() {
  const t0 = performance.now();
  const w = await createWorld({ name: "Bench", budget: usd(100_000_000) });
  const { client, admin, mint } = w;

  const residents = Array.from({ length: RESIDENTS }, () => Keypair.generate());
  const merchants = Array.from({ length: MERCHANTS }, () => Keypair.generate());

  await pool(merchants, 16, (m) => client.registerMerchant(admin, mint, m.publicKey).then(() => {}));

  // Enrollment (pre-storm registration): create-ATA + enroll pairs per transaction.
  const enrollPerTx = await maxPerTx(
    async (n) => (await Promise.all(residents.slice(0, n).map((r, i) => client.enrollInstructions(admin.publicKey, mint, r.publicKey, BigInt(i))))).flat(),
    w.relayer.publicKey,
    2,
  );
  const enrollBatches = Array.from({ length: Math.ceil(RESIDENTS / enrollPerTx) }, (_, b) => residents.slice(b * enrollPerTx, (b + 1) * enrollPerTx));
  const tEnroll = performance.now();
  await pool(enrollBatches, 32, (batch, b) =>
    client.enrollResidents(admin, mint, batch.map((r, i) => ({ owner: r.publicKey, householdId: BigInt(b * enrollPerTx + i) }))).then(() => {}),
  );
  const enrollSecs = (performance.now() - tEnroll) / 1_000;

  // Disbursement: batched mint_to.
  const disbursePerTx = await maxPerTx(
    async (n) => [await client.disburseInstruction(admin.publicKey, mint, residents.slice(0, n).map((r) => ({ owner: r.publicKey, amount: usd(1_000) })))],
    w.relayer.publicKey,
    2,
  );
  const grantBatches = Array.from({ length: Math.ceil(RESIDENTS / disbursePerTx) }, (_, b) => residents.slice(b * disbursePerTx, (b + 1) * disbursePerTx));
  const disburseSigs: string[] = [];
  const tDisburse = performance.now();
  await pool(grantBatches, 32, async (batch) => {
    disburseSigs.push(await client.disburse(admin, mint, batch.map((r) => ({ owner: r.publicKey, amount: usd(1_000) }))));
  });
  const disburseSecs = (performance.now() - tDisburse) / 1_000;

  // Time-to-aid for a single household that is already registered.
  const solo = Array.from({ length: 10 }, () => Keypair.generate());
  await client.enrollResidents(admin, mint, solo.slice(0, 4).map((r, i) => ({ owner: r.publicKey, householdId: BigInt(1e6 + i) })));
  await client.enrollResidents(admin, mint, solo.slice(4, 8).map((r, i) => ({ owner: r.publicKey, householdId: BigInt(2e6 + i) })));
  await client.enrollResidents(admin, mint, solo.slice(8).map((r, i) => ({ owner: r.publicKey, householdId: BigInt(3e6 + i) })));
  const timeToAid: number[] = [];
  for (const r of solo) {
    const t = performance.now();
    await client.disburse(admin, mint, [{ owner: r.publicKey, amount: usd(1_000) }]);
    timeToAid.push((performance.now() - t) / 1_000);
  }

  // Sustained payments through the batch sender: random resident -> random merchant, $5-$20.
  const feePayers = await Promise.all(Array.from({ length: FEE_PAYERS }, () => funded(100)));
  const senders = feePayers.map((kp) => new TxSender(connection, kp));
  const latencies: number[] = [];
  const paySigs: string[] = [];
  let failed = 0;
  const failures = new Map<string, number>();
  const jobs = Array.from({ length: PAYMENTS }, (_, i) => ({
    resident: residents[i % RESIDENTS]!,
    merchant: merchants[Math.floor(Math.random() * MERCHANTS)]!,
    amount: usd(5 + Math.floor(Math.random() * 1_500) / 100),
  }));
  const tPay = performance.now();
  await pool(jobs, CONCURRENCY, async (j, i) => {
    const ix = paymentInstruction({
      mint,
      source: reliefAta(j.resident.publicKey, mint),
      destinationOwner: j.merchant.publicKey,
      authority: j.resident.publicKey,
      amount: j.amount,
    });
    try {
      const r = await senders[i % senders.length]!.submit([ix], [j.resident]);
      if (r.ok) {
        paySigs.push(r.signature);
        latencies.push(r.latencyMs / 1_000);
      } else {
        failed++;
        const name = r.decoded?.name ?? "unknown";
        failures.set(name, (failures.get(name) ?? 0) + 1);
      }
    } catch (err) {
      failed++;
      const name = String((err as Error).message ?? err).slice(0, 60);
      failures.set(name, (failures.get(name) ?? 0) + 1);
    }
  });
  const paySecs = (performance.now() - tPay) / 1_000;

  const payCu = await Promise.all(paySigs.slice(0, 20).map(cuOf));
  const disburseCu = await Promise.all(disburseSigs.slice(0, 5).map(cuOf));

  const summary = {
    rpc: connection.rpcEndpoint,
    residents: RESIDENTS,
    merchants: MERCHANTS,
    enroll: { perTx: enrollPerTx, txs: enrollBatches.length, secs: round(enrollSecs), householdsPerSec: round(RESIDENTS / enrollSecs, 0) },
    disburse: {
      perTx: disbursePerTx,
      txs: grantBatches.length,
      secs: round(disburseSecs),
      householdsPerSec: round(RESIDENTS / disburseSecs, 0),
      cuPerTx: round(disburseCu.reduce((a, b) => a + b, 0) / Math.max(1, disburseCu.length), 0),
    },
    timeToAidSecs: { p50: round(pct(timeToAid, 50)), max: round(Math.max(...timeToAid)) },
    payments: {
      sent: PAYMENTS,
      confirmed: paySigs.length,
      failed,
      failures: Object.fromEntries(failures),
      secs: round(paySecs),
      tps: round(paySigs.length / paySecs, 0),
      latencySecs: { p50: round(pct(latencies, 50)), p95: round(pct(latencies, 95)) },
      cuPerPayment: { min: Math.min(...payCu), max: Math.max(...payCu) },
      concurrency: CONCURRENCY,
      feePayers: FEE_PAYERS,
    },
    totalSecs: round((performance.now() - t0) / 1_000),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
