"use client";

import type { CaseKind, OracleActionKind, OracleActionRecord, OracleCase, OracleMetrics, StoreState, SubjectRef } from "@rescu/live";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useLive } from "@/lib/live";
import { txHref, simClock } from "../merchant/money";
import { PageBar, PageShell, useLiveClient } from "../merchant/page-bar";
import { Badge, Button, cx, Dot, Panel, Segmented } from "../ui/primitives";
import { EvidenceView } from "./evidence";
import { ago, caseTone, KIND_LABEL, KIND_SHORT, pct, STATUS_LABEL } from "./labels";

const EASE = [0.16, 1, 0.3, 1] as const;
const METRICS_MS = 3_000;
const KINDS: CaseKind[] = ["gouging", "duplicate_identity", "velocity", "collusion"];

type Filter = "open" | "actioned" | "all";

function readCaseParam(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("case") || null;
  } catch {
    return null;
  }
}

/** Residents whose latest successful oracle action is a freeze. */
function frozenSet(cases: OracleCase[]): Set<number> {
  const latest = new Map<number, { at: number; frozen: boolean }>();
  for (const c of cases)
    for (const a of c.actions) {
      if (!a.ok || a.target?.kind !== "resident") continue;
      if (a.kind !== "freeze_wallet" && a.kind !== "unfreeze_wallet") continue;
      const prev = latest.get(a.target.idx);
      if (!prev || prev.at <= a.at) latest.set(a.target.idx, { at: a.at, frozen: a.kind === "freeze_wallet" });
    }
  const out = new Set<number>();
  for (const [idx, v] of latest) if (v.frozen) out.add(idx);
  return out;
}

/** Re-render every few seconds so "2 min ago" stays true. */
function useNow(ms = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The oracle's own numbers (precision/recall against the planted actors, model, Grok spend), polled. */
function useMetrics(runId: string | null, active: boolean): OracleMetrics | null {
  const [m, setM] = useState<OracleMetrics | null>(null);
  useEffect(() => {
    setM(null);
    if (!runId || !active) return;
    let stop = false;
    const load = async () => {
      try {
        const next = await api("GET /api/oracle/metrics");
        if (!stop && next.runId === runId) setM(next);
      } catch {
        // keep the last good one
      }
    };
    void load();
    const id = setInterval(load, METRICS_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [runId, active]);
  return m;
}

/**
 * The oracle console: every case the watchdog opened on this run, newest first, with its
 * evidence, the Grok write-up, the model's reasons, and the on-chain actions (suspend a store,
 * freeze a wallet) that make the chain itself refuse them afterwards.
 */
export function OracleConsole() {
  const live = useLiveClient();
  const run = useLive(live, (s) => s.run);
  const cases = useLive(live, (s) => s.cases);
  const stores = useLive(live, (s) => s.stores);
  const link = useLive(live, (s) => s.link);
  const now = useNow();
  const runId = run?.id ?? null;
  const active = !!run && (run.phase === "ready" || run.phase === "live" || run.phase === "ended");
  const metrics = useMetrics(runId, active);

  const [filter, setFilter] = useState<Filter>("open");
  const [kind, setKind] = useState<CaseKind | null>(null);
  const [selected, setSelected] = useState<string | null>(() => (typeof window === "undefined" ? null : readCaseParam()));

  const frozen = useMemo(() => frozenSet(cases), [cases]);
  const counts = useMemo(() => {
    const byStatus = { open: 0, actioned: 0, all: cases.length };
    for (const c of cases) if (c.status === "open") byStatus.open++;
    else if (c.status === "actioned") byStatus.actioned++;
    return byStatus;
  }, [cases]);
  const shown = useMemo(() => cases.filter((c) => (filter === "all" || c.status === filter) && (!kind || c.kind === kind)), [cases, filter, kind]);

  // A deep-linked case that isn't in the current filter: widen the filter rather than hide it.
  const deepLinked = useRef(selected);
  useEffect(() => {
    const id = deepLinked.current;
    if (!id) return;
    const c = cases.find((x) => x.id === id);
    if (!c) return;
    deepLinked.current = null;
    if (c.status !== filter && filter !== "all") setFilter("all");
    if (kind && c.kind !== kind) setKind(null);
  }, [cases, filter, kind]);

  // Nothing (or a vanished case) selected: take the newest in view.
  const current = cases.find((c) => c.id === selected) ?? null;
  useEffect(() => {
    if (current || deepLinked.current) return;
    const first = shown[0];
    if (first && first.id !== selected) setSelected(first.id);
  }, [current, shown, selected]);

  // Keep ?case= in the URL without a navigation.
  useEffect(() => {
    if (!selected) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("case") === selected) return;
    url.searchParams.set("case", selected);
    window.history.replaceState(null, "", url);
  }, [selected]);

  // ↑/↓ (or j/k) walk the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
      if (!dir || !shown.length) return;
      e.preventDefault();
      const i = shown.findIndex((c) => c.id === selected);
      const next = shown[Math.max(0, Math.min(shown.length - 1, i < 0 ? 0 : i + dir))];
      if (next) setSelected(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, selected]);

  const noRun = !run || run.phase === "offline" || run.phase === "staging";

  return (
    <PageShell>
      <PageBar live={live} title="Oracle" />
      <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)_300px] gap-3 p-3">
        {/* Cases */}
        <Panel className="flex min-h-0 flex-col overflow-hidden">
          <div className="space-y-2.5 px-3 pt-3.5 pb-2.5">
            <div className="flex items-center justify-between px-1">
              <h2 className="eyebrow">Cases</h2>
              <span className="flex items-center gap-1.5 text-2xs text-text-3">
                <Dot tone="amber" pulse={run?.phase === "live"} />
                {metrics ? `Scanning every 2 s · ${metrics.lastScanMs} ms` : "Watching"}
              </span>
            </div>
            <Segmented<Filter>
              stretch
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "open", label: <FilterLabel label="Open" n={counts.open} tone="amber" /> },
                { value: "actioned", label: <FilterLabel label="Acted on" n={counts.actioned} tone="red" /> },
                { value: "all", label: <FilterLabel label="All" n={counts.all} /> },
              ]}
            />
            <div className="flex flex-wrap gap-1">
              {KINDS.map((k) => {
                const n = cases.filter((c) => c.kind === k && (filter === "all" || c.status === filter)).length;
                const on = kind === k;
                return (
                  <button
                    key={k}
                    onClick={() => setKind(on ? null : k)}
                    className={cx(
                      "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-2xs transition-colors duration-150",
                      on ? "border-line-strong bg-surface-3 text-text" : "border-line text-text-3 hover:text-text-2",
                    )}
                  >
                    {KIND_SHORT[k]}
                    <span className="tabular text-text-3">{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="h-px bg-line" />
          <CaseList cases={shown} selected={selected} onSelect={setSelected} now={now} stores={stores} frozen={frozen} empty={noRun ? null : cases.length ? "No cases match this filter." : null} />
        </Panel>

        {/* Case */}
        <Panel className="flex min-h-0 flex-col overflow-hidden">
          {link !== "open" && !run ? (
            <Empty title="Connecting to the Rescu server…" body="The oracle watches the live relief network; its cases show up here." />
          ) : noRun ? (
            <Empty title={run?.phase === "staging" ? "Preparing the relief network…" : "No relief network is running"} body="Start one from the Command Center. The oracle begins watching every price and payment the moment it's live." />
          ) : !current ? (
            <Empty
              title="No cases yet"
              body="The oracle checks every store's prices against nearby stores' pre-storm prices and every resident's spending pattern, every 2 seconds. Raise a price on the Merchant terminal to see a case open."
            />
          ) : (
            <CaseDetail key={current.id} c={current} stores={stores} frozen={frozen} cluster={run?.explorerCluster ?? null} now={now} ended={run?.phase === "ended"} />
          )}
        </Panel>

        {/* The oracle's own numbers */}
        <Panel className="flex min-h-0 flex-col overflow-y-auto">
          <MetricsPanel m={metrics} cases={cases} />
        </Panel>
      </div>
    </PageShell>
  );
}

function FilterLabel({ label, n, tone }: { label: string; n: number; tone?: "amber" | "red" }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className={cx("tabular text-2xs", n && tone === "amber" ? "text-amber" : n && tone === "red" ? "text-red" : "text-text-3")}>{n}</span>
    </span>
  );
}

// ---------- list ----------

function statusOf(c: OracleCase, stores: Record<number, StoreState>, frozen: Set<number>): { label: string; tone: "amber" | "red" | "neutral" | "teal" } {
  if (c.status === "dismissed") return { label: "Dismissed", tone: "neutral" };
  if (c.status === "actioned") {
    const suspended = c.subjects.some((s) => s.kind === "merchant" && stores[s.idx]?.status === "suspended");
    const froze = c.subjects.some((s) => s.kind === "resident" && frozen.has(s.idx));
    if (suspended && froze) return { label: "Suspended + frozen", tone: "red" };
    if (suspended) return { label: "Suspended", tone: "red" };
    if (froze) return { label: "Frozen", tone: "red" };
    return { label: "Reinstated", tone: "teal" };
  }
  return { label: c.severity === "high" ? "High" : c.severity === "medium" ? "Medium" : "Low", tone: "amber" };
}

function CaseList({
  cases,
  selected,
  onSelect,
  now,
  stores,
  frozen,
  empty,
}: {
  cases: OracleCase[];
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
  stores: Record<number, StoreState>;
  frozen: Set<number>;
  empty: string | null;
}) {
  const reduce = useReducedMotion() ?? false;
  const selRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  if (!cases.length)
    return (
      <div className="flex flex-1 items-start justify-center p-6 text-center text-xs text-text-3">
        {empty ?? (
          <span className="flex flex-col items-center gap-2">
            <RadarGlyph />
            Watching every price and payment. No cases yet.
          </span>
        )}
      </div>
    );
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
      <AnimatePresence initial={false}>
        {cases.map((c) => {
          const on = c.id === selected;
          const st = statusOf(c, stores, frozen);
          const tone = caseTone(c);
          const subject = c.subjects[0];
          return (
            <motion.li
              key={c.id}
              ref={on ? selRef : undefined}
              layout={reduce ? false : "position"}
              initial={reduce ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="overflow-hidden"
            >
              <button
                onClick={() => onSelect(c.id)}
                className={cx(
                  "group relative flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
                  on ? "bg-surface-3" : "hover:bg-surface-2/70",
                )}
              >
                {on && <motion.span layoutId="case-sel" className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-teal" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
                <span className="flex items-center gap-2">
                  <span
                    className={cx(
                      "size-1.5 shrink-0 rounded-full",
                      tone === "amber" ? (c.severity === "high" ? "bg-amber shadow-[0_0_8px_rgba(245,184,61,0.7)]" : "bg-amber/75") : tone === "red" ? "bg-red shadow-[0_0_8px_rgba(240,97,109,0.6)]" : "bg-text-3",
                    )}
                  />
                  <span className={cx("min-w-0 flex-1 truncate text-[13px]", on ? "text-text" : "text-text/90")}>{c.title}</span>
                  <span className={cx("shrink-0 text-xs tabular", tone === "amber" ? "text-amber" : "text-text-3")}>{c.score.toFixed(2)}</span>
                </span>
                <span className="flex items-center gap-1.5 pl-3.5 text-2xs text-text-3">
                  <span>{KIND_SHORT[c.kind]}</span>
                  {subject && (
                    <>
                      <span className="text-text-3/50">·</span>
                      <span className="min-w-0 truncate">{c.kind === "duplicate_identity" ? `${c.subjects.length} households` : subject.name}</span>
                    </>
                  )}
                  <span className="text-text-3/50">·</span>
                  <span className="shrink-0 tabular">{ago(c.openedAt, now)}</span>
                  <span className="flex-1" />
                  <span
                    className={cx(
                      "shrink-0",
                      st.tone === "amber" ? "text-amber/80" : st.tone === "red" ? "text-red" : st.tone === "teal" ? "text-teal" : "text-text-3",
                    )}
                  >
                    {st.label}
                  </span>
                </span>
              </button>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

// ---------- detail ----------

type Busy = { kind: OracleActionKind; target?: number } | null;

const ACTION_COPY: Record<OracleActionKind, { go: string; doing: string }> = {
  suspend_merchant: { go: "Suspend store on-chain", doing: "Suspending on-chain…" },
  reinstate_merchant: { go: "Reinstate store", doing: "Reinstating…" },
  freeze_wallet: { go: "Freeze wallet on-chain", doing: "Freezing on-chain…" },
  unfreeze_wallet: { go: "Unfreeze wallet", doing: "Unfreezing…" },
  dismiss: { go: "Dismiss", doing: "Dismissing…" },
  reopen: { go: "Reopen", doing: "Reopening…" },
};

function CaseDetail({
  c,
  stores,
  frozen,
  cluster,
  now,
  ended,
}: {
  c: OracleCase;
  stores: Record<number, StoreState>;
  frozen: Set<number>;
  cluster: string | null;
  now: number;
  ended: boolean;
}) {
  const reduce = useReducedMotion() ?? false;
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<OracleCase | null>(null);
  // The route answers with the updated case before the WebSocket echo; show whichever is newer.
  const view = latest && latest.id === c.id && latest.updatedAt > c.updatedAt ? latest : c;

  const merchants = view.subjects.filter((s): s is Extract<SubjectRef, { kind: "merchant" }> => s.kind === "merchant");
  const residents = view.subjects.filter((s): s is Extract<SubjectRef, { kind: "resident" }> => s.kind === "resident");
  const anySuspended = merchants.some((s) => stores[s.idx]?.status === "suspended");
  const allSuspended = merchants.length > 0 && merchants.every((s) => stores[s.idx]?.status === "suspended");
  const anyFrozen = residents.some((s) => frozen.has(s.idx));
  const allFrozen = residents.length > 0 && residents.every((s) => frozen.has(s.idx));

  const act = useCallback(
    async (kind: OracleActionKind, target?: number) => {
      setBusy({ kind, target });
      setError(null);
      try {
        const next = await api("POST /api/oracle/cases/:id/actions", { params: { id: c.id }, body: target === undefined ? { kind } : { kind, target } });
        setLatest(next);
        const failed = next.actions.filter((a) => !a.ok).at(-1);
        if (failed && failed.at >= Date.now() - 30_000 && !next.actions.some((a) => a.ok && a.kind === kind && a.at >= failed.at)) setError(failed.error ?? "The chain refused the action");
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : "Couldn't reach the Rescu server");
      } finally {
        setBusy(null);
      }
    },
    [c.id],
  );

  const wantsSuspend = view.recommended.includes("suspend_merchant") && merchants.length > 0;
  const wantsFreeze = view.recommended.includes("freeze_wallet") && residents.length > 0;
  const tone = caseTone(view);
  const walletWord = residents.length === 1 ? "wallet" : `${residents.length} wallets`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Status strip once acted on */}
      <AnimatePresence initial={false}>
        {(anySuspended || anyFrozen) && (
          <motion.div initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.4, ease: EASE }} className="overflow-hidden">
            <div className="flex items-center gap-3 border-b border-red/25 bg-red-soft px-6 py-3">
              <ShieldX />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-red">
                  {anySuspended && anyFrozen ? "Store suspended and wallets frozen on-chain" : anySuspended ? "Store suspended on-chain" : `${residents.length === 1 ? "Wallet" : "Wallets"} frozen on-chain`}
                </div>
                <div className="text-xs text-red/80">
                  {anySuspended ? "The rule program now refuses every relief payment to this store (MerchantSuspended)." : "Token-2022 now refuses every payment from the frozen account (AccountFrozen)."}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="flex items-start gap-6 px-6 pt-5 pb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone === "neutral" ? "neutral" : tone}>
              <Dot tone={tone} pulse={tone === "amber"} />
              {STATUS_LABEL[view.status]}
            </Badge>
            <Badge>{KIND_LABEL[view.kind]}</Badge>
            <span className="text-2xs text-text-3">
              Opened {simClock(view.simT)} · {ago(view.openedAt, now)}
            </span>
          </div>
          <motion.h1 initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: EASE }} className="mt-2.5 text-[22px] leading-7 font-semibold tracking-tight">
            {view.title}
          </motion.h1>
          <Subjects merchants={merchants} residents={residents} stores={stores} frozen={frozen} />
        </div>
        <ScoreDial score={view.score} severity={view.severity} anomaly={view.anomaly} />
      </header>

      {/* Grok's write-up */}
      <div className="px-6">
        <Summary s={view.summary} />
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        {merchants.length > 0 &&
          (allSuspended ? (
            <ActionButton kind="reinstate_merchant" busy={busy} onClick={() => act("reinstate_merchant")} variant="outline" disabled={ended} />
          ) : (
            <ActionButton kind="suspend_merchant" busy={busy} onClick={() => act("suspend_merchant")} variant={wantsSuspend ? "danger" : "outline"} disabled={ended} />
          ))}
        {residents.length > 0 &&
          (allFrozen ? (
            <ActionButton kind="unfreeze_wallet" label={`Unfreeze ${walletWord}`} busy={busy} onClick={() => act("unfreeze_wallet")} variant="outline" disabled={ended} />
          ) : (
            <ActionButton kind="freeze_wallet" label={`Freeze ${walletWord} on-chain`} busy={busy} onClick={() => act("freeze_wallet")} variant={wantsFreeze ? "danger" : "outline"} disabled={ended} />
          ))}
        <span className="flex-1" />
        {view.status === "dismissed" ? (
          <ActionButton kind="reopen" busy={busy} onClick={() => act("reopen")} variant="ghost" />
        ) : (
          view.status === "open" && <ActionButton kind="dismiss" busy={busy} onClick={() => act("dismiss")} variant="ghost" />
        )}
      </div>
      <AnimatePresence>
        {error && (
          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="px-6 pt-2 text-xs text-red">
            {error}
          </motion.p>
        )}
      </AnimatePresence>
      {view.actions.length > 0 && <ActionLog actions={view.actions} cluster={cluster} now={now} />}

      {/* Evidence */}
      <section className="mt-5 border-t border-line px-6 pt-4 pb-5">
        <h3 className="eyebrow mb-3">Evidence</h3>
        <EvidenceView c={view} />
      </section>

      {/* Why the model thinks it's strange */}
      {view.features.length > 0 && (
        <section className="border-t border-line px-6 pt-4 pb-6">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="eyebrow">Why it stands out</h3>
            <span className="text-2xs text-text-3">How far from a typical {merchants.length && view.kind !== "duplicate_identity" && view.kind !== "velocity" ? "store" : "household"} (robust z-score)</span>
          </div>
          <Features features={view.features} />
        </section>
      )}
    </div>
  );
}

function Subjects({
  merchants,
  residents,
  stores,
  frozen,
}: {
  merchants: Extract<SubjectRef, { kind: "merchant" }>[];
  residents: Extract<SubjectRef, { kind: "resident" }>[];
  stores: Record<number, StoreState>;
  frozen: Set<number>;
}) {
  const shownRes = residents.slice(0, 6);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {merchants.map((m) => {
        const st = stores[m.idx];
        const suspended = st?.status === "suspended";
        return (
          <Link
            key={`m${m.idx}`}
            href={`/merchant?store=${m.idx}`}
            className={cx(
              "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
              suspended ? "border-red/25 bg-red-soft text-red" : "border-line bg-surface-2/60 text-text-2 hover:border-line-strong hover:text-text",
            )}
          >
            <StoreGlyph />
            {m.name}
            <span className="text-text-3">{suspended ? "· suspended" : "↗"}</span>
          </Link>
        );
      })}
      {shownRes.map((r) => {
        const isFrozen = frozen.has(r.idx);
        return (
          <span
            key={`r${r.idx}`}
            className={cx("inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs", isFrozen ? "border-red/25 bg-red-soft text-red" : "border-line bg-surface-2/60 text-text-2")}
          >
            <PersonGlyph />
            {r.name}
            {isFrozen && <span className="text-red/80">· frozen</span>}
          </span>
        );
      })}
      {residents.length > shownRes.length && <span className="text-2xs text-text-3">+{residents.length - shownRes.length} more</span>}
    </div>
  );
}

/** Score as a ring: amber for the oracle's confidence, with the forest's own anomaly score underneath. */
function ScoreDial({ score, severity, anomaly }: { score: number; severity: OracleCase["severity"]; anomaly: number | null }) {
  const reduce = useReducedMotion() ?? false;
  const R = 26;
  const C = 2 * Math.PI * R;
  const s = Math.max(0, Math.min(1, score));
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="text-right">
        <div className="text-2xs text-text-3">Oracle score</div>
        <div className="text-2xs text-amber capitalize">{severity} risk</div>
        <div className="mt-1 text-2xs text-text-3" title="Isolation forest: how easy this subject is to isolate from the rest of the network (0-1)">
          Anomaly {anomaly === null ? "–" : anomaly.toFixed(2)}
        </div>
      </div>
      <svg width="64" height="64" viewBox="0 0 64 64" aria-label={`Score ${score.toFixed(2)}`}>
        <circle cx="32" cy="32" r={R} fill="none" stroke="rgb(154 168 189 / 0.14)" strokeWidth="4" />
        <motion.circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke="#f5b83d"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          transform="rotate(-90 32 32)"
          initial={reduce ? false : { strokeDashoffset: C }}
          animate={{ strokeDashoffset: C * (1 - s) }}
          transition={{ duration: 0.9, ease: EASE }}
        />
        <text x="32" y="37" textAnchor="middle" fontSize="15" fontWeight="600" fill="#e6edf7" style={{ fontVariantNumeric: "tabular-nums" }}>
          {score.toFixed(2)}
        </text>
      </svg>
    </div>
  );
}

function Summary({ s }: { s: OracleCase["summary"] }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <div className="relative overflow-hidden rounded-xl border border-line bg-surface-2/50 px-4 py-3.5">
      <div className="mb-1.5 flex items-center gap-2 text-2xs text-text-3">
        <GrokGlyph />
        {s.status === "ready" ? (
          <span>
            Case summary by Grok <span className="font-mono text-text-3/80">{s.model}</span>
          </span>
        ) : s.status === "pending" ? (
          <span>Grok is writing the case summary…</span>
        ) : (
          <span>Case summary (template: Grok not used for this case)</span>
        )}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {s.text ? (
          <motion.p key="text" initial={reduce ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: EASE }} className="text-sm leading-6 text-text">
            {s.text}
          </motion.p>
        ) : (
          <motion.div key="wait" exit={{ opacity: 0 }} className="space-y-2 py-1">
            {[0.92, 0.78, 0.5].map((w, i) => (
              <div key={i} className="h-3 animate-pulse rounded bg-surface-3/80" style={{ width: `${w * 100}%`, animationDelay: `${i * 120}ms` }} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ActionButton({
  kind,
  label,
  busy,
  onClick,
  variant,
  disabled,
}: {
  kind: OracleActionKind;
  label?: string;
  busy: Busy;
  onClick: () => void;
  variant: "danger" | "outline" | "ghost";
  disabled?: boolean;
}) {
  const mine = busy?.kind === kind;
  const copy = ACTION_COPY[kind];
  return (
    <Button
      size="md"
      variant={variant === "danger" ? "outline" : variant}
      disabled={!!busy || disabled}
      onClick={onClick}
      className={cx(variant === "danger" && "border-red/40 bg-red-soft text-red hover:border-red/70 hover:bg-red/20 hover:text-red", mine && "opacity-100!")}
    >
      {mine ? <Spinner /> : variant === "danger" ? <ShieldGlyph /> : null}
      {mine ? copy.doing : (label ?? copy.go)}
    </Button>
  );
}

function ActionLog({ actions, cluster, now }: { actions: OracleActionRecord[]; cluster: string | null; now: number }) {
  const rows = [...actions].reverse().slice(0, 8);
  return (
    <ul className="mx-6 mt-3 space-y-1 rounded-lg border border-line bg-surface-1/60 px-3 py-2">
      <AnimatePresence initial={false}>
        {rows.map((a) => {
          const href = txHref(a.signature, cluster);
          return (
            <motion.li key={`${a.at}-${a.kind}-${a.target?.idx ?? ""}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="flex items-center gap-2 overflow-hidden text-xs">
              <span className={cx("size-1.5 shrink-0 rounded-full", a.ok ? (a.kind === "suspend_merchant" || a.kind === "freeze_wallet" ? "bg-red" : "bg-teal") : "bg-text-3")} />
              <span className="min-w-0 flex-1 truncate">
                <span className={a.ok ? "text-text-2" : "text-text-3 line-through"}>{actionLine(a)}</span>
                {!a.ok && a.error && <span className="ml-1.5 text-red">({a.error})</span>}
              </span>
              <span className="shrink-0 text-2xs text-text-3 tabular">{ago(a.at, now)}</span>
              {href ? (
                <a href={href} target="_blank" rel="noreferrer" className="shrink-0 text-2xs text-teal/90 hover:text-teal">
                  tx ↗
                </a>
              ) : (
                <span className="w-7 shrink-0" />
              )}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

function actionLine(a: OracleActionRecord): string {
  const who = a.target ? a.target.name : "";
  switch (a.kind) {
    case "suspend_merchant":
      return `Suspended ${who} on-chain`;
    case "reinstate_merchant":
      return `Reinstated ${who}`;
    case "freeze_wallet":
      return `Froze ${who}'s wallet on-chain`;
    case "unfreeze_wallet":
      return `Unfroze ${who}'s wallet`;
    case "dismiss":
      return "Dismissed the case";
    case "reopen":
      return "Reopened the case";
  }
}

function Features({ features }: { features: OracleCase["features"] }) {
  const rows = [...features].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 6);
  const zMax = Math.max(4, ...rows.map((f) => Math.abs(f.z)));
  return (
    <ul className="space-y-2">
      {rows.map((f, i) => {
        // Amber only for "far above typical"; far below reads neutral (it isn't a red flag by itself).
        const hot = f.z >= 3;
        return (
          <li key={f.name} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_52px] items-center gap-3 text-xs">
            <span className="truncate text-text-2" title={f.label}>
              {f.label}
            </span>
            <span className="relative h-1.5 overflow-hidden rounded-full bg-surface-3">
              <motion.span
                className={cx("absolute inset-y-0 left-0 rounded-full", hot ? "bg-amber" : "bg-text-3/60")}
                initial={{ width: 0 }}
                animate={{ width: `${(100 * Math.min(Math.abs(f.z), zMax)) / zMax}%` }}
                transition={{ delay: i * 0.05, duration: 0.7, ease: EASE }}
              />
            </span>
            <span className={cx("text-right tabular", hot ? "text-amber" : "text-text-3")}>{f.z >= 0 ? "+" : "−"}{Math.abs(f.z).toFixed(1)}σ</span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- metrics ----------

function MetricsPanel({ m, cases }: { m: OracleMetrics | null; cases: OracleCase[] }) {
  const planted = m?.planted.filter((p) => p.total > 0) ?? [];
  const actedOn = cases.filter((c) => c.status === "actioned").length;
  return (
    <div className="flex flex-col">
      <section className="px-4 pt-4 pb-3.5">
        <h3 className="eyebrow mb-2.5">How well it's catching them</h3>
        <div className="grid grid-cols-2 gap-3">
          <BigNum label="Precision" value={pct(m?.precision)} sub="cases that were real" tone="teal" />
          <BigNum label="Recall" value={pct(m?.recall)} sub="bad actors caught" tone="teal" />
        </div>
        <p className="mt-2.5 text-2xs leading-4 text-text-3">Scored against the bad actors planted in the simulation (the oracle never sees that list).</p>
      </section>
      <div className="h-px bg-line" />
      <section className="px-4 py-3.5">
        <h3 className="eyebrow mb-2.5">Planted bad actors caught</h3>
        {planted.length ? (
          <ul className="space-y-2">
            {planted.map((p) => (
              <li key={p.kind} className="grid grid-cols-[92px_minmax(0,1fr)_40px] items-center gap-2.5 text-xs">
                <span className="text-text-2">{KIND_SHORT[p.kind]}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <motion.span className="block h-full rounded-full bg-teal" initial={{ width: 0 }} animate={{ width: `${(100 * p.caught) / Math.max(1, p.total)}%` }} transition={{ duration: 0.8, ease: EASE }} />
                </span>
                <span className="text-right tabular text-text">
                  {p.caught}/{p.total}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-2xs text-text-3">None have acted yet. Gougers raise prices once the storm reaches their store.</p>
        )}
      </section>
      <div className="h-px bg-line" />
      <section className="px-4 py-3.5">
        <h3 className="eyebrow mb-2.5">Cases</h3>
        <ul className="space-y-1.5">
          {(m?.cases ?? KINDS.map((kind) => ({ kind, open: 0, actioned: 0, dismissed: 0 }))).map((k) => (
            <li key={k.kind} className="flex items-center gap-2 text-xs">
              <span className="flex-1 text-text-2">{KIND_LABEL[k.kind]}</span>
              <span className={cx("w-8 text-right tabular", k.open ? "text-amber" : "text-text-3")}>{k.open}</span>
              <span className={cx("w-8 text-right tabular", k.actioned ? "text-red" : "text-text-3")}>{k.actioned}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 pt-0.5 text-2xs text-text-3">
            <span className="flex-1" />
            <span className="w-8 text-right">open</span>
            <span className="w-8 text-right">acted</span>
          </li>
        </ul>
        {actedOn > 0 && <p className="mt-2 text-2xs text-text-3">{actedOn} acted on with an on-chain transaction signed by the oracle key.</p>}
      </section>
      <div className="h-px bg-line" />
      <section className="px-4 py-3.5">
        <h3 className="eyebrow mb-2.5">Model</h3>
        {m?.model ? (
          <dl className="space-y-1.5 text-xs">
            <Row k="Method" v={`Rules + ${m.model.name.toLowerCase()}`} />
            <Row k="Trees" v={`${m.model.trees} × ${m.model.sampleSize} samples`} />
            <Row k="Trained on" v={`${m.model.trainedOn.toLocaleString("en-US")} rows`} />
            <Row k="Gouging line" v={`+${m.thresholds.gougePct}% over pre-storm median`} />
            <Row k="Opens a case at" v={`score ≥ ${m.thresholds.scoreToOpen.toFixed(2)}`} />
            <Row k="Scans" v={`${m.scans.toLocaleString("en-US")} · ${m.lastScanMs} ms each`} />
          </dl>
        ) : (
          <p className="text-2xs text-text-3">Fits once the network has activity.</p>
        )}
      </section>
      <div className="h-px bg-line" />
      <section className="px-4 py-3.5">
        <h3 className="eyebrow mb-2.5">Grok write-ups</h3>
        {m ? (
          <dl className="space-y-1.5 text-xs">
            <Row k="This run" v={`${m.grok.summaries} · $${m.grok.usd.toFixed(4)}`} />
            <Row k="Per summary" v={m.grok.summaries ? `$${(m.grok.usd / m.grok.summaries).toFixed(4)}` : "–"} />
            <Row k="Budget used" v={`$${m.grok.spentUsd.toFixed(2)} of $${m.grok.limitUsd.toFixed(0)}`} />
          </dl>
        ) : (
          <p className="text-2xs text-text-3">–</p>
        )}
      </section>
    </div>
  );
}

function BigNum({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "teal" }) {
  return (
    <div>
      <div className="text-xs text-text-3">{label}</div>
      <div className={cx("text-[26px] leading-8 font-semibold tracking-tight tabular", tone === "teal" ? "text-teal" : "text-text")}>{value}</div>
      <div className="text-2xs text-text-3">{sub}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-text-3">{k}</dt>
      <dd className="truncate text-right tabular text-text-2">{v}</dd>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-8 text-center">
      <div className="text-sm font-medium text-text">{title}</div>
      <div className="max-w-sm text-xs leading-5 text-text-3">{body}</div>
    </div>
  );
}

// ---------- glyphs ----------

function RadarGlyph() {
  return (
    <span className="relative inline-grid size-4 place-items-center">
      <span className="absolute inset-0 animate-ping rounded-full bg-amber/25 [animation-duration:2.4s]" />
      <span className="relative size-1.5 rounded-full bg-amber" />
    </span>
  );
}

function Spinner() {
  return <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden />;
}

function ShieldX() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="shrink-0 text-red">
      <path d="M10 2 3.5 4.5v5c0 4 2.8 7 6.5 8.5 3.7-1.5 6.5-4.5 6.5-8.5v-5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m7.5 7.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ShieldGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden>
      <path d="M10 2 3.5 4.5v5c0 4 2.8 7 6.5 8.5 3.7-1.5 6.5-4.5 6.5-8.5v-5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function StoreGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      <path d="M2 5.5 3 2h8l1 3.5M2.5 5.5V12h9V5.5M2 5.5h10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function PersonGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="4.5" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 12.5c.6-2.4 2.3-3.6 4.5-3.6s3.9 1.2 4.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function GrokGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden className="text-teal">
      <path d="M7 1.5 8.4 5.6 12.5 7 8.4 8.4 7 12.5 5.6 8.4 1.5 7l4.1-1.4z" fill="currentColor" />
    </svg>
  );
}
