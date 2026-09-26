import type { Kpis, SpendSeries } from "@rescu/live";
import postgres from "postgres";

/** Every sim transaction except payments, which are recorded once, in `payments`. */
export interface ChainTxRow {
  ts: Date;
  simT: number;
  kind: "register" | "enroll" | "fund" | "disburse" | "clock" | "clawback" | "oracle" | "approve";
  ok: boolean;
  error: string | null;
  recipients: number;
  amountCents: number;
  latencyMs: number;
  signature: string;
}

export interface DisbursementRow {
  ts: Date;
  simT: number;
  household: number;
  h3: string;
  amountCents: number;
  timeToAidMs: number;
  signature: string;
}

export interface PaymentRow {
  ts: Date;
  simT: number;
  household: number;
  merchant: number;
  category: string;
  amountCents: number;
  itemIds: number[];
  itemQty: number[];
  itemCents: number[];
  ok: boolean;
  error: string | null;
  h3: string;
  merchantH3: string;
  latencyMs: number;
  signature: string;
}

type Totals = Pick<Kpis, "disbursedUsd" | "householdsPaid" | "returnedUsd" | "spentUsd" | "payments" | "blocked" | "blockedBy" | "timeToAidMs" | "paymentLatencyMs" | "spentByCategory">;
type PayGroup = { category: string; ok: boolean; error: string | null; txs: number; cents: string };
type AidTotals = { households: number | null; cents: string | null; p50: number | null; p95: number | null };
type Buffered<T> = T & { runId: string };

const date = (simT: number) => new Date(simT * 1000);
const arr = (xs: number[]) => `{${xs.join(",")}}`;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const CHUNK = 2_000;
/** Rows kept for retry while Tiger is unreachable (beyond this the oldest are dropped). */
const MAX_PENDING = 300_000;

/** Groups rows by run so each insert sends run_id once. */
function byRun<T extends { runId: string }>(rows: T[]): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.runId);
    if (list) list.push(r);
    else out.set(r.runId, [r]);
  }
  return [...out];
}

/**
 * Tiger (TimescaleDB): buffers the sim's events and writes them in batches every 500 ms, and
 * answers the Command Center's questions from continuous aggregates.
 *
 * Wire format: postgres.js mis-serializes arrays of Dates and booleans, so timestamps go in as
 * epoch numbers and flags as 0/1. Bytes matter (a laptop uplink can be ~200 KB/s): run ids are
 * sent once per insert, coordinates rounded.
 */
export class Tiger {
  readonly sql: postgres.Sql;
  ok = true;
  rows = 0;
  private chainTxs: Buffered<ChainTxRow>[] = [];
  private disbursements: Buffered<DisbursementRow>[] = [];
  private payments: Buffered<PaymentRow>[] = [];
  private ingested: { at: number; n: number }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private flushing: Promise<void> | null = null;

  constructor(url: string) {
    this.sql = postgres(url, { max: 8, onnotice: () => {}, idle_timeout: 60, connect_timeout: 15 });
  }

  start() {
    this.timer ??= setInterval(() => void this.flush(), 500);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.flush();
    await this.sql.end({ timeout: 10 });
  }

  chainTx(runId: string, r: ChainTxRow) {
    this.chainTxs.push({ ...r, runId });
  }

  disbursement(runId: string, r: DisbursementRow) {
    this.disbursements.push({ ...r, runId });
  }

  payment(runId: string, r: PaymentRow) {
    this.payments.push({ ...r, runId });
  }

  /** Rows written per second over the last 5 s. */
  rowsPerSec(): number {
    const cut = Date.now() - 5_000;
    this.ingested = this.ingested.filter((x) => x.at >= cut);
    return Math.round(this.ingested.reduce((a, x) => a + x.n, 0) / 5);
  }

  get pending() {
    return this.chainTxs.length + this.disbursements.length + this.payments.length;
  }

  /** Writes everything buffered; if a flush is already running, waits for it first. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOnce() {
    const c = this.chainTxs.splice(0);
    const d = this.disbursements.splice(0);
    const p = this.payments.splice(0);
    if (!c.length && !d.length && !p.length) return;
    const write = async <T extends { runId: string }>(rows: T[], insert: (runId: string, rows: T[]) => Promise<unknown>, requeue: (rows: T[]) => void) => {
      for (const [runId, list] of byRun(rows)) {
        for (let i = 0; i < list.length; i += CHUNK) {
          const chunk = list.slice(i, i + CHUNK);
          try {
            await insert(runId, chunk);
            this.rows += chunk.length;
            this.ingested.push({ at: Date.now(), n: chunk.length });
          } catch (err) {
            // A Postgres error (5-char SQLSTATE) means bad rows: drop them. Anything else is the connection: retry next flush.
            const code = (err as { code?: string }).code ?? "";
            this.ok = false;
            console.error(`tiger insert failed (${code}):`, (err as Error).message);
            if (!/^[0-9A-Z]{5}$/.test(code)) requeue(list.slice(i));
            break;
          }
        }
      }
    };
    this.ok = true;
    await Promise.all([
      write(c, (id, rows) => this.insertChainTxs(id, rows), (rows) => (this.chainTxs = rows.concat(this.chainTxs))),
      write(d, (id, rows) => this.insertDisbursements(id, rows), (rows) => (this.disbursements = rows.concat(this.disbursements))),
      write(p, (id, rows) => this.insertPayments(id, rows), (rows) => (this.payments = rows.concat(this.payments))),
    ]);
    if (this.pending > MAX_PENDING) {
      const drop = this.pending - MAX_PENDING;
      console.error(`tiger: dropping ${drop} buffered rows (unreachable too long)`);
      this.payments.splice(0, Math.min(drop, this.payments.length));
    }
  }

  private insertChainTxs(runId: string, rows: ChainTxRow[]) {
    const col = <T>(f: (r: ChainTxRow) => T) => rows.map(f);
    return this.sql`
      insert into chain_txs (ts, run_id, sim_ts, kind, ok, error, recipients, amount_cents, latency_ms, signature)
      select to_timestamp(ts / 1000.0), ${runId}::int8, to_timestamp(sim), kind, ok = 1, error, recipients, amount_cents, latency_ms, signature
      from unnest(
        ${col((r) => r.ts.getTime())}::int8[], ${col((r) => Math.round(r.simT))}::int8[], ${col((r) => r.kind)}::text[],
        ${col((r) => (r.ok ? 1 : 0))}::int[], ${col((r) => r.error)}::text[], ${col((r) => r.recipients)}::int[],
        ${col((r) => r.amountCents)}::int8[], ${col((r) => r.latencyMs)}::int[], ${col((r) => r.signature)}::text[]
      ) as u(ts, sim, kind, ok, error, recipients, amount_cents, latency_ms, signature)`;
  }

  private insertDisbursements(runId: string, rows: DisbursementRow[]) {
    const col = <T>(f: (r: DisbursementRow) => T) => rows.map(f);
    return this.sql`
      insert into disbursements (ts, run_id, sim_ts, household, h3_r5, amount_cents, time_to_aid_ms, signature)
      select to_timestamp(ts / 1000.0), ${runId}::int8, to_timestamp(sim), household, h3::h3index, amount_cents, time_to_aid_ms, signature
      from unnest(
        ${col((r) => r.ts.getTime())}::int8[], ${col((r) => Math.round(r.simT))}::int8[], ${col((r) => r.household)}::int[],
        ${col((r) => r.h3)}::text[], ${col((r) => r.amountCents)}::int8[], ${col((r) => r.timeToAidMs)}::int[],
        ${col((r) => r.signature)}::text[]
      ) as u(ts, sim, household, h3, amount_cents, time_to_aid_ms, signature)`;
  }

  private insertPayments(runId: string, rows: PaymentRow[]) {
    const col = <T>(f: (r: PaymentRow) => T) => rows.map(f);
    return this.sql`
      insert into payments (ts, run_id, sim_ts, household, merchant, category, amount_cents, item_ids, item_qty, item_cents,
                            ok, error, h3_r5, merchant_h3_r5, latency_ms, signature)
      select to_timestamp(ts / 1000.0), ${runId}::int8, to_timestamp(sim), household, merchant, category, amount_cents,
             ids::smallint[], qty::smallint[], cents::int[], ok = 1, error, h3::h3index, mh3::h3index, latency_ms, signature
      from unnest(
        ${col((r) => r.ts.getTime())}::int8[], ${col((r) => Math.round(r.simT))}::int8[], ${col((r) => r.household)}::int[],
        ${col((r) => r.merchant)}::int[], ${col((r) => r.category)}::text[], ${col((r) => r.amountCents)}::int8[],
        ${col((r) => arr(r.itemIds))}::text[], ${col((r) => arr(r.itemQty))}::text[], ${col((r) => arr(r.itemCents))}::text[],
        ${col((r) => (r.ok ? 1 : 0))}::int[], ${col((r) => r.error)}::text[], ${col((r) => r.h3)}::text[],
        ${col((r) => r.merchantH3)}::text[], ${col((r) => r.latencyMs)}::int[], ${col((r) => r.signature)}::text[]
      ) as u(ts, sim, household, merchant, category, amount_cents, ids, qty, cents, ok, error, h3, mh3, latency_ms, signature)`;
  }

  // ---------- run records ----------

  async insertRun(r: {
    id: string;
    stormId: string;
    mint: string;
    declaration: string;
    households: number;
    merchants: number;
    budgetCents: number;
    fullScaleHouseholds: number;
    simStart: number;
    simEnd: number;
    config: Record<string, unknown>;
  }) {
    await this.sql`
      insert into sim_runs (id, storm_id, mint, declaration, households, merchants, budget_cents, full_scale_households, sim_start, sim_end, config)
      values (${r.id}, ${r.stormId}, ${r.mint}, ${r.declaration}, ${r.households}, ${r.merchants}, ${r.budgetCents},
              ${r.fullScaleHouseholds}, ${date(r.simStart)}, ${date(r.simEnd)}, ${this.sql.json(r.config as postgres.JSONValue)})`;
  }

  async insertHouseholds(
    runId: string,
    h: { owner: string[]; geoid: string[]; county: string[]; h3: string[]; lat: ArrayLike<number>; lon: ArrayLike<number>; size: ArrayLike<number>; svi: ArrayLike<number>; aidCents: ArrayLike<number>; aidDue: ArrayLike<number> },
  ) {
    const n = h.owner.length;
    const chunks: number[][] = [];
    for (let i = 0; i < n; i += 5_000) chunks.push(Array.from({ length: Math.min(5_000, n - i) }, (_, k) => i + k));
    await Promise.all(
      chunks.map(
        (idx) => this.sql`
          insert into sim_households (run_id, idx, owner, geoid, county_fips, h3_r5, lat, lon, size, svi, aid_cents, aid_due_at)
          select ${runId}::int8, idx, owner, geoid, county, h3::h3index, lat, lon, size, svi, aid, to_timestamp(due)
          from unnest(
            ${idx}::int[], ${idx.map((k) => h.owner[k]!)}::text[], ${idx.map((k) => h.geoid[k]!)}::text[],
            ${idx.map((k) => h.county[k]!)}::text[], ${idx.map((k) => h.h3[k]!)}::text[],
            ${idx.map((k) => r6(h.lat[k]!))}::float8[], ${idx.map((k) => r6(h.lon[k]!))}::float8[], ${idx.map((k) => h.size[k]!)}::int2[],
            ${idx.map((k) => Math.round(h.svi[k]! * 1e4) / 1e4)}::real[], ${idx.map((k) => h.aidCents[k]!)}::int8[],
            ${idx.map((k) => Math.round(h.aidDue[k]!))}::int8[]
          ) as u(idx, owner, geoid, county, h3, lat, lon, size, svi, aid, due)`,
      ),
    );
  }

  async insertMerchants(
    runId: string,
    m: { owner: string[]; name: string[]; category: string[]; county: string[]; h3: string[]; lat: ArrayLike<number>; lon: ArrayLike<number>; closedFrom: ArrayLike<number>; reopensAt: ArrayLike<number> },
  ) {
    const idx = m.owner.map((_, i) => i);
    const ts = (v: number) => (Number.isNaN(v) ? null : Math.round(v));
    await this.sql`
      insert into sim_merchants (run_id, idx, owner, name, category, county_fips, h3_r5, lat, lon, closed_from, reopens_at)
      select ${runId}::int8, idx, owner, name, category, county, h3::h3index, lat, lon, to_timestamp(cf), to_timestamp(ro)
      from unnest(
        ${idx}::int[], ${m.owner}::text[], ${m.name}::text[], ${m.category}::text[], ${m.county}::text[], ${m.h3}::text[],
        ${idx.map((i) => r6(m.lat[i]!))}::float8[], ${idx.map((i) => r6(m.lon[i]!))}::float8[],
        ${idx.map((i) => ts(m.closedFrom[i]!))}::int8[], ${idx.map((i) => ts(m.reopensAt[i]!))}::int8[]
      ) as u(idx, owner, name, category, county, h3, lat, lon, cf, ro)`;
  }

  async markRun(runId: string, field: "declared_at" | "ended_at") {
    await this.sql`update sim_runs set ${this.sql(field)} = now() where id = ${runId}`;
  }

  // ---------- live numbers ----------

  /** Run totals from the continuous aggregates (real-time, so they include the last second). */
  async totals(runId: string): Promise<Totals> {
    const [returned, pays, latency, aid] = await Promise.all([
      this.sql<{ cents: string | null }[]>`
        select sum(amount_cents)::int8 as cents from chain_txs_1s where run_id = ${runId} and kind = 'clawback' and ok`,
      this.sql<PayGroup[]>`
        select category, ok, error, sum(txs)::int as txs, sum(amount_cents)::int8 as cents
        from payments_1s where run_id = ${runId} group by category, ok, error`,
      this.sql<{ p50: number | null }[]>`
        select approx_percentile(0.5, rollup(latency)) as p50 from payments_1s where run_id = ${runId} and ok`,
      this.sql<AidTotals[]>`
        select sum(households)::int as households, sum(amount_cents)::int8 as cents,
               approx_percentile(0.5, rollup(time_to_aid)) as p50, approx_percentile(0.95, rollup(time_to_aid)) as p95
        from disbursements_1s where run_id = ${runId}`,
    ]);
    return summarize(Number(returned[0]?.cents ?? 0), pays, latency[0]?.p50 ?? null, aid[0]);
  }

  /** The same numbers as of a sim time, from the raw hypertables (history view). */
  async totalsAt(runId: string, simT: number): Promise<Totals> {
    const at = date(simT);
    const [returned, pays, latency, aid] = await Promise.all([
      this.sql<{ cents: string | null }[]>`
        select sum(amount_cents)::int8 as cents from chain_txs where run_id = ${runId} and kind = 'clawback' and ok and sim_ts <= ${at}`,
      this.sql<PayGroup[]>`
        select category, ok, error, count(*)::int as txs, sum(amount_cents)::int8 as cents
        from payments where run_id = ${runId} and sim_ts <= ${at} group by category, ok, error`,
      this.sql<{ p50: number | null }[]>`
        select percentile_cont(0.5) within group (order by latency_ms) as p50 from payments where run_id = ${runId} and ok and sim_ts <= ${at}`,
      this.sql<AidTotals[]>`
        select count(*)::int as households, sum(amount_cents)::int8 as cents,
               percentile_cont(0.5) within group (order by time_to_aid_ms) as p50,
               percentile_cont(0.95) within group (order by time_to_aid_ms) as p95
        from disbursements where run_id = ${runId} and sim_ts <= ${at}`,
    ]);
    return summarize(Number(returned[0]?.cents ?? 0), pays, latency[0]?.p50 ?? null, aid[0]);
  }

  /** Confirmed transactions per second for the last minute, oldest first. */
  async txSeries(runId: string): Promise<number[]> {
    const now = Math.floor(Date.now() / 1000);
    const since = new Date((now - 60) * 1000);
    const rows = await this.sql<{ s: number; n: number }[]>`
      select s, sum(n)::int as n from (
        select extract(epoch from bucket)::int as s, txs as n
        from chain_txs_1s where run_id = ${runId} and bucket >= ${since} and kind in ('disburse', 'clawback')
        union all
        select extract(epoch from bucket)::int as s, txs as n
        from payments_1s where run_id = ${runId} and bucket >= ${since}
      ) u group by s`;
    const out = new Array<number>(60).fill(0);
    for (const r of rows) {
      const i = r.s - (now - 60);
      if (i >= 0 && i < 60) out[i] = r.n;
    }
    return out;
  }

  async spendSeries(runId: string, t0: number, step: number, buckets: number, until: number | null): Promise<SpendSeries> {
    const cut = until === null ? null : date(until);
    const [spent, aid] = await Promise.all([
      this.sql<{ b: number; cents: string }[]>`
        select floor((extract(epoch from sim_ts) - ${t0}) / ${step})::int as b, sum(amount_cents)::int8 as cents
        from payments where run_id = ${runId} and ok and (${cut}::timestamptz is null or sim_ts <= ${cut}) group by 1`,
      this.sql<{ b: number; cents: string }[]>`
        select floor((extract(epoch from sim_ts) - ${t0}) / ${step})::int as b, sum(amount_cents)::int8 as cents
        from disbursements where run_id = ${runId} and (${cut}::timestamptz is null or sim_ts <= ${cut}) group by 1`,
    ]);
    const fill = (rows: { b: number; cents: string }[]) => {
      const out = new Array<number>(buckets).fill(0);
      for (const r of rows) if (r.b >= 0 && r.b < buckets) out[r.b] = Number(r.cents) / 100;
      return out;
    };
    return { t0, step, spentUsd: fill(spent), aidUsd: fill(aid) };
  }

  /** Share of bytes saved by the columnstore across the live-network hypertables (null until a chunk is compressed). */
  async compression(): Promise<number | null> {
    const [r] = await this.sql<{ before: number | null; after: number | null }[]>`
      select sum(before_compression_total_bytes)::float8 as before, sum(after_compression_total_bytes)::float8 as after
      from (
        select * from hypertable_columnstore_stats('payments')
        union all select * from hypertable_columnstore_stats('chain_txs')
        union all select * from hypertable_columnstore_stats('disbursements')
      ) s`;
    if (!r?.before || !r.after) return null;
    return 1 - r.after / r.before;
  }
}

function summarize(returnedCents: number, pays: PayGroup[], paymentLatency: number | null, aid: AidTotals | undefined): Totals {
  let spentCents = 0;
  let payments = 0;
  let blocked = 0;
  const blockedBy = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const r of pays) {
    if (r.ok) {
      spentCents += Number(r.cents);
      payments += r.txs;
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + Number(r.cents));
    } else {
      blocked += r.txs;
      const rule = r.error ?? "Unknown";
      blockedBy.set(rule, (blockedBy.get(rule) ?? 0) + r.txs);
    }
  }
  return {
    disbursedUsd: Number(aid?.cents ?? 0) / 100,
    householdsPaid: aid?.households ?? 0,
    returnedUsd: returnedCents / 100,
    spentUsd: spentCents / 100,
    payments,
    blocked,
    blockedBy: [...blockedBy].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count),
    timeToAidMs: aid?.p50 != null && aid.p95 != null ? { p50: Math.round(aid.p50), p95: Math.round(aid.p95) } : null,
    paymentLatencyMs: paymentLatency === null ? null : Math.round(paymentLatency),
    spentByCategory: [...byCategory].map(([category, cents]) => ({ category, usd: cents / 100 })).sort((a, b) => b.usd - a.usd),
  };
}
