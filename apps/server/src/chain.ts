import {
  createConnection,
  decodeChainError,
  type MerchantCategory,
  paymentInstruction,
  RescuClient,
  reliefAta,
  type SubmitResult,
  TxSender,
} from "@rescu/chain";
import {
  type Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import { config, type Keys } from "./config.js";
import { feePayerKey } from "./wallets.js";

const TX_LIMIT = 1_232;
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";
/** Relief dollars have 6 decimals: one cent is 10,000 base units. */
export const centsToBase = (cents: number) => BigInt(cents) * 10_000n;

export type SendResult = SubmitResult | { ok: false; signature: null; decoded: { name: string; message: string } | null; latencyMs: number; slot: 0; err: unknown };
type Batched = (groups: number, result: SendResult, firstGroup: number) => void;

function txBytes(ixs: TransactionInstruction[], payer: PublicKey): number {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: DUMMY_BLOCKHASH, instructions: ixs }).compileToLegacyMessage();
  return msg.serialize().length + 1 + 64 * msg.header.numRequiredSignatures;
}

/** How many copies of a same-shaped instruction group fit in one legacy transaction. */
export function perTx(groups: TransactionInstruction[][], payer: PublicKey): number {
  let n = 1;
  while (n < groups.length && txBytes(groups.slice(0, n + 1).flat(), payer) <= TX_LIMIT) n++;
  return n;
}

/** Runs `fn` over items with at most `limit` in flight; stops starting new ones once `signal` aborts. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && !signal?.aborted) {
        const i = next++;
        await fn(items[i]!, i);
      }
    }),
  );
}

/**
 * Everything the sim does on-chain, through the batch senders: the relayer pays every fee and
 * all rent (residents and stores hold 0 SOL), and a pool of fee payers spreads payments so the
 * validator can run them in parallel (a fee payer is always write-locked).
 */
export class ChainRunner {
  readonly connection = createConnection(config.rpcUrl, { maxSockets: 512 });
  readonly client: RescuClient;
  readonly explorerCluster = `?cluster=custom&customUrl=${encodeURIComponent(config.explorerRpcUrl)}`;
  private readonly admin: Keypair;
  private readonly relayerSender: TxSender;
  private readonly feePayers: Keypair[];
  private readonly payers: TxSender[];
  private rr = 0;

  constructor(readonly keys: Keys) {
    this.admin = keys.admin;
    this.client = new RescuClient(this.connection, keys.relayer);
    this.relayerSender = new TxSender(this.connection, keys.relayer);
    this.feePayers = Array.from({ length: config.feePayers }, (_, i) => feePayerKey(config.seed, i));
    this.payers = this.feePayers.map((kp) => new TxSender(this.connection, kp));
  }

  get inFlight() {
    return this.payers.reduce((x, p) => x + p.inFlight, 0) + this.relayerSender.inFlight;
  }

  async reachable(): Promise<boolean> {
    try {
      await this.connection.getSlot("confirmed");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Our own validator: top up the relayer (store and rogue-store rent, disbursement fees), admin, and
   * the fee payers (household rent is ~0.005 SOL each, ~13 SOL per payer for a 20k run).
   */
  async ensureFunds() {
    const wants: [PublicKey, number, number][] = [
      [this.keys.relayer.publicKey, 50, 500],
      [this.admin.publicKey, 5, 50],
      ...this.feePayers.map((k) => [k.publicKey, 40, 200] as [PublicKey, number, number]),
    ];
    await Promise.all(
      wants.map(async ([key, min, topUp]) => {
        const lamports = await this.connection.getBalance(key, "confirmed");
        if (lamports >= min * LAMPORTS_PER_SOL) return;
        const signature = await this.connection.requestAirdrop(key, topUp * LAMPORTS_PER_SOL);
        const latest = await this.connection.getLatestBlockhash("confirmed");
        await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
      }),
    );
  }

  private async submit(sender: TxSender, ixs: TransactionInstruction[], signers: Keypair[]): Promise<SendResult> {
    const t0 = Date.now();
    try {
      return await sender.submit(ixs, signers);
    } catch (err) {
      return { ok: false, signature: null, decoded: decodeChainError(err) ?? { name: "SendFailed", message: String((err as Error).message ?? err) }, latencyMs: Date.now() - t0, slot: 0, err };
    }
  }

  /** Sends one relayer transaction, retrying once if it expired unconfirmed (validator overloaded). */
  private async relayed(ixs: TransactionInstruction[], signers: Keypair[] = [this.admin]): Promise<SendResult> {
    const r = await this.submit(this.relayerSender, ixs, signers);
    if (!r.ok && r.signature === null) return this.submit(this.relayerSender, ixs, signers);
    return r;
  }

  async createDeclaration(id: bigint, name: string, simStart: number, durationSecs: number) {
    return this.client.createDeclaration(
      this.admin,
      { id, name, oracle: this.keys.oracle.publicKey, budget: 0n, timeScale: 1, simStart, aidDurationSecs: durationSecs },
      { commitment: "confirmed" },
    );
  }

  /**
   * Packs same-shaped instruction groups into as few transactions as fit. `onDone` gets each
   * transaction's result with the range of groups it carried. Returns how many groups failed.
   */
  private async batches(groups: TransactionInstruction[][], limit: number, onDone: Batched, signers: Keypair[] = [this.admin], signal?: AbortSignal): Promise<number> {
    if (!groups.length) return 0;
    const n = perTx(groups, this.keys.relayer.publicKey);
    const chunks = Array.from({ length: Math.ceil(groups.length / n) }, (_, i) => groups.slice(i * n, (i + 1) * n));
    let failed = 0;
    await pool(
      chunks,
      limit,
      async (chunk, i) => {
        const r = await this.relayed(chunk.flat(), signers);
        if (!r.ok) failed += chunk.length;
        onDone(chunk.length, r, i * n);
      },
      signal,
    );
    return failed;
  }

  async registerMerchants(mint: PublicKey, merchants: { owner: PublicKey; category: MerchantCategory; h3: string }[], onDone: Batched, signal?: AbortSignal) {
    const groups = await Promise.all(
      merchants.map((m) => this.client.registerMerchantInstructions(this.admin.publicKey, mint, m.owner, { category: m.category, h3Cell: BigInt(`0x${m.h3}`), approved: true })),
    );
    return this.batches(groups, 64, onDone, [this.admin], signal);
  }

  async createAccounts(mint: PublicKey, owners: PublicKey[], onDone: Batched = () => {}) {
    return this.batches(owners.map((o) => [this.client.createAtaInstruction(o, mint)]), 8, onDone, []);
  }

  /**
   * Registers households. Enrollment only write-locks its payer, so rent and fees rotate through
   * the fee-payer pool and the validator runs the transactions in parallel (the relayer alone
   * would serialize all ~3,300 of them).
   */
  async enroll(mint: PublicKey, residents: { owner: PublicKey; householdId: number }[], onDone: Batched, signal?: AbortSignal) {
    if (!residents.length) return 0;
    const build = (r: { owner: PublicKey; householdId: number }, payer: number) =>
      this.client.enrollInstructions(this.admin.publicKey, mint, r.owner, BigInt(r.householdId), this.feePayers[payer]!.publicKey);
    const sample = await Promise.all(residents.slice(0, 16).map((r) => build(r, 0)));
    const n = perTx(sample, this.feePayers[0]!.publicKey);
    const chunks = Array.from({ length: Math.ceil(residents.length / n) }, (_, j) => j);
    let failed = 0;
    await pool(
      chunks,
      256,
      async (j) => {
        const payer = j % this.payers.length;
        const slice = residents.slice(j * n, (j + 1) * n);
        const ixs = (await Promise.all(slice.map((r) => build(r, payer)))).flat();
        let r = await this.submit(this.payers[payer]!, ixs, [this.admin]);
        if (!r.ok && r.signature === null) r = await this.submit(this.payers[payer]!, ixs, [this.admin]);
        if (!r.ok) failed += slice.length;
        onDone(slice.length, r, j * n);
      },
      signal,
    );
    return failed;
  }

  async fund(mint: PublicKey, budgetCents: number) {
    return this.relayed([await this.client.updateRulesInstruction(this.admin.publicKey, mint, { budget: centsToBase(budgetCents) })]);
  }

  async disburse(mint: PublicKey, grants: { owner: PublicKey; cents: number }[]) {
    const ix = await this.client.disburseInstruction(this.admin.publicKey, mint, grants.map((g) => ({ owner: g.owner, amount: centsToBase(g.cents) })));
    return this.submit(this.relayerSender, [ix], [this.admin]);
  }

  async setClock(mint: PublicKey, timeScale: number, simNow: number) {
    return this.relayed([await this.client.setClockInstruction(this.admin.publicKey, mint, Math.max(1, Math.round(timeScale)), Math.round(simNow))]);
  }

  /** A payment signed by the resident; the fee payer rotates through the pool. */
  pay(p: { mint: PublicKey; resident: Keypair; merchant: PublicKey; cents: number; destination?: PublicKey }) {
    const ix = paymentInstruction({
      mint: p.mint,
      source: reliefAta(p.resident.publicKey, p.mint),
      destinationOwner: p.merchant,
      destination: p.destination,
      authority: p.resident.publicKey,
      amount: centsToBase(p.cents),
    });
    const sender = this.payers[this.rr++ % this.payers.length]!;
    return this.submit(sender, [ix], [p.resident]);
  }

  async clawback(mint: PublicKey, owners: PublicKey[], onDone: Batched, signal?: AbortSignal) {
    const groups = await Promise.all(owners.map(async (o) => [await this.client.clawbackInstruction(mint, o)]));
    return this.batches(groups, 256, onDone, [], signal);
  }

  fetchDeclaration(mint: PublicKey) {
    return this.client.fetchDeclaration(mint);
  }

  /** The declaration's sim time as the program computes it right now (validator clock x time scale since the last anchor). */
  async chainSimNow(mint: PublicKey): Promise<number> {
    const [decl, clock] = await Promise.all([this.client.fetchDeclaration(mint), this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "processed")]);
    if (!clock) throw new Error("clock sysvar missing");
    // Clock sysvar: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp (i64 at byte 32).
    const unix = Number(clock.data.readBigInt64LE(32));
    return Number(decl.anchorSim.toString()) + (unix - Number(decl.anchorReal.toString())) * decl.timeScale;
  }
}
