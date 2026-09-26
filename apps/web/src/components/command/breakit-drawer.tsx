"use client";

import {
  BREAK_CASES,
  type BreakCase,
  type BreakCaseId,
  type BreakGroup,
  type BreakitState,
  type BreakResult,
  explorerTx,
} from "@rescu/live";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { ruleLabel } from "@/lib/format";
import type { LiveClient } from "@/lib/live";
import { useLive } from "@/lib/live";
import { NumberTicker } from "../ui/number-ticker";
import { Button, cx, Kbd } from "../ui/primitives";

const GROUPS: { id: BreakGroup; label: string; blurb: string }[] = [
  { id: "rules", label: "Spending rules", blurb: "Enforced by the transfer hook on every payment" },
  { id: "oracle", label: "Oracle", blurb: "Stores and wallets the watchdog shut off" },
  { id: "ai", label: "AI shopper", blurb: "Grok can only spend what the resident allowed" },
  { id: "attacks", label: "Attacks", blurb: "Going around the rules themselves" },
];

const EASE = [0.16, 1, 0.3, 1] as const;
const POLL_MS = 2500;

type RowState = "idle" | "pending" | "blocked" | "landed" | "leak" | "error";

function rowState(c: BreakCase, r: BreakResult | undefined, pending: boolean, error: string | undefined): RowState {
  if (pending) return "pending";
  if (error) return "error";
  if (!r) return "idle";
  if (r.landed) return c.expect === null ? "landed" : "leak";
  return "blocked";
}

/**
 * "Try to break it": a slide-over listing every attack we fire at the program on our validator.
 * Each run is a real transaction in a sandbox declaration; the chain's rejection (rule, copy,
 * latency, transaction link, log lines) comes back from the server and animates into the row.
 */
export function BreakitDrawer({ open, onClose, live }: { open: boolean; onClose: () => void; live: LiveClient }) {
  const reduce = useReducedMotion() ?? false;
  const link = useLive(live, (s) => s.link);
  const rules = useLive(live, (s) => s.run?.rules ?? null);
  const [state, setState] = useState<BreakitState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<BreakCaseId, BreakResult>>>({});
  const [pending, setPending] = useState<Set<BreakCaseId>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<BreakCaseId, string>>>({});
  const [runningAll, setRunningAll] = useState(false);
  const stopAll = useRef(false);
  const rowRefs = useRef(new Map<BreakCaseId, HTMLLIElement>());

  const load = useCallback(async () => {
    try {
      const s = await api("GET /api/breakit");
      setState(s);
      setLoadError(null);
      // Results from earlier runs this server session (another tab, or before a reload).
      setResults((prev) => {
        const next = { ...prev };
        for (const r of s.results) if (!next[r.id] || next[r.id]!.at < r.at) next[r.id] = r;
        return next;
      });
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  // Fetch on open; keep polling while the sandbox is still being set up (or unreachable).
  useEffect(() => {
    if (!open) return;
    void load();
    const id = setInterval(() => {
      if (!state?.ready || loadError) void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [open, load, state?.ready, loadError]);

  // Reconnected to the server: refresh.
  useEffect(() => {
    if (open && link === "open") void load();
  }, [link, open, load]);

  const cases = state?.cases?.length ? state.cases : BREAK_CASES;
  const attacks = cases.filter((c) => c.expect !== null);
  const stopped = attacks.filter((c) => results[c.id] && !results[c.id]!.landed).length;
  const presenter = useLive(live, (s) => s.presenter);
  // Viewers see the attacks and their results; only the presenter fires them.
  const ready = !!state?.ready && presenter;

  const run = useCallback(
    async (id: BreakCaseId) => {
      setPending((p) => new Set(p).add(id));
      setErrors((e) => ({ ...e, [id]: undefined }));
      try {
        const r = await api("POST /api/breakit/:id", { params: { id } });
        setResults((prev) => ({ ...prev, [id]: r }));
      } catch (e) {
        setErrors((prev) => ({ ...prev, [id]: (e as Error).message }));
      } finally {
        setPending((p) => {
          const n = new Set(p);
          n.delete(id);
          return n;
        });
      }
    },
    [],
  );

  const runAll = useCallback(async () => {
    if (runningAll) {
      stopAll.current = true;
      return;
    }
    stopAll.current = false;
    setRunningAll(true);
    // Clear the board so every row visibly goes pending -> result.
    setResults({});
    setErrors({});
    const order = GROUPS.flatMap((g) => cases.filter((c) => c.group === g.id));
    for (const c of order) {
      if (stopAll.current) break;
      rowRefs.current.get(c.id)?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
      await run(c.id);
      await new Promise((r) => setTimeout(r, reduce ? 0 : 160));
    }
    setRunningAll(false);
  }, [runningAll, cases, run, reduce]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const cluster = state?.explorerCluster ?? "";

  return (
    <motion.aside
      initial={false}
      animate={open ? { x: 0, opacity: 1 } : { x: "calc(100% + 24px)", opacity: 0 }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 40, mass: 0.9 }}
      className="pointer-events-auto absolute bottom-4 right-4 top-[72px] z-30 w-[440px]"
      aria-hidden={!open}
      inert={!open}
      aria-label="Try to break it"
    >
      <div className="flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line-strong bg-surface-1 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)]">
        <header className="border-b border-line px-5 pb-4 pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldIcon className="text-red" />
              <h2 className="eyebrow text-text-2">Try to break it</h2>
            </div>
            <div className="flex items-center gap-1.5">
              <Kbd>Esc</Kbd>
              <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose} className="size-7">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-text-3">
            Each button sends a real attack to our program on Solana, in a sandbox so the live numbers stay clean. The chain itself says
            no.
            {!presenter && state?.ready && <span className="text-text-2"> The presenter fires them during the demo.</span>}
          </p>
          <div className="mt-4 flex items-end justify-between gap-4">
            <div>
              <div className="flex items-baseline gap-1.5 font-semibold tracking-tight">
                <NumberTicker value={stopped} format={(x) => String(Math.round(x))} className="text-[28px] leading-8 text-text" duration={0.5} />
                <span className="text-lg text-text-3 tabular">of {attacks.length}</span>
              </div>
              <div className="mt-0.5 text-xs text-text-3">attacks stopped on-chain</div>
            </div>
            <Button
              variant={runningAll ? "outline" : "solid"}
              size="sm"
              className={cx("h-8 min-w-[104px]", !runningAll && "shadow-[0_0_24px_-8px_rgba(45,212,191,0.7)]")}
              disabled={!ready && !runningAll}
              onClick={() => void runAll()}
            >
              {runningAll ? (
                <>
                  <Spinner /> Stop
                </>
              ) : (
                <>
                  <PlayGlyph /> Run all
                </>
              )}
            </Button>
          </div>
          <Ticks cases={attacks} results={results} pending={pending} />
          <AnimatePresence initial={false}>
            {(!ready || loadError) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="overflow-hidden"
              >
                <div
                  className={cx(
                    "mt-3 flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
                    loadError ? "border-red/20 bg-red-soft text-red" : "border-amber/20 bg-amber-soft text-amber",
                  )}
                >
                  {!loadError && <Spinner />}
                  <span className="min-w-0 flex-1">
                    {loadError ? `Can't reach the sandbox: ${loadError}` : (state?.status ?? "Connecting to the sandbox…")}
                  </span>
                  {loadError && (
                    <button type="button" className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={() => void load()}>
                      Retry
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-width:thin]">
          {GROUPS.map((g) => {
            const list = cases.filter((c) => c.group === g.id);
            if (!list.length) return null;
            return (
              <section key={g.id} className="pt-4">
                <div className="flex items-baseline justify-between px-2 pb-1.5">
                  <h3 className="eyebrow">{g.label}</h3>
                  <span className="text-2xs text-text-3">{g.blurb}</span>
                </div>
                <ul className="space-y-1">
                  {list.map((c) => (
                    <CaseRow
                      key={c.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(c.id, el);
                        else rowRefs.current.delete(c.id);
                      }}
                      c={c}
                      result={results[c.id]}
                      state={rowState(c, results[c.id], pending.has(c.id), errors[c.id])}
                      error={errors[c.id]}
                      ready={ready}
                      busy={runningAll}
                      cluster={cluster}
                      rules={rules}
                      onRun={() => void run(c.id)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </motion.aside>
  );
}

/** One tick per attack: red once the chain stopped it. */
function Ticks({
  cases,
  results,
  pending,
}: {
  cases: BreakCase[];
  results: Partial<Record<BreakCaseId, BreakResult>>;
  pending: Set<BreakCaseId>;
}) {
  return (
    <div className="mt-3 flex gap-1">
      {cases.map((c) => {
        const r = results[c.id];
        const tone = pending.has(c.id) ? "bg-text-3/50" : !r ? "bg-surface-3" : r.landed ? "bg-amber" : "bg-red";
        return (
          <motion.span
            key={c.id}
            className={cx("h-1 flex-1 rounded-full transition-colors duration-300", tone)}
            animate={pending.has(c.id) ? { opacity: [0.4, 1, 0.4] } : { opacity: 1 }}
            transition={pending.has(c.id) ? { duration: 0.9, repeat: Number.POSITIVE_INFINITY } : { duration: 0.2 }}
            title={c.title}
          />
        );
      })}
    </div>
  );
}

function CaseRow({
  ref,
  c,
  result: r,
  state,
  error,
  ready,
  busy,
  cluster,
  rules,
  onRun,
}: {
  ref: (el: HTMLLIElement | null) => void;
  c: BreakCase;
  result: BreakResult | undefined;
  state: RowState;
  error: string | undefined;
  ready: boolean;
  busy: boolean;
  cluster: string;
  rules: { perOrderCapUsd: number; dailyCapUsd: number } | null;
  onRun: () => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const done = state === "blocked" || state === "landed" || state === "leak";
  return (
    <li
      ref={ref}
      className={cx(
        "rounded-xl border px-2.5 py-2.5 transition-colors duration-300",
        state === "blocked" ? "border-red/15 bg-red/[0.035]" : state === "landed" ? "border-teal/15 bg-teal/[0.035]" : "border-transparent",
        state === "pending" && "border-line bg-surface-2/60",
      )}
    >
      <div className="flex items-start gap-2.5">
        <StatusIcon state={state} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[13px] font-medium leading-5 text-text">{c.title}</div>
              <p className="mt-0.5 text-2xs leading-4 text-text-3">{c.attack}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-0.5 h-6 shrink-0 px-2 text-2xs"
              disabled={!ready || busy || state === "pending"}
              onClick={onRun}
            >
              {done ? "Again" : "Run"}
            </Button>
          </div>
          <div className={cx("mt-1.5 flex-wrap items-center gap-1.5", done ? "hidden" : "flex")}>
            {c.expect ? (
              <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-px text-2xs text-text-2">
                <span className="text-text-3">Expect</span> {ruleLabel(c.expect, rules)}
                <span className="font-mono text-[10px] text-text-3">{c.expect}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md border border-teal/20 bg-teal-soft px-1.5 py-px text-2xs text-teal">
                Control · should land
              </span>
            )}
          </div>

          <AnimatePresence initial={false}>
            {(done || state === "error") && (
              <motion.div
                key={r?.at ?? error}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.35, ease: EASE }}
                className="overflow-hidden"
              >
                {state === "error" ? (
                  <div className="mt-2 rounded-lg border border-amber/20 bg-amber-soft px-2.5 py-1.5 text-2xs text-amber">{error}</div>
                ) : r ? (
                  <Outcome r={r} state={state} cluster={cluster} rules={rules} logOpen={logOpen} onLog={() => setLogOpen((o) => !o)} />
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </li>
  );
}

function Outcome({
  r,
  state,
  cluster,
  rules,
  logOpen,
  onLog,
}: {
  r: BreakResult;
  state: RowState;
  cluster: string;
  rules: { perOrderCapUsd: number; dailyCapUsd: number } | null;
  logOpen: boolean;
  onLog: () => void;
}) {
  const blocked = state === "blocked";
  const tone = blocked ? "text-red" : state === "landed" ? "text-teal" : "text-amber";
  const box = blocked ? "border-red/25 bg-red-soft" : state === "landed" ? "border-teal/20 bg-teal-soft" : "border-amber/25 bg-amber-soft";
  return (
    <div className={cx("mt-2 rounded-lg border px-2.5 py-2", box)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={cx("text-xs font-medium", tone)}>
          {blocked
            ? `Blocked by the chain · ${r.rule ? ruleLabel(r.rule, rules) : "rejected"}`
            : state === "landed"
              ? "Landed on-chain"
              : "Landed: this should have been stopped"}
        </span>
        <span className="shrink-0 text-2xs text-text-3 tabular">{r.latencyMs.toLocaleString("en-US")} ms</span>
      </div>
      {r.message && <p className="mt-1 text-2xs leading-4 text-text-2">{r.message}</p>}
      <div className="mt-1.5 flex items-center gap-3 text-2xs">
        {r.signature && (
          <a
            href={explorerTx(r.signature, cluster)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-text-3 transition-colors hover:text-teal"
          >
            <span className="font-mono">
              {r.signature.slice(0, 6)}…{r.signature.slice(-4)}
            </span>{" "}
            ↗
          </a>
        )}
        {r.rule && <span className="font-mono text-[10px] text-text-3">{r.rule}</span>}
        {r.logs.length > 0 && (
          <button type="button" onClick={onLog} className="ml-auto inline-flex items-center gap-1 text-text-3 transition-colors hover:text-text-2">
            <motion.svg width="8" height="8" viewBox="0 0 8 8" animate={{ rotate: logOpen ? 90 : 0 }} aria-hidden>
              <path d="M2.5 1.5 5.5 4l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </motion.svg>
            Program log
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {logOpen && r.logs.length > 0 && (
          <motion.pre
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="mt-1.5 overflow-hidden whitespace-pre-wrap break-all rounded-md border border-line bg-bg/70 px-2 py-1.5 font-mono text-[10px] leading-4 text-text-2"
          >
            {r.logs.map((l, i) => (
              <div key={i} className={r.rule && l.includes(r.rule) ? "text-red" : undefined}>
                {l}
              </div>
            ))}
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusIcon({ state }: { state: RowState }) {
  return (
    <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={state === "error" ? "idle" : state}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.2, ease: EASE }}
          className="grid place-items-center"
        >
          {state === "pending" ? (
            <Spinner className="size-4 text-teal" />
          ) : state === "blocked" ? (
            <span className="grid size-5 place-items-center rounded-full bg-red/15 text-red shadow-[0_0_12px_-2px_rgba(240,97,109,0.6)]">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2.6 2.6l4.8 4.8M7.4 2.6 2.6 7.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
          ) : state === "landed" ? (
            <span className="grid size-5 place-items-center rounded-full bg-teal/15 text-teal">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M2.2 5.2 4.2 7.2 7.9 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          ) : state === "leak" ? (
            <span className="grid size-5 place-items-center rounded-full bg-amber/15 text-[11px] font-bold text-amber">!</span>
          ) : (
            <span className="size-3.5 rounded-full border border-line-strong" />
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent", className)} />;
}

function PlayGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M2.5 1.6v6.8a.5.5 0 0 0 .76.43l5.4-3.4a.5.5 0 0 0 0-.86L3.26 1.17a.5.5 0 0 0-.76.43z" fill="currentColor" />
    </svg>
  );
}

export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={className} aria-hidden>
      <path
        d="M7 1.3 2.3 3v3.6c0 3 2 5.2 4.7 6.1 2.7-.9 4.7-3.1 4.7-6.1V3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M5 7.1 6.4 8.5 9.1 5.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
