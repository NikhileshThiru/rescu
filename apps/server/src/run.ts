import { EventEmitter } from "node:events";
import { DEFAULT_RULES, declarationPda, mintPda, REJECTION_COPY } from "@rescu/chain";
import type { FeedItem, LiveBatch, MerchantDot, RunInfo, RunPhase } from "@rescu/live";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { ALL_ITEMS } from "./catalog.js";
import type { ChainRunner, SendResult } from "./chain.js";
import { ServerClock } from "./clock.js";
import { config } from "./config.js";
import { TimeHeap } from "./heap.js";
import { Rng } from "./rng.js";
import { Households, type Order, ROGUE_STORES, Shopper } from "./shopper.js";
import type { ChainTxRow, Tiger } from "./tiger.js";
import { merchantKey, residentKey, rogueStoreKey } from "./wallets.js";
import { countyLabel, type World } from "./world.js";

const HOUR = 3600;
/** Households per disburse transaction (measured: 11 fit in 1,232 bytes, ~55k CU). */
const DISBURSE_PER_TX = 11;
const AID_IN_FLIGHT = 384;
const PAY_IN_FLIGHT = 2_048;
const TICK_MS = 25;
/** Payments queued beyond this many seconds of send capacity wait in the trip heap instead. */
const BACKLOG_SECS = 2;
/**
 * No new shopping trips this many wall seconds before aid expires: the chain's clock runs at sim
 * speed, so a payment still queued or confirming at expiry would bounce as AidExpired.
 */
const LAST_CALL_SECS = BACKLOG_SECS + 2;
/**
 * The program's clock is the validator's (whole seconds, and it falls behind then catches up
 * under load) times the sim speed, so it drifts from ours: a 13 s swing at 4x put it 20 sim hours
 * ahead and bounced every payment as AidExpired. While playing, compare every CLOCK_CHECK_MS and
 * re-anchor when it's more than CLOCK_AHEAD_SECS wall seconds ahead, or 4x that behind.
 */
const CLOCK_CHECK_MS = 1_000;
const CLOCK_AHEAD_SECS = 1.5;
/** Per 250 ms WebSocket batch: arcs sampled, feed rows by kind. */
const CAPS = { arcs: 24, aid: 1, payment: 2, blocked: 3 };
export const DEFAULT_SPEED = 5_760;

export interface RunStats {
  aidHouseholds: number;
  aidCents: number;
  aidFailed: number;
  payments: number;
  spentCents: number;
  blocked: number;
  blockedBy: Record<string, number>;
  dropped: number;
  returnedCents: number;
}

type Destination = { owner: PublicKey; name: string; category: string; h3: string; lonLat: [number, number] };

interface Batch {
  aid: Map<string, { usd: number; households: number }>;
  pays: LiveBatch["pays"];
  paysSeen: number;
  feed: FeedItem[];
  counts: { aid: number; payment: number; blocked: number };
}

const emptyBatch = (): Batch => ({ aid: new Map(), pays: [], paysSeen: 0, feed: [], counts: { aid: 0, payment: 0, blocked: 0 } });
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * One live relief network: a fresh declaration on-chain for one storm. Staged in the background
 * (declaration, stores, household registrations), then declared and funded by the presenter.
 * From then on the server's clock drives it: aid lands as the storm reaches each hex, households
 * shop, and every transaction is recorded in Tiger as it confirms.
 */
export class Run extends EventEmitter<{ info: []; clock: [] }> {
  readonly id: bigint;
  readonly key: string;
  readonly mint: PublicKey;
  readonly declaration: PublicKey;
  readonly clock: ServerClock;
  phase: RunPhase = "staging";
  progress: RunInfo["progress"] = null;
  error: string | null = null;
  funded = false;
  fundSignature: string | null = null;
  readonly stats: RunStats = { aidHouseholds: 0, aidCents: 0, aidFailed: 0, payments: 0, spentCents: 0, blocked: 0, blockedBy: {}, dropped: 0, returnedCents: 0 };

  private residents: Keypair[] = [];
  private merchantKeys: Keypair[] = [];
  private rogueStores: Keypair[] = [];
  private readonly enrolled: Uint8Array;
  private readonly hh: Households;
  private readonly shopper: Shopper;
  private readonly rng: Rng;
  private readonly heap: TimeHeap;
  /** Households in the order the storm reaches them. */
  private readonly dueOrder: Int32Array;
  private duePtr = 0;
  private aidQ: number[] = [];
  private aidDueMs: number[] = [];
  private aidHead = 0;
  private readonly aidTries: Uint8Array;
  private aidInFlight = 0;
  private payQ: { orders: Order[]; t: number }[] = [];
  private payHead = 0;
  private payInFlight = 0;
  private tokens = 0;
  private lastTick = 0;
  private timer?: ReturnType<typeof setInterval>;
  private declaredMs = 0;
  private closing = false;
  private disposed = false;
  private clockBusy = false;
  private clockAgain = false;
  private lastClockSent = "";
  private clockSentAt = 0;
  private clockTimer?: ReturnType<typeof setInterval>;
  private clockChecking = false;
  private clockDrift = { resyncs: 0, maxSecs: 0 };
  private lastInfoAt = 0;
  private batch = emptyBatch();
  private readonly abort = new AbortController();

  constructor(
    readonly world: World,
    private readonly chain: ChainRunner,
    private readonly tiger: Tiger,
  ) {
    super();
    this.id = BigInt(Date.now());
    this.key = this.id.toString();
    this.mint = mintPda(this.id);
    this.declaration = declarationPda(this.mint);
    const n = world.households.n;
    this.clock = new ServerClock(world.domain.start, world.domain.end, DEFAULT_SPEED);
    this.rng = new Rng(`run:${this.key}`);
    this.hh = new Households(n);
    this.shopper = new Shopper(world, this.rng);
    this.heap = new TimeHeap(n * 2);
    this.enrolled = new Uint8Array(n).fill(1);
    this.aidTries = new Uint8Array(n);
    const due = world.households.aidDue;
    this.dueOrder = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => due[a]! - due[b]!);
  }

  get slug() {
    return this.world.slug;
  }

  info(): RunInfo {
    const W = this.world;
    return {
      id: this.key,
      slug: W.slug,
      stormName: W.stormName,
      phase: this.phase,
      progress: this.progress,
      error: this.error,
      households: W.households.n,
      fullScaleHouseholds: W.fullScale.eligibleHouseholds,
      merchants: W.merchants.n,
      budgetUsd: W.budgetCents / 100,
      funded: this.funded,
      fundSignature: this.fundSignature,
      mint: this.mint.toBase58(),
      declaration: this.declaration.toBase58(),
      rules: { perOrderCapUsd: DEFAULT_RULES.perOrderCapUsd, dailyCapUsd: DEFAULT_RULES.dailyCapUsd, expiresAt: W.domain.end },
      explorerCluster: this.chain.explorerCluster,
    };
  }

  merchantDots(): MerchantDot[] {
    const M = this.world.merchants;
    const ts = (v: number) => (Number.isNaN(v) ? null : v);
    return M.name.map((name, idx) => ({
      idx,
      name,
      category: M.category[idx]!,
      lon: round6(M.lon[idx]!),
      lat: round6(M.lat[idx]!),
      closedFrom: ts(M.closedFrom[idx]!),
      reopensAt: ts(M.reopensAt[idx]!),
    }));
  }

  /** Everything that happened since the last call (aid per hex, sampled payments, feed rows). */
  drainBatch(): LiveBatch | null {
    const b = this.batch;
    if (!b.aid.size && !b.pays.length && !b.feed.length) return null;
    this.batch = emptyBatch();
    return {
      aid: [...b.aid].map(([h3, v]) => ({ h3, usd: round2(v.usd), households: v.households })),
      pays: b.pays,
      feed: b.feed,
    };
  }

  dispose() {
    this.disposed = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.removeAllListeners();
  }

  // ---------- staging ----------

  async stage() {
    const W = this.world;
    const H = W.households;
    const M = W.merchants;
    try {
      this.setProgress("Topping up the validator", 0, 1, true);
      await this.chain.ensureFunds();

      this.setProgress("Creating wallets", 0, H.n, true);
      for (let i = 0; i < H.n; i++) this.residents.push(residentKey(config.seed, W.slug, i));
      for (let i = 0; i < M.n; i++) this.merchantKeys.push(merchantKey(config.seed, this.id, i));
      for (let i = 0; i < ROGUE_STORES; i++) this.rogueStores.push(rogueStoreKey(config.seed, this.id, i));
      if (this.disposed) return;

      this.setProgress("Declaring on-chain", 0, 1, true);
      await this.chain.createDeclaration(this.id, W.stormName.slice(0, 32), W.domain.start, W.domain.end - W.domain.start);
      await this.tiger.insertRun({
        id: this.key,
        stormId: W.storm.id,
        mint: this.mint.toBase58(),
        declaration: this.declaration.toBase58(),
        households: H.n,
        merchants: M.n,
        budgetCents: W.budgetCents,
        fullScaleHouseholds: W.fullScale.eligibleHouseholds,
        simStart: W.domain.start,
        simEnd: W.domain.end,
        config: { maxTps: config.maxTps, feePayers: config.feePayers, fullScale: W.fullScale },
      });
      // The run's households and stores go to Tiger while the chain registers them.
      const saving = Promise.all([
        this.tiger.insertMerchants(this.key, { ...M, owner: this.merchantKeys.map((k) => k.publicKey.toBase58()) }),
        this.tiger.insertHouseholds(this.key, { ...H, owner: this.residents.map((k) => k.publicKey.toBase58()) }),
      ]);
      saving.catch(() => {});

      let done = 0;
      this.setProgress("Registering stores", 0, M.n, true);
      const storesFailed = await this.chain.registerMerchants(
        this.mint,
        this.merchantKeys.map((kp, i) => ({ owner: kp.publicKey, category: M.category[i]!, h3: M.h3[i]! })),
        (k, r) => {
          this.staged("register", r, k);
          this.setProgress("Registering stores", (done += k), M.n);
        },
        this.abort.signal,
      );
      if (this.disposed) return;
      if (storesFailed) throw new Error(`${storesFailed} stores failed to register`);
      await this.chain.createAccounts(
        this.mint,
        this.rogueStores.map((k) => k.publicKey),
        (k, r) => this.staged("register", r, k),
      );
      if (this.disposed) return;

      done = 0;
      this.setProgress("Registering households", 0, H.n, true);
      const householdsFailed = await this.chain.enroll(
        this.mint,
        this.residents.map((kp, i) => ({ owner: kp.publicKey, householdId: i })),
        (k, r, first) => {
          this.staged("enroll", r, k);
          if (!r.ok) this.enrolled.fill(0, first, first + k);
          this.setProgress("Registering households", (done += k), H.n);
        },
        this.abort.signal,
      );
      if (householdsFailed > H.n * 0.01) throw new Error(`${householdsFailed} household registrations failed`);
      if (this.disposed) return;

      this.setProgress("Saving the network to Tiger", 0, 1, true);
      await saving;

      this.progress = null;
      this.phase = "ready";
      this.emit("info");
    } catch (err) {
      if (this.disposed) return;
      this.phase = "offline";
      this.progress = null;
      this.error = `Staging failed: ${(err as Error).message}`;
      console.error(this.error);
      this.emit("info");
    }
  }

  private setProgress(label: string, done: number, total: number, force = false) {
    this.progress = { label, done, total };
    const now = Date.now();
    if (!force && done < total && now - this.lastInfoAt < 150) return;
    this.lastInfoAt = now;
    this.emit("info");
  }

  private staged(kind: ChainTxRow["kind"], r: SendResult, recipients: number) {
    this.record(kind, r, recipients, 0, this.world.domain.start);
  }

  private record(kind: ChainTxRow["kind"], r: SendResult, recipients: number, amountCents: number, simT = this.clock.now()) {
    if (r.signature === null) return;
    this.tiger.chainTx(this.key, {
      ts: new Date(),
      simT,
      kind,
      ok: r.ok,
      error: r.ok ? null : (r.decoded?.name ?? "Unknown"),
      recipients,
      amountCents,
      latencyMs: r.latencyMs,
      signature: r.signature,
    });
  }

  // ---------- declare + clock ----------

  /** The official declares: fund the treasury on-chain, sync the chain clock, start the network. */
  async declare(t: number, speed: number, playing: boolean) {
    if (this.phase !== "ready") throw new Error(`The network is ${this.phase}, not ready`);
    this.phase = "live";
    this.error = null;
    this.declaredMs = Date.now();
    this.clock.set(t, clampSpeed(speed), playing);
    this.emit("info");
    this.emit("clock");

    const r = await this.chain.fund(this.mint, this.world.budgetCents);
    this.record("fund", r, 0, this.world.budgetCents);
    if (!r.ok || this.disposed) {
      this.phase = "ready";
      this.error = `Funding failed: ${r.decoded?.message ?? "unknown error"}`;
      this.emit("info");
      return;
    }
    this.funded = true;
    this.fundSignature = r.signature;
    this.pushFeed({
      kind: "fund",
      signature: r.signature!,
      simT: this.clock.now(),
      usd: this.world.budgetCents / 100,
      title: "Treasury funded",
      detail: `${this.world.households.n.toLocaleString("en-US")} households enrolled in ${this.world.fullScale.declaredCounties} declared counties`,
      rule: null,
      latencyMs: r.latencyMs,
    });
    this.emit("info");
    void this.syncChainClock();
    this.tiger.markRun(this.key, "declared_at").catch((e) => console.error("markRun:", e.message));
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.clockTimer = setInterval(() => void this.checkChainClock(), CLOCK_CHECK_MS);
  }

  play() {
    if (!this.controllable()) return;
    this.clock.play();
    this.clockChanged();
  }

  pause() {
    if (!this.controllable()) return;
    this.clock.pause();
    this.clockChanged();
  }

  setSpeed(speed: number) {
    if (!this.controllable()) return;
    this.clock.setSpeed(clampSpeed(speed));
    this.clockChanged();
  }

  /** Jump forward. Aid that came due in the skipped time lands in a burst; skipped trips are re-spread over the next 12 h. */
  seek(t: number) {
    if (!this.controllable()) return;
    if (t <= this.clock.now() + 60) return;
    this.clock.seek(t);
    const now = this.clock.now();
    for (let h = 0; h < this.hh.n; h++) {
      const next = this.hh.nextTrip[h]!;
      if (this.hh.done[h] || !Number.isFinite(next) || next >= now) continue;
      this.schedule(h, now + this.rng.range(0, 12) * HOUR);
    }
    this.clockChanged();
  }

  private controllable() {
    return this.phase === "live" && !this.closing;
  }

  private clockChanged() {
    this.emit("clock");
    void this.syncChainClock();
  }

  /** The program's clock follows ours: time_scale = speed while playing, 1 while paused. */
  private async syncChainClock() {
    if (this.clockBusy) {
      this.clockAgain = true;
      return;
    }
    this.clockBusy = true;
    try {
      do {
        this.clockAgain = false;
        const scale = this.clock.playing ? this.clock.speed : 1;
        const simNow = Math.round(this.clock.now());
        const key = `${scale}:${this.clock.playing ? "" : simNow}`;
        if (key === this.lastClockSent) continue;
        const r = await this.chain.setClock(this.mint, scale, simNow);
        this.record("clock", r, 0, 0);
        this.clockSentAt = Date.now();
        if (r.ok) this.lastClockSent = key;
        else console.error("set_clock failed:", r.decoded?.message);
      } while (this.clockAgain && !this.disposed);
    } finally {
      this.clockBusy = false;
    }
  }

  /** Re-anchors the chain's clock when the validator's clock has pulled it away from ours. */
  private async checkChainClock() {
    if (this.clockChecking || this.clockBusy || this.closing || this.disposed || !this.clock.playing) return;
    // Right after a set_clock the declaration read may still show the old anchor.
    if (Date.now() - this.clockSentAt < 3 * CLOCK_CHECK_MS) return;
    this.clockChecking = true;
    try {
      const sent = Date.now();
      const chainT = await this.chain.chainSimNow(this.mint);
      if (!this.clock.playing || this.clockBusy || this.closing) return;
      const ours = this.clock.now() - ((Date.now() - sent) / 2000) * this.clock.speed;
      const drift = (chainT - ours) / this.clock.speed;
      if (drift > CLOCK_AHEAD_SECS || drift < -4 * CLOCK_AHEAD_SECS) {
        this.clockDrift.resyncs++;
        if (Math.abs(drift) > Math.abs(this.clockDrift.maxSecs)) this.clockDrift.maxSecs = drift;
        this.lastClockSent = "";
        await this.syncChainClock();
      }
    } catch {
      // Validator busy; the next check tries again.
    } finally {
      this.clockChecking = false;
    }
  }

  // ---------- the live loop ----------

  private tick() {
    if (this.disposed) return;
    const nowMs = Date.now();
    const dt = Math.min(0.25, (nowMs - this.lastTick) / 1000);
    this.lastTick = nowMs;
    const t = this.clock.now();
    const H = this.world.households;

    // Aid is due the moment the storm reaches a household's hex (or at the declaration, if later).
    while (this.duePtr < H.n) {
      const h = this.dueOrder[this.duePtr]!;
      const due = H.aidDue[h]!;
      if (due > t) break;
      this.duePtr++;
      if (!this.enrolled[h]) continue;
      this.aidQ.push(h);
      this.aidDueMs.push(Math.max(this.declaredMs, this.clock.wallTimeOf(due)));
    }
    this.dispatchAid();

    if (this.closing) return;
    if (t >= this.clock.end) {
      void this.closeOut();
      return;
    }

    // Shopping trips that are due, while the payment backlog is under BACKLOG_SECS of capacity;
    // beyond that, trips wait in the heap (the network is at its rate cap).
    const cap = config.maxTps * BACKLOG_SECS;
    const until = Math.min(t, this.clock.end - LAST_CALL_SECS * this.clock.speed);
    while (this.heap.peekKey() <= until && this.payQ.length - this.payHead < cap) {
      const [key, h] = this.heap.pop();
      if (key !== this.hh.nextTrip[h] || this.hh.done[h]) continue;
      const trip = this.shopper.trip(this.hh, h, t);
      if (trip.kind === "stop") {
        this.hh.done[h] = 1;
        this.hh.nextTrip[h] = Infinity;
        continue;
      }
      if (trip.kind === "orders") {
        for (const o of trip.orders) {
          this.hh.reserved[h]! += o.amountCents;
          this.hh.record(h, t, o.amountCents);
        }
        this.payQ.push({ orders: trip.orders, t });
      }
      this.schedule(h, trip.next);
    }

    this.tokens = Math.min(config.maxTps * 0.25, this.tokens + dt * config.maxTps);
    while (this.tokens >= 1 && this.payHead < this.payQ.length && this.payInFlight < PAY_IN_FLIGHT) {
      this.tokens -= 1;
      const job = this.payQ[this.payHead++]!;
      void this.payAll(job.orders, job.t);
    }
    if (this.payHead > 4_096) {
      this.payQ = this.payQ.slice(this.payHead);
      this.payHead = 0;
    }
  }

  private schedule(h: number, at: number) {
    this.hh.nextTrip[h] = at;
    this.heap.push(at, h);
  }

  private dispatchAid() {
    while (this.aidHead < this.aidQ.length && this.aidInFlight < AID_IN_FLIGHT) {
      const end = Math.min(this.aidQ.length, this.aidHead + DISBURSE_PER_TX);
      const hs = this.aidQ.slice(this.aidHead, end);
      const dues = this.aidDueMs.slice(this.aidHead, end);
      this.aidHead = end;
      void this.disburse(hs, dues);
    }
    if (this.aidHead > 4_096 && this.aidHead === this.aidQ.length) {
      this.aidQ = [];
      this.aidDueMs = [];
      this.aidHead = 0;
    }
  }

  private async disburse(hs: number[], dues: number[]) {
    const W = this.world;
    const H = W.households;
    this.aidInFlight++;
    const r = await this.chain.disburse(
      this.mint,
      hs.map((h) => ({ owner: this.residents[h]!.publicKey, cents: H.aidCents[h]! })),
    );
    this.aidInFlight--;
    if (this.disposed) return;
    const cents = hs.reduce((a, h) => a + H.aidCents[h]!, 0);
    this.record("disburse", r, hs.length, cents);
    if (!r.ok) {
      // Never landed (expired under load): try again. Rejected on-chain: give up on this batch.
      hs.forEach((h, k) => {
        if (r.signature === null && ++this.aidTries[h]! < 4) {
          this.aidQ.push(h);
          this.aidDueMs.push(dues[k]!);
        } else this.stats.aidFailed++;
      });
      if (r.signature !== null) console.error("disburse rejected:", r.decoded?.name, r.decoded?.message);
      return;
    }
    const now = Date.now();
    const simT = this.clock.now();
    for (let k = 0; k < hs.length; k++) {
      const h = hs[k]!;
      const h3 = H.h3[h]!;
      this.tiger.disbursement(this.key, { ts: new Date(now), simT, household: h, h3, amountCents: H.aidCents[h]!, timeToAidMs: Math.round(now - dues[k]!), signature: r.signature });
      this.shopper.funded(this.hh, h, simT);
      this.schedule(h, this.hh.nextTrip[h]!);
      const cell = this.batch.aid.get(h3) ?? { usd: 0, households: 0 };
      cell.usd += H.aidCents[h]! / 100;
      cell.households++;
      this.batch.aid.set(h3, cell);
    }
    this.stats.aidHouseholds += hs.length;
    this.stats.aidCents += cents;
    const counties = new Set(hs.map((h) => H.county[h]!));
    const first = countyLabel(W, H.county[hs[0]!]!);
    this.pushFeed({
      kind: "aid",
      signature: r.signature,
      simT,
      usd: cents / 100,
      title: `Aid landed · ${hs.length} ${hs.length === 1 ? "household" : "households"}`,
      detail: counties.size > 1 ? `${first} +${counties.size - 1} more` : first,
      rule: null,
      latencyMs: Math.round(now - Math.min(...dues)),
    });
  }

  /** A trip's orders go out one after another (a spree's third order must land last). */
  private async payAll(orders: Order[], t: number) {
    this.payInFlight++;
    try {
      for (const o of orders) await this.pay(o, t);
    } finally {
      this.payInFlight--;
    }
  }

  private destination(o: Order): Destination {
    const W = this.world;
    const H = W.households;
    if (o.resaleTo !== undefined) {
      const to = o.resaleTo;
      return { owner: this.residents[to]!.publicKey, name: "Another resident's wallet", category: "transfer", h3: H.h3[to]!, lonLat: [H.lon[to]!, H.lat[to]!] };
    }
    if (o.rogueStore !== undefined) {
      const h = o.household;
      return { owner: this.rogueStores[o.rogueStore]!.publicKey, name: "Unregistered store", category: "unregistered", h3: H.h3[h]!, lonLat: [H.lon[h]!, H.lat[h]!] };
    }
    const M = W.merchants;
    const m = o.merchant;
    return { owner: this.merchantKeys[m]!.publicKey, name: M.name[m]!, category: M.category[m]!, h3: M.h3[m]!, lonLat: [M.lon[m]!, M.lat[m]!] };
  }

  private async pay(o: Order, t: number) {
    const H = this.world.households;
    const h = o.household;
    const dest = this.destination(o);
    const r = await this.chain.pay({ mint: this.mint, resident: this.residents[h]!, merchant: dest.owner, cents: o.amountCents });
    this.hh.reserved[h]! -= o.amountCents;
    if (r.ok) this.hh.spent[h]! += o.amountCents;
    else this.hh.forget(h, t, o.amountCents);
    if (this.disposed) return;
    if (r.signature === null) {
      this.stats.dropped++;
      return;
    }
    const simT = this.clock.now();
    const error = r.ok ? null : (r.decoded?.name ?? "Unknown");
    this.tiger.payment(this.key, {
      ts: new Date(),
      simT,
      household: h,
      merchant: o.merchant,
      category: dest.category,
      amountCents: o.amountCents,
      itemIds: o.lines.map((l) => l.id),
      itemQty: o.lines.map((l) => l.qty),
      itemCents: o.lines.map((l) => l.cents),
      ok: r.ok,
      error,
      h3: H.h3[h]!,
      merchantH3: dest.h3,
      latencyMs: r.latencyMs,
      signature: r.signature,
    });

    if (r.ok) {
      this.stats.payments++;
      this.stats.spentCents += o.amountCents;
    } else {
      this.stats.blocked++;
      this.stats.blockedBy[error!] = (this.stats.blockedBy[error!] ?? 0) + 1;
    }

    // Arcs: a uniform sample of this batch's payments.
    const b = this.batch;
    const arc = { from: [round6(H.lon[h]!), round6(H.lat[h]!)] as [number, number], to: dest.lonLat.map(round6) as [number, number], usd: o.amountCents / 100, ok: r.ok, merchant: o.merchant };
    b.paysSeen++;
    if (b.pays.length < CAPS.arcs) b.pays.push(arc);
    else {
      const j = Math.floor(Math.random() * b.paysSeen);
      if (j < CAPS.arcs) b.pays[j] = arc;
    }

    const first = o.lines[0];
    this.pushFeed({
      kind: r.ok ? "payment" : "blocked",
      signature: r.signature,
      simT,
      usd: o.amountCents / 100,
      title: dest.name,
      detail: r.ok
        ? first
          ? `${first.qty > 1 ? `${first.qty}× ` : ""}${ALL_ITEMS[first.id]!.name}${o.lines.length > 1 ? ` +${o.lines.length - 1} more` : ""}`
          : "Purchase"
        : (REJECTION_COPY[error!] ?? r.decoded?.message ?? "Blocked on-chain"),
      rule: error,
      latencyMs: r.latencyMs,
    });
  }

  private pushFeed(item: FeedItem) {
    const b = this.batch;
    if (item.kind === "aid" || item.kind === "payment" || item.kind === "blocked") {
      if (b.counts[item.kind] >= CAPS[item.kind]) return;
      b.counts[item.kind]++;
    }
    b.feed.push({ ...item, usd: round2(item.usd) });
  }

  // ---------- Day 30 ----------

  /** Aid expires: wait for in-flight transactions, move the chain clock past expiry, claw back what's left. */
  private async closeOut() {
    if (this.closing) return;
    this.closing = true;
    this.clock.set(this.clock.end, this.clock.speed, false);
    this.emit("clock");
    for (let i = this.payHead; i < this.payQ.length; i++) {
      for (const o of this.payQ[i]!.orders) {
        this.hh.reserved[o.household]! -= o.amountCents;
        this.hh.forget(o.household, this.payQ[i]!.t, o.amountCents);
      }
    }
    this.payQ = [];
    this.payHead = 0;
    while (this.payInFlight > 0 || this.aidInFlight > 0 || this.aidHead < this.aidQ.length) await sleep(100);
    if (this.disposed) return;

    const W = this.world;
    const H = W.households;
    const owners: number[] = [];
    const left = (h: number) => H.aidCents[h]! - this.hh.spent[h]!;
    for (let h = 0; h < H.n; h++) if (!Number.isNaN(this.hh.fundedAt[h]!) && left(h) > 0) owners.push(h);

    this.setProgress("Returning unspent aid", 0, owners.length, true);
    const clock = await this.chain.setClock(this.mint, 1, W.domain.end + HOUR);
    this.record("clock", clock, 0, 0);
    let done = 0;
    const t0 = Date.now();
    await this.chain.clawback(
      this.mint,
      owners.map((h) => this.residents[h]!.publicKey),
      (k, r, first) => {
        const cents = owners.slice(first, first + k).reduce((a, h) => a + left(h), 0);
        this.record("clawback", r, k, cents);
        if (r.ok) this.stats.returnedCents += cents;
        this.setProgress("Returning unspent aid", (done += k), owners.length);
      },
      this.abort.signal,
    );
    if (this.disposed) return;
    this.pushFeed({
      kind: "clawback",
      signature: "",
      simT: this.clock.now(),
      usd: this.stats.returnedCents / 100,
      title: "Unspent aid returned to the treasury",
      detail: `${owners.length.toLocaleString("en-US")} wallets closed out on Day ${RECOVERY_DAY}`,
      rule: null,
      latencyMs: Date.now() - t0,
    });

    try {
      const d = await this.chain.fetchDeclaration(this.mint);
      const disbursed = Number(d.disbursed.toString()) / 10_000;
      const returned = Number(d.returned.toString()) / 10_000;
      if (disbursed !== this.stats.aidCents || returned !== this.stats.returnedCents) {
        console.warn(`close-out check: chain disbursed ${disbursed}¢ returned ${returned}¢, sim ${this.stats.aidCents}¢ / ${this.stats.returnedCents}¢`);
      }
    } catch (err) {
      console.error("fetchDeclaration:", (err as Error).message);
    }

    if (this.timer) clearInterval(this.timer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.clockDrift.resyncs) {
      console.log(`chain clock re-anchored ${this.clockDrift.resyncs}x (worst drift ${this.clockDrift.maxSecs.toFixed(1)} wall s)`);
    }
    this.progress = null;
    this.phase = "ended";
    this.emit("info");
    this.tiger.markRun(this.key, "ended_at").catch((e) => console.error("markRun:", e.message));
  }
}

const RECOVERY_DAY = 30;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clampSpeed = (s: number) => Math.max(60, Math.min(86_400, Number.isFinite(s) ? s : DEFAULT_SPEED));
