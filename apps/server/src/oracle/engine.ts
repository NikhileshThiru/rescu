import { type ActionInput, type CaseKind, caseOrder, type Evidence, type Feature, type OracleActionKind, type OracleActionRecord, type OracleCase, type OracleMetrics, type PlantedKind, type SubjectRef } from "@rescu/live";
import {
  combineScore,
  detectCollusion,
  detectGouging,
  detectVelocity,
  duplicateScore,
  FeatureModel,
  gougeScore,
  type IdentityCluster,
  identityClusters,
  type IdentityRecord,
  maskIdentity,
  type Neighbor,
  neighborIndex,
  ORACLE_DEFAULTS,
  regionalMedians,
  RESIDENT_FEATURES,
  type ResidentActivity,
  type ResidentTopStore,
  round,
  severityOf,
  type ShelfItem,
  STORE_FEATURES,
  velocityBaseline,
} from "@rescu/oracle";
import { ALL_ITEMS } from "../catalog.js";
import type { JoinEvent, PaymentEvent, PriceEvent } from "../network/events.js";
import { ApiFail } from "../network/errors.js";
import type { Run } from "../run.js";
import type { Services } from "../services.js";
import { countyLabel } from "../world.js";
import { Summarizer } from "./summaries.js";

const SCAN_MS = 2_000;
const PRICE_DEBOUNCE_MS = 300;
/** Refit the forests at most this often (they barely move between scans). */
const REFIT_MS = 10_000;
/** A case update is re-published at most this often unless its status or summary changed. */
const PUBLISH_MS = 1_500;
const HOUR = 3_600;
const CAP_RULES = new Set(["OverDailyCap", "OverOrderCap"]);
const TIMELINE_KEEP = 40;
const PEERS = 6;
const MAX_ITEMS = 64;

interface ResAgg {
  orders: number;
  capHits: number;
  blocked: number;
  spent: number;
  spent48: number;
  firstAt: number;
  lastAt: number;
  byStore: Map<number, number>;
  timeline: { simT: number; cents: number; ok: boolean; rule: string | null }[];
}

/** Everything the oracle knows about one run. A new run starts from scratch. */
class RunState {
  readonly cases = new Map<string, OracleCase>();
  readonly res = new Map<number, ResAgg>();
  /** Relief purchases at a price over the line, per store+item. */
  readonly gougedSales = new Map<number, { sales: number; over: number }>();
  readonly joins: JoinEvent[] = [];
  /** Stores whose price someone set at the terminal (the live demo, not planted). */
  readonly manualStores = new Set<number>();
  readonly neighbors: Neighbor[][];
  readonly medians: Map<number, number>[];
  identity: IdentityCluster[] = [];
  identityDirty = true;
  scans = 0;
  lastScanMs = 0;
  lastScanAt = 0;
  fitAt = 0;
  readonly storeModel = new FeatureModel(STORE_FEATURES, { trees: ORACLE_DEFAULTS.trees, sampleSize: ORACLE_DEFAULTS.sampleSize, seed: 17 });
  readonly residentModel = new FeatureModel(RESIDENT_FEATURES, { trees: ORACLE_DEFAULTS.trees, sampleSize: ORACLE_DEFAULTS.sampleSize, seed: 29 });
  storeRows: number[][] = [];
  residentRows = new Map<number, number[]>();
  readonly lastPublish = new Map<string, number>();
  readonly busy = new Set<string>();
  readonly summarizer: Summarizer;

  constructor(
    readonly run: Run,
    summarizer: (st: RunState) => Summarizer,
  ) {
    const M = run.world.merchants;
    const geo = Array.from({ length: M.n }, (_, m) => ({ lat: M.lat[m]!, lon: M.lon[m]! }));
    this.neighbors = neighborIndex(geo, ORACLE_DEFAULTS.radiusKm);
    const pre: ShelfItem[][] = Array.from({ length: M.n }, (_, m) =>
      run.market.shelf(m).map((i) => {
        const c = run.market.preStorm(m, i.id);
        return { itemId: i.id, preStormCents: c, priceCents: c };
      }),
    );
    this.medians = regionalMedians(pre, this.neighbors);
    this.summarizer = summarizer(this);
  }

  get runId() {
    return this.run.key;
  }
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** "Bottled water, 24-pack" -> "bottled water"; acronyms stay ("AA batteries", "LED flashlight"). */
export const shortItem = (name: string) => {
  const s = name.split(",")[0]!;
  return /^[A-Z][A-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
};

/**
 * The watchdog. Keeps running aggregates from the run's events, scans every 2 s (and 300 ms after
 * a terminal price change), opens one case per (kind, subject) and updates it in place, flags
 * the store or resident on the map, asks Grok for a write-up, and carries out the presenter's
 * actions on-chain (suspend a store, freeze a wallet).
 */
export class OracleEngine {
  private st: RunState | null = null;
  private timer: ReturnType<typeof setInterval>;
  private priceTimer?: ReturnType<typeof setTimeout>;
  readonly gougePct = ORACLE_DEFAULTS.gougePct;
  readonly scoreToOpen = ORACLE_DEFAULTS.scoreToOpen;

  constructor(private readonly s: Services) {
    s.sim.on("run", () => this.attach());
    s.hub.addSnapshot((run) => (this.st?.runId === run.key ? [{ type: "cases", runId: run.key, cases: this.list() }] : []));
    this.timer = setInterval(() => this.tick(), SCAN_MS);
    this.timer.unref?.();
    this.attach();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.priceTimer);
    this.st?.summarizer.stop();
  }

  /** Follows `sim.run`: a new run gets fresh state and listeners. */
  attach(run: Run | null = this.s.sim.run) {
    if (!run || this.st?.run === run) return;
    if (run.phase === "offline" || run.phase === "staging") {
      // Merchant keys and shelves are ready once staging ends; attach then.
      if (this.st && this.st.run !== run) {
        this.st.summarizer.stop();
        this.st = null;
      }
      return;
    }
    this.st?.summarizer.stop();
    const st = new RunState(run, (me) => new Summarizer(this.s.grok, (id) => me.cases.get(id), (c) => this.publish(me, c, true)));
    this.st = st;
    run.on("payment", (e) => this.onPayment(st, e));
    run.on("price", (e) => this.onPrice(st, e));
    run.on("join", (e) => this.onJoin(st, e));
    this.s.hub.publish({ type: "cases", runId: run.key, cases: [] });
  }

  // ---------- events ----------

  private agg(st: RunState, idx: number): ResAgg {
    let a = st.res.get(idx);
    if (!a) {
      a = { orders: 0, capHits: 0, blocked: 0, spent: 0, spent48: 0, firstAt: Number.NaN, lastAt: Number.NaN, byStore: new Map(), timeline: [] };
      st.res.set(idx, a);
    }
    return a;
  }

  private onPayment(st: RunState, e: PaymentEvent) {
    if (this.st !== st) return;
    const a = this.agg(st, e.resident);
    if (Number.isNaN(a.firstAt)) a.firstAt = e.simT;
    a.lastAt = e.simT;
    if (e.ok) {
      a.orders++;
      a.spent += e.cents;
      const aidAt = st.run.aidLog.get(e.resident)?.simT;
      if (aidAt !== undefined && e.simT - aidAt <= 48 * HOUR) a.spent48 += e.cents;
      if (e.merchant >= 0) {
        a.byStore.set(e.merchant, (a.byStore.get(e.merchant) ?? 0) + e.cents);
        const med = st.medians[e.merchant];
        const limit = 1 + this.gougePct / 100;
        for (const l of e.lines) {
          const m = med?.get(l.itemId);
          if (!m || l.unitCents <= m * limit) continue;
          const k = e.merchant * MAX_ITEMS + l.itemId;
          const g = st.gougedSales.get(k) ?? { sales: 0, over: 0 };
          g.sales += l.qty;
          g.over += Math.round((l.unitCents - m) * l.qty);
          st.gougedSales.set(k, g);
        }
      }
    } else {
      a.blocked++;
      if (e.rule && CAP_RULES.has(e.rule)) a.capHits++;
    }
    a.timeline.push({ simT: e.simT, cents: e.cents, ok: e.ok, rule: e.rule });
    if (a.timeline.length > TIMELINE_KEEP) a.timeline.splice(0, a.timeline.length - TIMELINE_KEEP);
  }

  private onPrice(st: RunState, e: PriceEvent) {
    if (this.st !== st) return;
    if (e.by === "merchant") st.manualStores.add(e.merchant);
    clearTimeout(this.priceTimer);
    this.priceTimer = setTimeout(() => this.scan(), PRICE_DEBOUNCE_MS);
  }

  private onJoin(st: RunState, e: JoinEvent) {
    if (this.st !== st) return;
    st.joins.push(e);
    st.identityDirty = true;
  }

  // ---------- scanning ----------

  private tick() {
    this.attach();
    const st = this.st;
    if (!st || st.run !== this.s.sim.run) return;
    const phase = st.run.phase;
    if (phase === "ready" || phase === "live" || phase === "ended") this.scan();
  }

  /** One full pass over the network. Returns how long it took (ms). */
  scan(): number {
    const st = this.st;
    if (!st) return 0;
    const t0 = performance.now();
    try {
      this.scanRun(st);
    } catch (err) {
      console.error("oracle scan:", (err as Error).stack ?? err);
    }
    st.scans++;
    st.lastScanMs = round(performance.now() - t0, 1);
    st.lastScanAt = Date.now();
    return st.lastScanMs;
  }

  private scanRun(st: RunState) {
    const run = st.run;
    const t = run.clock.now();
    const M = run.world.merchants;
    const market = run.market;

    // Shelves at today's prices.
    const shelves: ShelfItem[][] = Array.from({ length: M.n }, (_, m) =>
      market.shelf(m).map((i) => ({ itemId: i.id, preStormCents: market.preStorm(m, i.id), priceCents: market.price(m, i.id, t) })),
    );
    const gouges = detectGouging(shelves, st.medians, this.gougePct);
    const gougeByStore = new Map(gouges.map((g) => [g.store, g]));

    // Per-store customers (from the residents' books).
    const customers: Map<number, number>[] = Array.from({ length: M.n }, () => new Map());
    for (const [r, a] of st.res) for (const [m, c] of a.byStore) customers[m]?.set(r, c);

    if (st.identityDirty) {
      st.identity = identityClusters(this.identityRecords(st));
      st.identityDirty = false;
    }
    const clusterOf = new Map<number, IdentityCluster>();
    for (const c of st.identity) for (const r of c.members) clusterOf.set(r, c);

    // Residents who have shopped.
    const acts: ResidentActivity[] = [];
    const tops: ResidentTopStore[] = [];
    for (const [idx, a] of st.res) {
      const aid = this.aidOf(run, idx);
      const landed = run.aidLog.get(idx);
      acts.push({ resident: idx, aidCents: aid, aidAt: landed?.simT ?? null, orders: a.orders, capHits: a.capHits, spentCents: a.spent, spent48hCents: a.spent48, lastAt: Number.isNaN(a.lastAt) ? null : a.lastAt });
      let best = -1;
      let bestC = 0;
      for (const [m, c] of a.byStore) if (c > bestC) [best, bestC] = [m, c];
      if (best >= 0) tops.push({ resident: idx, aidCents: aid, spentCents: a.spent, orders: a.orders, store: best, centsAtStore: bestC });
    }

    // Feature rows and the forests.
    st.storeRows = Array.from({ length: M.n }, (_, m) => this.storeRow(st, m, gougeByStore.get(m)?.items ?? [], customers[m]!));
    const now = Date.now();
    if (now - st.fitAt > REFIT_MS || !st.storeModel.forest.fitted) {
      st.residentRows = new Map();
      for (const x of acts) st.residentRows.set(x.resident, this.residentRow(st, x, clusterOf.get(x.resident)));
      st.storeModel.fit(st.storeRows);
      if (st.residentRows.size >= 16) st.residentModel.fit([...st.residentRows.values()]);
      st.fitAt = now;
    }

    // ---- gouging: one case per store ----
    for (const g of gouges) {
      const m = g.store;
      const worst = g.items[0]!;
      const item = ALL_ITEMS[worst.itemId]!;
      const sold = st.gougedSales.get(m * MAX_ITEMS + worst.itemId) ?? { sales: 0, over: 0 };
      let over = 0;
      for (const it of g.items) over += st.gougedSales.get(m * MAX_ITEMS + it.itemId)?.over ?? 0;
      const peers = st.neighbors[m]!.filter((n) => market.carries(n.store, worst.itemId))
        .slice(0, PEERS)
        .map((n) => ({ store: n.store, name: M.name[n.store]!, priceCents: market.price(n.store, worst.itemId, t), distanceKm: round(n.km, 1) }));
      const evidence: Evidence = {
        kind: "gouging",
        itemId: worst.itemId,
        item: item.name,
        priceCents: worst.priceCents,
        medianCents: worst.medianCents,
        ratio: round(worst.ratio, 2),
        thresholdPct: this.gougePct,
        sales: sold.sales,
        overchargeCents: over,
        series: market.priceSeries(m, worst.itemId, t),
        peers,
        otherItems: g.items.slice(1).map((i) => ({ itemId: i.itemId, item: ALL_ITEMS[i.itemId]!.name, ratio: round(i.ratio, 2) })),
      };
      const row = st.storeRows[m]!;
      this.upsert(st, {
        id: `gouge-${m}`,
        kind: "gouging",
        rule: gougeScore(worst.ratio, this.gougePct, g.items.length),
        title: `${M.name[m]} charging ${worst.ratio.toFixed(1)}x for ${shortItem(item.name)}`,
        subjects: [this.storeRef(run, m)],
        evidence,
        features: st.storeModel.features(row, [0.02, 0.5, 0.1, 0.02, 0.01, 0.5]),
        anomaly: st.storeModel.forest.fitted ? st.storeModel.anomaly(row) : null,
        recommended: ["suspend_merchant"],
        priority: st.manualStores.has(m) ? 2 : 1,
      });
    }

    // ---- duplicate identity: one case per cluster, once aid has landed for two of them ----
    for (const c of st.identity) {
      const landed = c.members.filter((r) => run.aidLog.has(r));
      if (landed.length < 2) continue;
      const households = c.members.map((r) => ({
        resident: r,
        name: run.people.name(r),
        county: this.countyOf(run, r),
        aidCents: this.aidOf(run, r),
        registeredAt: this.registeredAt(st, r),
      }));
      const firstLanded = landed.map((r) => ({ r, at: run.aidLog.get(r)!.simT })).sort((a, b) => a.at - b.at)[0]!.r;
      const dupAid = landed.filter((r) => r !== firstLanded).reduce((a, r) => a + this.aidOf(run, r), 0);
      const rowOf = (r: number) => st.residentRows.get(r) ?? this.residentRow(st, this.activityOf(st, r), c);
      const anomalies = st.residentModel.forest.fitted ? c.members.map((r) => st.residentModel.anomaly(rowOf(r))) : [];
      const key = c.key;
      this.upsert(st, {
        id: `dup-${c.members[0]}`,
        kind: "duplicate_identity",
        rule: duplicateScore(c),
        title: `${c.members.length} households registered on one ${key === "device" ? "device" : key === "phone" ? "phone number" : "address"}`,
        subjects: c.members.map((r) => this.residentRef(run, r)),
        evidence: { kind: "duplicate_identity", key, value: maskIdentity(key, c.value), households, duplicateAidCents: dupAid },
        features: st.residentModel.features(rowOf(c.members[0]!), RESIDENT_FLOORS),
        anomaly: anomalies.length ? Math.max(...anomalies) : null,
        recommended: ["freeze_wallet"],
        priority: 1,
      });
    }

    // ---- velocity ----
    const base = velocityBaseline(acts);
    for (const h of detectVelocity(acts, {}, base)) {
      const a = st.res.get(h.resident)!;
      const aidAt = run.aidLog.get(h.resident)?.simT ?? a.firstAt;
      const row = st.residentRows.get(h.resident) ?? this.residentRow(st, this.activityOf(st, h.resident), clusterOf.get(h.resident));
      const name = run.people.name(h.resident);
      const aid = this.aidOf(run, h.resident);
      const hours = Math.max(0, (a.lastAt - aidAt) / HOUR);
      this.upsert(st, {
        id: `vel-${h.resident}`,
        kind: "velocity",
        rule: h.score,
        title: h.reason === "caps" ? `${name} refused ${a.capHits} times for going over the limits` : `${name} spent ${Math.round(h.share48h * 100)}% of their aid in 48 hours`,
        subjects: [this.residentRef(run, h.resident)],
        evidence: { kind: "velocity", resident: h.resident, orders: a.orders, capHits: a.capHits, spentCents: a.spent, aidCents: aid, hours: round(hours, 1), timeline: a.timeline.slice() },
        features: st.residentModel.features(row, RESIDENT_FLOORS),
        anomaly: st.residentModel.forest.fitted ? st.residentModel.anomaly(row) : null,
        recommended: ["freeze_wallet"],
        priority: 1,
      });
    }

    // ---- collusion ----
    const volumes = Array.from({ length: M.n }, (_, m) => ({ store: m, category: M.category[m]!, volumeCents: market.salesCents[m]! }));
    for (const h of detectCollusion(volumes, tops, st.neighbors)) {
      const m = h.store;
      const row = st.storeRows[m]!;
      this.upsert(st, {
        id: `col-${m}`,
        kind: "collusion",
        rule: h.score,
        title: `${h.residents.length} residents spending nearly all their aid at ${M.name[m]}`,
        subjects: [this.storeRef(run, m), ...h.residents.map((r) => this.residentRef(run, r.resident))],
        evidence: {
          kind: "collusion",
          merchant: m,
          merchantName: M.name[m]!,
          residents: h.residents.map((r) => ({ resident: r.resident, name: run.people.name(r.resident), spentCents: r.spentCents, shareAtStore: round(r.share, 3) })),
          storeVolumeCents: Math.round(h.volumeCents),
          expectedVolumeCents: Math.round(h.expectedCents),
          concentration: round(h.concentration, 3),
        },
        features: st.storeModel.features(row, [0.02, 0.5, 0.1, 0.02, 0.01, 0.5]),
        anomaly: st.storeModel.forest.fitted ? st.storeModel.anomaly(row) : null,
        recommended: ["suspend_merchant", "freeze_wallet"],
        priority: 1,
      });
    }
  }

  private storeRow(st: RunState, m: number, gouged: { ratio: number }[], customers: Map<number, number>): number[] {
    const market = st.run.market;
    const sales = market.salesCents[m]!;
    const pays = market.payments[m]!;
    const refused = market.blocked[m]!;
    const top = [...customers.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    return [gouged.length ? gouged[0]!.ratio : 1, gouged.length, Math.log1p(sales / 100), sales > 0 ? Math.min(1, top / sales) : 0, pays + refused > 0 ? refused / (pays + refused) : 0, pays ? sales / pays / 100 : 0];
  }

  private residentRow(st: RunState, x: ResidentActivity, cluster: IdentityCluster | undefined): number[] {
    const a = st.res.get(x.resident);
    const now = st.run.clock.now();
    const days = x.aidAt !== null ? Math.max(1, (now - x.aidAt) / 86_400) : 1;
    let top = 0;
    if (a) for (const c of a.byStore.values()) top = Math.max(top, c);
    return [
      x.orders / days,
      x.capHits,
      x.aidCents > 0 ? x.spent48hCents / x.aidCents : 0,
      x.spentCents > 0 ? top / x.spentCents : 0,
      cluster ? cluster.members.length - 1 : 0,
      x.orders > 0 && x.aidCents > 0 ? x.spentCents / x.orders / x.aidCents : 0,
    ];
  }

  private activityOf(st: RunState, idx: number): ResidentActivity {
    const a = st.res.get(idx);
    return {
      resident: idx,
      aidCents: this.aidOf(st.run, idx),
      aidAt: st.run.aidLog.get(idx)?.simT ?? null,
      orders: a?.orders ?? 0,
      capHits: a?.capHits ?? 0,
      spentCents: a?.spent ?? 0,
      spent48hCents: a?.spent48 ?? 0,
      lastAt: a && !Number.isNaN(a.lastAt) ? a.lastAt : null,
    };
  }

  private identityRecords(st: RunState): IdentityRecord[] {
    const H = st.run.world.households;
    const out: IdentityRecord[] = [];
    for (let i = 0; i < H.n; i++) out.push({ resident: i, device: H.device[i] ?? "", phone: H.phone[i] ?? "", address: H.address[i] ?? "" });
    for (const j of st.joins) out.push({ resident: j.resident, device: j.identity.device, phone: j.identity.phone, address: j.identity.address });
    return out;
  }

  private aidOf(run: Run, idx: number): number {
    const H = run.world.households;
    return idx < H.n ? H.aidCents[idx]! : (run.people.get(idx)?.aidCents ?? 0);
  }

  private countyOf(run: Run, idx: number): string {
    const H = run.world.households;
    return idx < H.n ? countyLabel(run.world, H.county[idx]!) : (run.people.get(idx)?.county ?? "");
  }

  /** Sim time the household registered: before the storm for the sim's households, at the join for phones. */
  private registeredAt(st: RunState, idx: number): number {
    return st.joins.find((j) => j.resident === idx)?.simT ?? st.run.world.domain.start;
  }

  private storeRef(run: Run, m: number): SubjectRef {
    return { kind: "merchant", idx: m, name: run.world.merchants.name[m]! };
  }

  private residentRef(run: Run, idx: number): SubjectRef {
    return { kind: "resident", idx, name: run.people.name(idx) };
  }

  // ---------- cases ----------

  private upsert(
    st: RunState,
    x: {
      id: string;
      kind: CaseKind;
      rule: number;
      title: string;
      subjects: SubjectRef[];
      evidence: Evidence;
      features: Feature[];
      anomaly: number | null;
      recommended: OracleActionKind[];
      priority: number;
    },
  ) {
    const run = st.run;
    const anomaly = x.anomaly === null ? null : round(x.anomaly, 3);
    const score = combineScore(x.rule, anomaly);
    const prev = st.cases.get(x.id);
    const fromApp = x.subjects.some((s) => (s.kind === "merchant" ? st.manualStores.has(s.idx) : run.people.isApp(s.idx)));
    const now = Date.now();
    if (!prev) {
      if (score < this.scoreToOpen) return;
      const c: OracleCase = {
        id: x.id,
        runId: run.key,
        kind: x.kind,
        status: "open",
        score,
        severity: severityOf(score),
        title: x.title,
        subjects: x.subjects,
        openedAt: now,
        updatedAt: now,
        simT: run.clock.now(),
        evidence: x.evidence,
        features: x.features,
        anomaly,
        summary: { status: "pending", text: null, model: null },
        recommended: x.recommended,
        fromApp,
        actions: [],
      };
      st.cases.set(c.id, c);
      this.flag(st, c, true);
      this.publish(st, c, true);
      st.summarizer.enqueue(c.id, x.priority * 10 + score);
      return;
    }
    const material =
      prev.fromApp !== fromApp ||
      prev.title !== x.title || Math.abs(prev.score - score) >= 0.01 || prev.subjects.length !== x.subjects.length || JSON.stringify(evidenceKey(prev.evidence)) !== JSON.stringify(evidenceKey(x.evidence));
    prev.fromApp = fromApp;
    prev.score = score;
    prev.severity = severityOf(score);
    prev.title = x.title;
    prev.evidence = x.evidence;
    prev.features = x.features;
    prev.anomaly = anomaly;
    if (prev.subjects.length !== x.subjects.length) {
      prev.subjects = x.subjects;
      if (prev.status === "open") this.flag(st, prev, true);
    }
    if (material) {
      prev.updatedAt = now;
      this.publish(st, prev, false);
    }
  }

  /** Map dots: an open case turns its store amber and marks its residents. */
  private flag(st: RunState, c: OracleCase, on: boolean) {
    const run = st.run;
    for (const s of c.subjects) {
      if (s.kind === "merchant") {
        if (on) {
          if (run.market.caseOf[s.idx] !== c.id) run.flagStore(s.idx, c.id);
        } else if (run.market.caseOf[s.idx] === c.id) run.flagStore(s.idx, null);
      } else if (on) {
        if (run.residentCase.get(s.idx) !== c.id) run.flagResident(s.idx, c.id);
      } else if (run.residentCase.get(s.idx) === c.id) run.flagResident(s.idx, null);
    }
  }

  private publish(st: RunState, c: OracleCase, force: boolean) {
    if (this.st !== st) return;
    const now = Date.now();
    const last = st.lastPublish.get(c.id) ?? 0;
    if (!force && now - last < PUBLISH_MS) return;
    st.lastPublish.set(c.id, now);
    this.s.hub.publish({ type: "case", runId: st.runId, case: c });
  }

  // ---------- reads ----------

  private current(): RunState | null {
    const run = this.s.sim.run;
    if (run && this.st?.run !== run) this.attach(run);
    return this.st && this.st.run === run ? this.st : null;
  }

  list(status?: string): OracleCase[] {
    const st = this.current();
    if (!st) return [];
    const out = [...st.cases.values()].filter((c) => !status || c.status === status);
    return out.sort(caseOrder);
  }

  get(id: string): OracleCase {
    const c = this.current()?.cases.get(id);
    if (!c) throw new ApiFail(404, "not_found", `No case ${id}`);
    return c;
  }

  metrics(): OracleMetrics {
    const st = this.current();
    if (!st) throw new ApiFail(409, "no_run", "No relief network is running");
    const run = st.run;
    const t = run.clock.now();
    const cases = [...st.cases.values()];
    const kinds: CaseKind[] = ["gouging", "duplicate_identity", "velocity", "collusion"];
    const named = (c: OracleCase) => c.status !== "dismissed";
    const caughtM = new Set<number>();
    const caughtR = new Set<number>();
    for (const c of cases.filter(named)) for (const s of c.subjects) (s.kind === "merchant" ? caughtM : caughtR).add(s.idx);

    const planted = run.world.planted ?? [];
    const plantedM = new Set<number>();
    const plantedR = new Set<number>();
    for (const p of planted) {
      for (const m of p.merchants) plantedM.add(m);
      for (const r of p.residents) plantedR.add(r);
    }
    const acted = (p: (typeof planted)[number]): boolean => {
      switch (p.kind) {
        case "gouging":
          return p.merchants.some((m) => {
            const from = run.world.merchants.gougeFrom[m]!;
            return !Number.isNaN(from) && from <= t;
          });
        case "duplicate_identity":
          return p.residents.filter((r) => run.aidLog.has(r)).length >= 2;
        case "velocity":
          return p.residents.some((r) => (st.res.get(r)?.orders ?? 0) + (st.res.get(r)?.capHits ?? 0) > 0);
        case "collusion":
          return p.residents.some((r) => p.merchants.some((m) => (st.res.get(r)?.byStore.get(m) ?? 0) > 0));
      }
    };
    const byKind = new Map<PlantedKind, { total: number; caught: number; acted: number }>();
    for (const p of planted) {
      const k = byKind.get(p.kind) ?? { total: 0, caught: 0, acted: 0 };
      k.total++;
      if (acted(p)) {
        k.acted++;
        if (p.merchants.some((m) => caughtM.has(m)) || p.residents.some((r) => caughtR.has(r))) k.caught++;
      }
      byKind.set(p.kind, k);
    }
    // Precision over cases about the sim's own actors (the presenter's price edits and app residents are live demo cases).
    const app = new Set(run.people.all().map((r) => r.idx));
    const scored = cases.filter((c) => named(c) && !c.subjects.some((s) => (s.kind === "merchant" ? st.manualStores.has(s.idx) : app.has(s.idx))));
    const hits = scored.filter((c) => c.subjects.some((s) => (s.kind === "merchant" ? plantedM.has(s.idx) : plantedR.has(s.idx))));
    const actedTotal = [...byKind.values()].reduce((a, k) => a + k.acted, 0);
    const caughtTotal = [...byKind.values()].reduce((a, k) => a + k.caught, 0);
    const g = this.s.grok.stats();
    return {
      runId: run.key,
      scans: st.scans,
      lastScanMs: st.lastScanMs,
      lastScanAt: st.lastScanAt,
      thresholds: { gougePct: this.gougePct, scoreToOpen: this.scoreToOpen },
      cases: kinds.map((kind) => ({
        kind,
        open: cases.filter((c) => c.kind === kind && c.status === "open").length,
        actioned: cases.filter((c) => c.kind === kind && c.status === "actioned").length,
        dismissed: cases.filter((c) => c.kind === kind && c.status === "dismissed").length,
      })),
      planted: kinds.map((kind) => {
        const k = byKind.get(kind);
        return { kind, total: k?.acted ?? 0, caught: k?.caught ?? 0 };
      }),
      precision: scored.length ? round(hits.length / scored.length, 3) : null,
      recall: actedTotal ? round(caughtTotal / actedTotal, 3) : null,
      model: st.storeModel.forest.fitted
        ? {
            name: "Isolation forest",
            trees: st.storeModel.forest.trees,
            sampleSize: st.storeModel.forest.sampleSize,
            features: [...STORE_FEATURES, ...RESIDENT_FEATURES].map((f) => f.label),
            trainedOn: st.storeModel.trainedOn + st.residentModel.trainedOn,
          }
        : null,
      grok: { summaries: st.summarizer.count, usd: round(st.summarizer.usd, 4), spentUsd: g.spentUsd, limitUsd: g.limitUsd },
    };
  }

  // ---------- actions ----------

  async act(id: string, input: ActionInput, by: "presenter" | "auto" = "presenter"): Promise<OracleCase> {
    const st = this.current();
    if (!st) throw new ApiFail(409, "no_run", "No relief network is running");
    const c = st.cases.get(id);
    if (!c) throw new ApiFail(404, "not_found", `No case ${id}`);
    if (st.busy.has(id)) throw new ApiFail(409, "busy", "An action on this case is still going through");
    const run = st.run;
    const wantKind = input.kind === "suspend_merchant" || input.kind === "reinstate_merchant" ? "merchant" : input.kind === "freeze_wallet" || input.kind === "unfreeze_wallet" ? "resident" : null;
    const targets = wantKind ? c.subjects.filter((s) => s.kind === wantKind && (input.target === undefined || s.idx === input.target)) : [];
    if (wantKind && !targets.length) throw new ApiFail(400, "no_target", `This case has no ${wantKind === "merchant" ? "store" : "resident"}${input.target !== undefined ? ` ${input.target}` : ""} to act on`);
    const reason = reasonOf(c);
    const record = (kind: OracleActionKind, target: SubjectRef | null, r: { ok: boolean; signature: string | null; error: string | null }) =>
      c.actions.push({ kind, target, at: Date.now(), simT: run.clock.now(), ok: r.ok, signature: r.signature, error: r.error, by } satisfies OracleActionRecord);

    st.busy.add(id);
    try {
      switch (input.kind) {
        case "dismiss":
          c.status = "dismissed";
          this.flag(st, c, false);
          record("dismiss", null, { ok: true, signature: null, error: null });
          break;
        case "reopen":
          c.status = c.actions.some((a) => a.ok && a.signature) ? "actioned" : "open";
          this.flag(st, c, true);
          record("reopen", null, { ok: true, signature: null, error: null });
          break;
        default:
          for (const target of targets) {
            try {
              const r =
                input.kind === "suspend_merchant" || input.kind === "reinstate_merchant"
                  ? await run.setStoreStatus(target.idx, input.kind === "suspend_merchant" ? "suspended" : "approved", input.kind === "suspend_merchant" ? reason : "Reinstated after review")
                  : await run.setWalletFrozen(target.idx, input.kind === "freeze_wallet", input.kind === "freeze_wallet" ? reason : "Thawed after review");
              record(input.kind, target, { ok: r.ok, signature: r.signature, error: r.ok ? null : (r.message ?? r.rule) });
            } catch (err) {
              record(input.kind, target, { ok: false, signature: null, error: (err as Error).message });
            }
          }
          if (c.actions.some((a) => a.ok && a.signature)) c.status = "actioned";
          if (input.kind === "reinstate_merchant") for (const s of targets) if (run.market.caseOf[s.idx] === c.id) run.flagStore(s.idx, null);
          break;
      }
    } finally {
      st.busy.delete(id);
    }
    c.updatedAt = Date.now();
    this.publish(st, c, true);
    return c;
  }
}

const RESIDENT_FLOORS = [0.1, 0.5, 0.02, 0.05, 0.5, 0.01];

/** The parts of the evidence that matter for "did this case change" (not the ever-growing series tail). */
function evidenceKey(e: Evidence): unknown {
  switch (e.kind) {
    case "gouging":
      return [e.itemId, e.priceCents, e.sales, e.overchargeCents, e.otherItems.length, e.peers.map((p) => p.priceCents)];
    case "duplicate_identity":
      return [e.households.length, e.duplicateAidCents];
    case "velocity":
      return [e.orders, e.capHits, e.spentCents];
    case "collusion":
      return [e.residents.length, Math.round(e.storeVolumeCents / 1000)];
  }
}

function reasonOf(c: OracleCase): string {
  const e = c.evidence;
  switch (e.kind) {
    case "gouging":
      return `Price gouging: ${shortItem(e.item)} at ${usd(e.priceCents)}, ${e.ratio.toFixed(1)}x the regional median`;
    case "duplicate_identity":
      return `Duplicate registration: ${e.households.length} households on one ${e.key}`;
    case "velocity":
      return e.capHits >= 2 ? `Refused ${e.capHits} times for going over the limits` : `Spent ${Math.round((e.spentCents / Math.max(1, e.aidCents)) * 100)}% of aid in ${Math.max(1, Math.round(e.hours))} h`;
    case "collusion":
      return `Suspected aid-for-cash with ${e.residents.length} residents`;
  }
}
