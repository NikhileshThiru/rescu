import type { ClientMsg, Kpis, ServerMsg, SpendSeries } from "@rescu/live";
import type { WebSocket, WebSocketServer } from "ws";
import type { Run } from "./run.js";
import type { Sim } from "./sim.js";
import type { Tiger } from "./tiger.js";

const BATCH_MS = 250;
const KPI_MS = 1_000;
const SERIES_MS = 5_000;
const COMPRESSION_MS = 60_000;
const CLOCK_HEARTBEAT_MS = 5_000;
/** Timeline buckets for the recovery spending curve. */
const SERIES_STEP = 3 * 3600;

/** One WebSocket for every Command Center: run state, the clock, live numbers and events. */
export class Hub {
  private readonly clients = new Set<WebSocket>();
  private kpis: { runId: string; kpis: Kpis } | null = null;
  private series: { runId: string; series: SpendSeries } | null = null;
  private compression: { at: number; pct: number | null } = { at: 0, pct: null };
  private kpiBusy = false;
  private kpiAgain = false;
  private seriesBusy = false;
  private seriesAgain = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private runKey = "";
  private readonly snapshots: ((run: Run) => ServerMsg[])[] = [];

  constructor(
    wss: WebSocketServer,
    private readonly sim: Sim,
    private readonly tiger: Tiger,
  ) {
    wss.on("connection", (ws) => this.connect(ws));
    sim.on("run", () => {
      this.broadcast({ type: "run", run: sim.info() });
      const run = sim.run;
      if (run && run.key !== this.runKey) {
        this.runKey = run.key;
        this.kpis = null;
        this.series = null;
        this.broadcast({ type: "merchants", runId: run.key, merchants: run.merchantDots() });
        run.on("store", (state) => this.broadcast({ type: "store", runId: run.key, state }));
        for (const msg of this.snapshotOf(run)) this.broadcast(msg);
      }
    });
    sim.on("clock", () => this.sendClock());
    sim.on("history", () => {
      this.sendClock();
      void this.pushKpis(true);
      void this.pushSeries(true);
    });
    this.timers.push(
      setInterval(() => this.pushBatch(), BATCH_MS),
      setInterval(() => void this.pushKpis(), KPI_MS),
      setInterval(() => void this.pushSeries(), SERIES_MS),
      setInterval(() => this.sendClock(), CLOCK_HEARTBEAT_MS),
    );
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    for (const ws of this.clients) ws.close(1001, "server shutting down");
  }

  get connections() {
    return this.clients.size;
  }

  /** Sends a message to every connected page (the oracle engine's `case` updates, for one). */
  publish(msg: ServerMsg) {
    this.broadcast(msg);
  }

  /**
   * Registers messages every page gets on connect and whenever a new run starts (e.g. the oracle's
   * `cases` list). Called with the current run; return [] to send nothing.
   */
  addSnapshot(fn: (run: Run) => ServerMsg[]) {
    this.snapshots.push(fn);
  }

  private snapshotOf(run: Run): ServerMsg[] {
    const out: ServerMsg[] = [{ type: "stores", runId: run.key, states: run.market.nonDefaultStates() }];
    for (const fn of this.snapshots) {
      try {
        out.push(...fn(run));
      } catch (err) {
        console.error("snapshot:", (err as Error).message);
      }
    }
    return out;
  }

  private connect(ws: WebSocket) {
    this.clients.add(ws);
    const run = this.sim.run;
    this.send(ws, { type: "hello", serverTime: Date.now(), run: this.sim.info(), clock: this.clockOf(run) });
    const clock = this.clockMsg();
    if (clock) this.send(ws, clock);
    if (run) this.send(ws, { type: "merchants", runId: run.key, merchants: run.merchantDots() });
    if (run) for (const msg of this.snapshotOf(run)) this.send(ws, msg);
    if (run && this.kpis?.runId === run.key) this.send(ws, { type: "kpis", ...this.kpis });
    if (run && this.series?.runId === run.key) this.send(ws, { type: "series", ...this.series });
    ws.on("message", (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      this.handle(ws, msg).catch((err) => this.send(ws, { type: "error", message: (err as Error).message }));
    });
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
  }

  private async handle(ws: WebSocket, msg: ClientMsg) {
    const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    switch (msg?.type) {
      case "ping":
        this.send(ws, { type: "pong", client: num(msg.client) ? msg.client : 0, server: Date.now() });
        return;
      case "stage":
        if (typeof msg.slug === "string") await this.sim.stage(msg.slug);
        return;
      case "declare":
        if (!num(msg.t) || !num(msg.speed)) return;
        await this.sim.declare(msg.t, msg.speed, !!msg.playing);
        return;
      case "play":
        this.sim.play();
        return;
      case "pause":
        this.sim.pause();
        return;
      case "speed":
        if (num(msg.speed)) this.sim.setSpeed(msg.speed);
        return;
      case "seek":
        if (num(msg.t)) this.sim.seek(msg.t);
        return;
      case "history":
        if (msg.t === null || num(msg.t)) this.sim.setHistory(msg.t);
        return;
      case "reset":
        await this.sim.reset();
        return;
    }
  }

  private clockOf(run: Run | null) {
    if (!run || (run.phase !== "live" && run.phase !== "ended")) return null;
    const c = run.clock.state;
    return this.sim.history ? { ...c, t: this.sim.history.t, at: Date.now(), playing: false } : c;
  }

  private clockMsg(): ServerMsg | null {
    const run = this.sim.run;
    const clock = this.clockOf(run);
    return clock && run ? { type: "clock", clock, history: !!this.sim.history, head: run.clock.now() } : null;
  }

  private sendClock() {
    const msg = this.clockMsg();
    if (msg) this.broadcast(msg);
  }

  private pushBatch() {
    const run = this.sim.run;
    if (!run || run.phase !== "live") return;
    const batch = run.drainBatch();
    if (batch) this.broadcast({ type: "batch", runId: run.key, batch });
  }

  /** Live numbers from Tiger's continuous aggregates, or as of the history point from the raw hypertables. */
  private async pushKpis(force = false) {
    const run = this.sim.run;
    if (!run || (run.phase !== "live" && run.phase !== "ended")) return;
    const history = this.sim.history;
    if ((history && !force) || !this.clients.size) return;
    if (this.kpiBusy) {
      this.kpiAgain ||= force;
      return;
    }
    this.kpiBusy = true;
    const t0 = performance.now();
    try {
      const [totals, txSeries] = await Promise.all([
        history ? this.tiger.totalsAt(run.key, history.t) : this.tiger.totals(run.key),
        history ? Promise.resolve(new Array<number>(60).fill(0)) : this.tiger.txSeries(run.key),
      ]);
      const queryMs = Math.round(performance.now() - t0);
      if (Date.now() - this.compression.at > COMPRESSION_MS) {
        this.compression = { at: Date.now(), pct: await this.tiger.compression().catch(() => null) };
      }
      const recent = txSeries.slice(54, 58);
      const kpis: Kpis = {
        simT: history ? history.t : run.clock.now(),
        history: !!history,
        ...totals,
        treasuryUsd: run.funded ? Math.max(0, Math.round(run.budgetCents - totals.disbursedUsd * 100 + totals.returnedUsd * 100) / 100) : 0,
        txPerSec: Math.round(recent.reduce((a, b) => a + b, 0) / recent.length),
        txSeries,
        tiger: { ok: this.tiger.ok, rowsPerSec: this.tiger.rowsPerSec(), rows: this.tiger.rows, queryMs, compressionPct: this.compression.pct },
      };
      if (this.sim.run !== run || this.sim.history?.t !== history?.t) return;
      this.kpis = { runId: run.key, kpis };
      this.broadcast({ type: "kpis", runId: run.key, kpis });
    } catch (err) {
      console.error("kpis:", (err as Error).message);
    } finally {
      this.kpiBusy = false;
      if (this.kpiAgain) {
        this.kpiAgain = false;
        void this.pushKpis(true);
      }
    }
  }

  private async pushSeries(force = false) {
    const run = this.sim.run;
    if (!run || (run.phase !== "live" && run.phase !== "ended")) return;
    const history = this.sim.history;
    if ((history && !force) || !this.clients.size) return;
    if (this.seriesBusy) {
      this.seriesAgain ||= force;
      return;
    }
    this.seriesBusy = true;
    try {
      const { start, end } = run.world.domain;
      const series = await this.tiger.spendSeries(run.key, start, SERIES_STEP, Math.ceil((end - start) / SERIES_STEP), history?.t ?? null);
      if (this.sim.run !== run || this.sim.history?.t !== history?.t) return;
      this.series = { runId: run.key, series };
      this.broadcast({ type: "series", runId: run.key, series });
    } catch (err) {
      console.error("series:", (err as Error).message);
    } finally {
      this.seriesBusy = false;
      if (this.seriesAgain) {
        this.seriesAgain = false;
        void this.pushSeries(true);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg) {
    if (!this.clients.size) return;
    const data = JSON.stringify(msg);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }
}
