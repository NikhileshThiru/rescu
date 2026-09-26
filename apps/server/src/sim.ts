import { EventEmitter } from "node:events";
import type { RunInfo } from "@rescu/live";
import type { ChainRunner } from "./chain.js";
import { config } from "./config.js";
import { demoStorms, loadStormFile, loadTracts } from "./inputs.js";
import { Run } from "./run.js";
import type { Tiger } from "./tiger.js";
import { buildWorld, type World } from "./world.js";

const HEALTH_MS = 5_000;
/** A run whose staging failed is retried this often. */
const RESTAGE_MS = 30_000;

/**
 * Owns the one live network. Clients share it: any of them can declare, drive the clock or
 * reset, but staging a different storm never replaces a live run (reset it first).
 */
export class Sim extends EventEmitter<{ run: []; clock: []; history: [] }> {
  run: Run | null = null;
  /** Why the network can't run (validator or Tiger down, config missing). */
  offline: string | null = "Starting up";
  /** Viewing the network as of sim time t; `resume` = it was playing before. */
  history: { t: number; resume: boolean } | null = null;
  private slug = config.defaultStorm;
  private worlds = new Map<string, World>();
  private healthTimer?: ReturnType<typeof setInterval>;
  private op: Promise<void> = Promise.resolve();
  private lastStageAt = 0;

  constructor(
    readonly chain: ChainRunner,
    readonly tiger: Tiger,
  ) {
    super();
  }

  info(): RunInfo {
    const run = this.run;
    if (this.offline && run && (run.phase === "live" || run.phase === "ended")) return { ...run.info(), error: this.offline };
    if (this.offline) return offlineInfo(this.slug, this.offline, run);
    return run?.info() ?? offlineInfo(this.slug, "No network staged", null);
  }

  async health(): Promise<string | null> {
    if (!config.seed) return "SIM_WALLET_SEED is not set in .env";
    if (!config.tigerUrl) return "TIGER_DATABASE_URL is not set in .env";
    if (!(await this.chain.reachable())) return `Solana validator unreachable at ${config.rpcUrl}`;
    try {
      await this.tiger.sql`select 1`;
    } catch (err) {
      return `Tiger unreachable: ${(err as Error).message}`;
    }
    return null;
  }

  /** Checks the validator and Tiger every few seconds; stages the default storm once both are up. */
  async boot() {
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const reason = await this.health();
        const was = this.offline;
        this.offline = reason;
        if (reason !== was) this.emit("run");
        if (reason) return;
        const run = this.run;
        if (run && was && (run.phase === "ready" || run.phase === "live" || run.phase === "ended")) {
          // Back from an outage: keep the run if its declaration survived (the validator kept its ledger).
          if (await this.chain.fetchDeclaration(run.mint).then(() => true, () => false)) return;
        } else if (run && run.phase !== "offline") return;
        if (run?.phase === "offline" && Date.now() - this.lastStageAt < RESTAGE_MS) return;
        await this.stage(this.slug, true).catch((e) => console.error("stage:", e.message));
      } finally {
        checking = false;
      }
    };
    await check();
    this.healthTimer = setInterval(() => void check(), HEALTH_MS);
  }

  stop() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.run?.dispose();
  }

  async world(slug: string): Promise<World> {
    let w = this.worlds.get(slug);
    if (!w) {
      if (!demoStorms().some((s) => s.slug === slug)) throw new Error(`Unknown storm ${slug}`);
      const input = loadStormFile(slug);
      const tracts = await loadTracts(this.tiger.sql, input.storm.id);
      w = buildWorld(input, tracts, { households: config.households, merchantsMax: config.merchantsMax, seed: config.seed });
      this.worlds.set(slug, w);
    }
    return w;
  }

  /** Prepares a network for this storm. No-op if it's already staging, ready or live. Calls run one at a time. */
  stage(slug: string, force = false): Promise<void> {
    const next = this.op.then(() => this.doStage(slug, force));
    this.op = next.catch(() => {});
    return next;
  }

  private async doStage(slug: string, force: boolean) {
    const cur = this.run;
    if (cur && cur.phase === "live") {
      if (cur.slug === slug) return;
      throw new Error(`A relief network is live for ${cur.world.stormName}. Reset it first.`);
    }
    if (!force && cur && cur.slug === slug && (cur.phase === "staging" || cur.phase === "ready")) return;
    if (this.offline) throw new Error(this.offline);
    this.slug = slug;
    this.lastStageAt = Date.now();
    const world = await this.world(slug);
    cur?.dispose();
    this.history = null;
    const run = new Run(world, this.chain, this.tiger);
    this.run = run;
    run.on("info", () => this.emit("run"));
    run.on("clock", () => this.emit("clock"));
    this.emit("history");
    this.emit("run");
    this.emit("clock");
    const t0 = Date.now();
    // Staging runs in the background; the caller only waits for the world to build.
    void run.stage().then(() => {
      if (run.phase === "ready") console.log(`staged ${world.stormName} run ${run.key}: ${world.households.n} households, ${world.merchants.n} stores in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    });
  }

  /** Resolves once the current run leaves staging (headless runs). */
  async staged(): Promise<Run> {
    await this.op;
    const run = this.run;
    if (!run) throw new Error("No network staged");
    while (run.phase === "staging") await new Promise((r) => setTimeout(r, 100));
    if (run.phase !== "ready") throw new Error(run.error ?? `network is ${run.phase}`);
    return run;
  }

  async declare(t: number, speed: number, playing: boolean) {
    const run = this.run;
    if (!run) throw new Error("No network staged");
    await run.declare(t, speed, playing);
  }

  /** Drops the current run and stages a fresh one for the same storm. */
  async reset() {
    const slug = this.run?.slug ?? this.slug;
    this.run?.dispose();
    this.run = null;
    this.history = null;
    this.emit("history");
    await this.stage(slug, true);
  }

  play() {
    this.leaveHistory(false);
    this.run?.play();
  }

  pause() {
    this.leaveHistory(false);
    this.run?.pause();
  }

  setSpeed(speed: number) {
    this.run?.setSpeed(speed);
  }

  seek(t: number) {
    this.leaveHistory(false);
    this.run?.seek(t);
  }

  /** View the network as of sim time t (pauses the live run), or return to live with null. */
  setHistory(t: number | null) {
    const run = this.run;
    if (!run || (run.phase !== "live" && run.phase !== "ended")) return;
    if (t === null) {
      this.leaveHistory(true);
      return;
    }
    if (!this.history) {
      this.history = { t, resume: run.clock.playing };
      if (run.clock.playing) run.pause();
    }
    this.history.t = Math.min(t, run.clock.now());
    this.emit("history");
  }

  private leaveHistory(resume: boolean) {
    if (!this.history) return;
    const was = this.history;
    this.history = null;
    this.emit("history");
    if (resume && was.resume) this.run?.play();
  }
}

function offlineInfo(slug: string, reason: string, run: Run | null): RunInfo {
  const base = run?.info();
  return {
    id: base?.id ?? "",
    slug: base?.slug ?? slug,
    stormName: base?.stormName ?? "",
    phase: "offline",
    progress: null,
    error: base?.error ?? reason,
    households: base?.households ?? 0,
    fullScaleHouseholds: base?.fullScaleHouseholds ?? 0,
    merchants: base?.merchants ?? 0,
    budgetUsd: base?.budgetUsd ?? 0,
    funded: false,
    fundSignature: null,
    mint: base?.mint ?? "",
    declaration: base?.declaration ?? "",
    rules: base?.rules ?? { perOrderCapUsd: 200, dailyCapUsd: 300, expiresAt: 0 },
    explorerCluster: base?.explorerCluster ?? "",
  };
}
