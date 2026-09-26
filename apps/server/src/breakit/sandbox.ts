import {
  BN,
  declarationPda,
  decodeLogs,
  extraAccountMetasPda,
  merchantPda,
  paymentInstruction,
  REJECTION_COPY,
  reliefAta,
  TxSender,
  usd,
  walletPda,
} from "@rescu/chain";
import { BREAK_CASES, type BreakCase, type BreakCaseId, type BreakitState, type BreakResult } from "@rescu/live";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { ChainRunner, SendResult } from "../chain.js";
import { config } from "../config.js";
import { deriveKeypair } from "../wallets.js";

const HOUR = 3_600;
const DAY = 86_400;
/** Helene's landfall: the sandbox's sim clock starts here (it only needs to be a plausible storm time). */
const T0 = 1_727_407_800;
const HEALTH_MS = 5_000;
/** Aid each sandbox resident starts with, cents. */
const GRANTS = { attacker: 500_000, control: 50_000, spree: 200_000, frozen: 10_000, agentHolder: 50_000, expired: 10_000 };
const TOP_UP = 200_000;
const AGENT_ALLOWANCE = 2_000;
/** The spree: two orders that fit under $300 together, then one that can't. */
const SPREE = [14_000, 13_900, 6_000] as const;
/** A case that hasn't come back by then is reported as not confirmed (the queue moves on). */
const CASE_TIMEOUT_MS = 30_000;

type Actor = "attacker" | "control" | "spree" | "frozen" | "agentHolder" | "resaleTarget" | "expired";
type Store = "approved" | "pending" | "suspended" | "unregistered" | "otherZone";

interface Staged {
  /** The sandbox declaration every case runs in. */
  mint: PublicKey;
  /** A second declaration: its store is the out-of-zone target, and its clock is past expiry. */
  expiredMint: PublicKey;
  residents: Record<Actor, Keypair>;
  stores: Record<Store, Keypair>;
}

/** One attack: the transaction(s) a case sends. The last one sent is the one the panel reports. */
type Attack = (s: Sandbox, st: Staged) => Promise<Attempt>;
interface Attempt {
  r: SendResult;
  /** Earlier transactions of the same attack (the spree's first two orders), all expected to land. */
  setupOk?: boolean;
}

const pay = (mint: PublicKey, from: Keypair | PublicKey, to: PublicKey, cents: number, authority?: PublicKey) => {
  const owner = "publicKey" in from ? from.publicKey : from;
  return paymentInstruction({ mint, source: reliefAta(owner, mint), destinationOwner: to, authority: authority ?? owner, amount: usd(cents / 100) });
};

/**
 * Every case in BREAK_CASES, wired to the attack it fires. The Record type makes a missing case
 * a compile error.
 */
export const ATTACKS: Record<BreakCaseId, Attack> = {
  control: async (s, st) => {
    await s.ready("control", 1_299);
    return { r: await s.send([pay(st.mint, st.residents.control, st.stores.approved.publicKey, 1_299)], [st.residents.control]), setupOk: true };
  },
  unregistered: async (s, st) => ({ r: await s.send([pay(st.mint, st.residents.attacker, st.stores.unregistered.publicKey, 2_500)], [st.residents.attacker]) }),
  out_of_zone: async (s, st) => ({ r: await s.send([pay(st.mint, st.residents.attacker, st.stores.otherZone.publicKey, 2_500)], [st.residents.attacker]) }),
  resale: async (s, st) => ({ r: await s.send([pay(st.mint, st.residents.attacker, st.residents.resaleTarget.publicKey, 5_000)], [st.residents.attacker]) }),
  over_order_cap: async (s, st) => ({ r: await s.send([pay(st.mint, st.residents.attacker, st.stores.approved.publicKey, 49_900)], [st.residents.attacker]) }),
  over_daily_cap: async (s, st) => {
    await s.ready("spree", SPREE[0] + SPREE[1] + SPREE[2], true);
    const who = st.residents.spree;
    const first = await Promise.all([SPREE[0], SPREE[1]].map((c) => s.send([pay(st.mint, who, st.stores.approved.publicKey, c)], [who])));
    const setupOk = first.every((r) => r.ok);
    s.spent("spree", (first[0]!.ok ? SPREE[0] : 0) + (first[1]!.ok ? SPREE[1] : 0));
    return { r: await s.send([pay(st.mint, who, st.stores.approved.publicKey, SPREE[2])], [who]), setupOk };
  },
  pending: async (s, st) => ({ r: await s.send([pay(st.mint, st.residents.attacker, st.stores.pending.publicKey, 1_299)], [st.residents.attacker]) }),
  suspended: async (s, st) => ({ r: await s.send([pay(st.mint, st.residents.attacker, st.stores.suspended.publicKey, 1_299)], [st.residents.attacker]) }),
  frozen: async (s, st) => ({ r: await s.send([pay(st.mint, st.residents.frozen, st.stores.approved.publicKey, 1_299)], [st.residents.frozen]) }),
  expired: async (s, st) => ({ r: await s.send([pay(st.expiredMint, st.residents.expired, st.stores.otherZone.publicKey, 1_299)], [st.residents.expired]) }),
  agent_over_allowance: async (s, st) => {
    const agent = s.chain.keys.agent;
    return { r: await s.send([pay(st.mint, st.residents.agentHolder.publicKey, st.stores.approved.publicKey, 5_000, agent.publicKey)], [agent]) };
  },
  hook_direct: async (s, st) => {
    const who = st.residents.attacker.publicKey;
    const source = reliefAta(who, st.mint);
    const destination = reliefAta(st.stores.approved.publicKey, st.mint);
    const ix = await s.chain.client.program.methods
      .transferHook(new BN(usd(100).toString()))
      .accountsStrict({
        source,
        mint: st.mint,
        destination,
        authority: who,
        extraAccountMetaList: extraAccountMetasPda(st.mint),
        declaration: declarationPda(st.mint),
        senderWallet: walletPda(source),
        merchant: merchantPda(st.stores.approved.publicKey),
        receiverWallet: walletPda(destination),
      })
      .instruction();
    return { r: await s.send([ix], []) };
  },
  not_oracle: async (s, st) => {
    const rival = Keypair.generate();
    const ix = await s.chain.client.setMerchantStatusInstruction(rival.publicKey, st.mint, st.stores.approved.publicKey, "suspended");
    return { r: await s.send([ix], [rival]) };
  },
};

/** A few log lines around the failure (or the hook's success), without compute-unit noise. */
export function excerpt(logs: string[], rule: string | null, max = 6): string[] {
  const lines: string[] = [];
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i]!;
    // Anchor's require_keys_eq prints "Left:" / "Right:" and a key after each: noise for the panel.
    if (/^Program log: (Left|Right):$/.test(l)) {
      i++;
      continue;
    }
    if (/ consumed \d+ of \d+ compute units$/.test(l) || l.startsWith("Program return:") || l.startsWith("Program ComputeBudget")) continue;
    lines.push(l);
  }
  const hit = lines.findIndex((l) => (rule && l.includes(rule)) || /Error Code:|failed:/.test(l));
  if (hit < 0) return lines.slice(0, max);
  const start = Math.max(0, Math.min(hit - (max - 2), lines.length - max));
  return lines.slice(start, start + max);
}

/** The panel's verdict for one attempt. */
export function judge(c: BreakCase, landed: boolean, rule: string | null): boolean {
  return c.expect === null ? landed : !landed && rule === c.expect;
}

/**
 * "Try to break it": a sandbox on our validator, apart from the live run (its own declaration,
 * mint, stores and residents), staged in the background once the validator answers and kept
 * across sim resets. Every attack goes out with preflight skipped, so the rejection lands
 * on-chain with the rule in its logs and a signature to link.
 */
export class Sandbox {
  status = "Waiting for the validator";
  private staged: Staged | null = null;
  private staging: Promise<void> | null = null;
  private readonly results = new Map<BreakCaseId, BreakResult>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private readonly payer: Keypair;
  private readonly sender: TxSender;
  /** Local books: what each resident can still spend and has spent since the clock last jumped a day. */
  private readonly balance = new Map<Actor, number>();
  private readonly window = new Map<Actor, number>();
  private simAnchor = { sim: T0, wall: Date.now() };
  private disbursedCents = 0;
  private seq = Math.floor(Math.random() * 100_000);
  private budgetCents = 0;

  constructor(readonly chain: ChainRunner) {
    this.payer = deriveKeypair(config.seed || "rescu-breakit", "breakit:fee-payer");
    this.sender = new TxSender(chain.connection, this.payer, { pollMs: 100 });
  }

  get isReady() {
    return this.staged !== null;
  }

  state(): BreakitState {
    return {
      ready: this.staged !== null,
      status: this.status,
      cases: BREAK_CASES,
      results: BREAK_CASES.flatMap((c) => this.results.get(c.id) ?? []),
      explorerCluster: this.chain.explorerCluster,
    };
  }

  /** Stages as soon as the validator answers; re-stages if the validator lost the sandbox (fresh ledger). */
  start() {
    const check = async () => {
      if (this.staging) return;
      if (!this.staged) {
        if (!(await this.chain.reachable())) {
          this.status = "Waiting for the validator";
          return;
        }
        this.staging = this.stage()
          .catch((err) => {
            this.status = `Setup failed, retrying: ${(err as Error).message}`;
            console.error("breakit staging:", (err as Error).message);
          })
          .finally(() => {
            this.staging = null;
          });
        return;
      }
      if (!(await this.alive())) {
        this.staged = null;
        this.status = "The validator was reset; setting the sandbox up again";
      }
    };
    void check();
    this.timer = setInterval(() => void check(), HEALTH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async alive(): Promise<boolean> {
    const st = this.staged;
    if (!st) return false;
    try {
      return (await this.chain.connection.getAccountInfo(declarationPda(st.mint), "confirmed")) !== null;
    } catch {
      return true; // Busy, not gone.
    }
  }

  /** Runs one case (cases run one at a time: they share the sandbox's clock and wallets). */
  run(id: BreakCaseId): Promise<BreakResult> {
    const next = this.queue.then(() => this.fire(id));
    this.queue = next.catch(() => {});
    return next;
  }

  private async fire(id: BreakCaseId): Promise<BreakResult> {
    const st = this.staged;
    const c = BREAK_CASES.find((x) => x.id === id)!;
    if (!st) throw new Error(this.status);
    const t0 = Date.now();
    const timeout = new Promise<Attempt>((resolve) =>
      setTimeout(() => resolve({ r: { ok: false, signature: null, decoded: { name: "SendFailed", message: "timed out" }, latencyMs: Date.now() - t0, slot: 0, err: null } }), CASE_TIMEOUT_MS),
    );
    const attempt = await Promise.race([ATTACKS[id](this, st), timeout]);
    const { r } = attempt;
    const logs = r.signature ? await this.logsOf(r.signature) : [];
    const decoded = r.ok ? null : (decodeLogs(logs) ?? r.decoded);
    const rule = r.ok ? null : (decoded?.name ?? "Unknown");
    const landed = r.ok;
    if (landed && id === "control") this.spent("control", 1_299);
    let asExpected = judge(c, landed, rule);
    if (attempt.setupOk === false) asExpected = false;
    const result: BreakResult = {
      id,
      landed,
      rule,
      message: landed
        ? "Landed: a normal purchase at an approved store goes through."
        : rule === "SendFailed"
          ? "The validator didn't confirm the attempt in time. Try again."
          : (REJECTION_COPY[rule!] ?? decoded?.message ?? "Blocked on-chain"),
      asExpected,
      signature: r.signature,
      latencyMs: r.latencyMs,
      logs: excerpt(logs, rule),
      at: Date.now(),
    };
    this.results.set(id, result);
    if (!asExpected) console.warn(`breakit ${id}: expected ${c.expect ?? "landed"}, got ${rule ?? "landed"} (${r.signature})`);
    return result;
  }

  /** Sends one attack transaction (fee paid by the sandbox's own payer, preflight skipped). */
  async send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<SendResult> {
    const t0 = Date.now();
    // A distinct compute limit makes every attempt a distinct transaction: the same attack twice
    // within one blockhash would otherwise be the same signature (deduplicated by the validator).
    const unique = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 + (this.seq++ % 100_000) });
    try {
      return await this.sender.submit([unique, ...ixs], signers);
    } catch (err) {
      return { ok: false, signature: null, decoded: { name: "SendFailed", message: (err as Error).message }, latencyMs: Date.now() - t0, slot: 0, err };
    }
  }

  private async logsOf(signature: string): Promise<string[]> {
    for (let i = 0; i < 20; i++) {
      try {
        const tx = await this.chain.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (tx?.meta?.logMessages) return tx.meta.logMessages;
      } catch {
        // Not indexed yet.
      }
      await sleep(150);
    }
    return [];
  }

  /**
   * Gets a resident ready to pay `cents`: tops up its aid when low, and jumps the sandbox's clock a
   * day ahead when its rolling 24 h window can't take the payment (or must start empty).
   */
  async ready(who: Actor, cents: number, freshWindow = false) {
    const st = this.staged!;
    if ((this.balance.get(who) ?? 0) < cents) await this.topUp(st, who);
    const used = this.window.get(who) ?? 0;
    if ((freshWindow && used > 0) || used + cents > 25_000) await this.nextDay(st);
  }

  spent(who: Actor, cents: number) {
    this.balance.set(who, (this.balance.get(who) ?? 0) - cents);
    this.window.set(who, (this.window.get(who) ?? 0) + cents);
  }

  private async nextDay(st: Staged) {
    const now = this.simAnchor.sim + (Date.now() - this.simAnchor.wall) / 1000;
    const next = Math.round(now + DAY + HOUR);
    const r = await this.send([await this.chain.client.setClockInstruction(this.chain.keys.admin.publicKey, st.mint, 1, next)], [this.chain.keys.admin]);
    if (!r.ok) throw new Error(`Couldn't move the sandbox clock: ${r.decoded?.message ?? "unknown"}`);
    this.simAnchor = { sim: next, wall: Date.now() };
    this.window.clear();
  }

  private async topUp(st: Staged, who: Actor) {
    const admin = this.chain.keys.admin;
    if (this.disbursedCents + TOP_UP > this.budgetCents) {
      const budget = this.budgetCents + 100_000_000;
      const r = await this.send([await this.chain.client.updateRulesInstruction(admin.publicKey, st.mint, { budget: usd(budget / 100) })], [admin]);
      if (!r.ok) throw new Error(`Couldn't raise the sandbox budget: ${r.decoded?.message ?? "unknown"}`);
      this.budgetCents = budget;
    }
    const ix = await this.chain.client.disburseInstruction(admin.publicKey, st.mint, [{ owner: st.residents[who].publicKey, amount: usd(TOP_UP / 100) }]);
    const r = await this.send([ix], [admin]);
    if (!r.ok) throw new Error(`Couldn't top up the sandbox wallet: ${r.decoded?.message ?? "unknown"}`);
    this.disbursedCents += TOP_UP;
    this.balance.set(who, (this.balance.get(who) ?? 0) + TOP_UP);
  }

  // ---------- staging ----------

  private async stage() {
    const t0 = Date.now();
    const { client, keys } = this.chain;
    const admin = keys.admin;
    this.status = "Topping up the validator";
    await this.chain.ensureFunds();
    if ((await this.chain.connection.getBalance(this.payer.publicKey, "confirmed")) < 2 * LAMPORTS_PER_SOL) {
      const sig = await this.chain.connection.requestAirdrop(this.payer.publicKey, 10 * LAMPORTS_PER_SOL);
      const latest = await this.chain.connection.getLatestBlockhash("confirmed");
      await this.chain.connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    }

    this.status = "Declaring the sandbox on-chain";
    // Far from the live runs' ids (Date.now()), so they never collide.
    const id = BigInt(Date.now()) * 1_000n + 7n;
    const budget = 100_000_000;
    const [a, b] = await Promise.all([
      client.createDeclaration(admin, { id, name: "Try to break it", oracle: keys.oracle.publicKey, budget: usd(budget / 100), timeScale: 1, simStart: T0, aidDurationSecs: 3_650 * DAY }),
      client.createDeclaration(admin, { id: id + 1n, name: "Try to break it: expired", oracle: keys.oracle.publicKey, budget: usd(1_000), timeScale: 1, simStart: T0, aidDurationSecs: 30 * DAY }),
    ]);
    const mint = a.mint;
    const expiredMint = b.mint;
    const kp = (label: string) => deriveKeypair(config.seed || "rescu-breakit", `breakit:${id}:${label}`);
    const residents: Record<Actor, Keypair> = {
      attacker: kp("attacker"),
      control: kp("control"),
      spree: kp("spree"),
      frozen: kp("frozen"),
      agentHolder: kp("agent-holder"),
      resaleTarget: kp("resale-target"),
      expired: kp("expired"),
    };
    const stores: Record<Store, Keypair> = { approved: kp("approved"), pending: kp("pending"), suspended: kp("suspended"), unregistered: kp("unregistered"), otherZone: kp("other-zone") };

    this.status = "Registering sandbox stores";
    await Promise.all([
      client.registerMerchant(admin, mint, stores.approved.publicKey, { category: "grocery", approved: true }),
      client.registerMerchant(admin, mint, stores.pending.publicKey, { category: "hardware", approved: false }),
      client.registerMerchant(admin, mint, stores.suspended.publicKey, { category: "general", approved: true }),
      client.registerMerchant(admin, expiredMint, stores.otherZone.publicKey, { category: "grocery", approved: true }),
      // Token accounts only: a shop that never enrolled, and the other zone's store in this mint.
      client.send([client.createAtaInstruction(stores.unregistered.publicKey, mint), client.createAtaInstruction(stores.otherZone.publicKey, mint)]),
    ]);

    this.status = "Enrolling sandbox residents";
    const inA: Actor[] = ["attacker", "control", "spree", "frozen", "agentHolder", "resaleTarget"];
    await Promise.all([
      client.enrollResidents(admin, mint, inA.slice(0, 3).map((k, i) => ({ owner: residents[k].publicKey, householdId: BigInt(i) }))),
      client.enrollResidents(admin, mint, inA.slice(3).map((k, i) => ({ owner: residents[k].publicKey, householdId: BigInt(3 + i) }))),
      client.enrollResidents(admin, expiredMint, [{ owner: residents.expired.publicKey, householdId: 0n }]),
    ]);

    this.status = "Sending the sandbox its aid";
    const grants = (["attacker", "control", "spree", "frozen", "agentHolder"] as const).map((k) => ({ owner: residents[k].publicKey, amount: usd(GRANTS[k] / 100) }));
    await Promise.all([
      client.disburse(admin, mint, grants),
      client.disburse(admin, expiredMint, [{ owner: residents.expired.publicKey, amount: usd(GRANTS.expired / 100) }]),
    ]);

    this.status = "The oracle suspends a store and freezes a wallet";
    await Promise.all([
      client.setMerchantStatus(keys.oracle, mint, stores.suspended.publicKey, "suspended"),
      client.setWalletFrozen(keys.oracle, mint, residents.frozen.publicKey, true),
      client.approveAgent(residents.agentHolder, mint, keys.agent.publicKey, usd(AGENT_ALLOWANCE / 100)),
      // The second declaration's aid ran out: its clock goes past Day 30.
      client.setClock(admin, expiredMint, 1, T0 + 31 * DAY),
    ]);

    this.balance.clear();
    this.window.clear();
    for (const k of ["attacker", "control", "spree", "frozen", "agentHolder", "expired"] as const) this.balance.set(k, GRANTS[k]);
    this.disbursedCents = GRANTS.attacker + GRANTS.control + GRANTS.spree + GRANTS.frozen + GRANTS.agentHolder;
    this.budgetCents = budget;
    this.simAnchor = { sim: T0, wall: Date.now() };
    this.results.clear();
    this.staged = { mint, expiredMint, residents, stores };
    this.status = "Ready";
    console.log(`breakit sandbox ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: declaration ${declarationPda(mint).toBase58()} (mint ${mint.toBase58()})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
