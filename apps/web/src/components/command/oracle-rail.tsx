"use client";

import type { CaseKind, OracleCase, Severity, StoreState } from "@rescu/live";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { int } from "@/lib/format";
import { type LiveClient, type LiveState, useLive } from "@/lib/live";
import { cx } from "../ui/primitives";

export const KIND_LABEL: Record<CaseKind, string> = {
  gouging: "Price gouging",
  duplicate_identity: "Duplicate identity",
  velocity: "Rapid spending",
  collusion: "Collusion",
};

/** Open cases are amber (flagged), stronger with severity; red once the oracle acted on-chain. */
const SEVERITY_DOT: Record<Severity, string> = {
  high: "bg-amber shadow-[0_0_8px_rgba(245,184,61,0.7)]",
  medium: "bg-amber/80",
  low: "bg-amber/45",
};
const SEVERITY_BAR: Record<Severity, string> = { high: "bg-amber", medium: "bg-amber/75", low: "bg-amber/45" };

const EASE = [0.16, 1, 0.3, 1] as const;

/** Wallets whose latest oracle action is a successful freeze. */
export function frozenWallets(cases: OracleCase[]): number {
  const latest = new Map<number, { at: number; frozen: boolean }>();
  for (const c of cases) {
    for (const a of c.actions) {
      if (!a.ok || a.target?.kind !== "resident") continue;
      if (a.kind !== "freeze_wallet" && a.kind !== "unfreeze_wallet") continue;
      const prev = latest.get(a.target.idx);
      if (!prev || prev.at <= a.at) latest.set(a.target.idx, { at: a.at, frozen: a.kind === "freeze_wallet" });
    }
  }
  let n = 0;
  for (const v of latest.values()) if (v.frozen) n++;
  return n;
}

export function suspendedStores(stores: Record<number, StoreState>): number {
  let n = 0;
  for (const s of Object.values(stores)) if (s.status === "suspended") n++;
  return n;
}

/** Stable selector: primitive counts only, so the rail re-renders when a count changes. */
const selSuspended = (s: LiveState) => suspendedStores(s.stores);
const selCases = (s: LiveState) => s.cases;

function caseStatus(c: OracleCase): { label: string; cls: string; dot: string; bar: string } {
  const red = { dot: "bg-red shadow-[0_0_8px_rgba(240,97,109,0.7)]", bar: "bg-red" };
  const quiet = { dot: "bg-text-3", bar: "bg-text-3/60" };
  if (c.status === "dismissed") return { label: "Dismissed", cls: "text-text-3", ...quiet };
  if (c.status === "actioned") {
    const last = [...c.actions].reverse().find((a) => a.ok);
    if (last?.kind === "suspend_merchant") return { label: "Suspended", cls: "text-red", ...red };
    if (last?.kind === "freeze_wallet") return { label: "Frozen", cls: "text-red", ...red };
    if (last?.kind === "reinstate_merchant") return { label: "Reinstated", cls: "text-teal", ...quiet };
    if (last?.kind === "unfreeze_wallet") return { label: "Thawed", cls: "text-teal", ...quiet };
    return { label: "Actioned", cls: "text-text-2", ...quiet };
  }
  return { label: "Open", cls: "text-amber", dot: SEVERITY_DOT[c.severity], bar: SEVERITY_BAR[c.severity] };
}

/**
 * The oracle in the Command Center rail: open cases by kind, the latest three (each opens on
 * /oracle), and how many stores it suspended and wallets it froze on-chain.
 */
export function OracleBlock({ live, stores }: { live: LiveClient; stores: number }) {
  const cases = useLive(live, selCases);
  const suspended = useLive(live, selSuspended);
  const reduce = useReducedMotion() ?? false;
  const frozen = frozenWallets(cases);
  const open = cases.filter((c) => c.status === "open");
  const byKind = (Object.keys(KIND_LABEL) as CaseKind[])
    .map((k) => ({ kind: k, n: open.filter((c) => c.kind === k).length }))
    .filter((k) => k.n > 0);
  const latest = cases.slice(0, 3);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs text-text-3">
          <RadarGlyph active={!reduce} />
          Oracle
        </span>
        <Link href="/oracle" className="text-2xs text-text-3 transition-colors hover:text-teal">
          {cases.length ? `${int(open.length)} open of ${int(cases.length)}` : "Cases"} →
        </Link>
      </div>

      {!cases.length && suspended === 0 ? (
        <p className="text-2xs leading-relaxed text-text-3">
          Watching every price and payment at {int(stores)} stores. No cases yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {byKind.map((k) => (
              <span
                key={k.kind}
                className="inline-flex items-center gap-1.5 rounded-md border border-amber/20 bg-amber-soft px-1.5 py-0.5 text-2xs text-amber"
              >
                {KIND_LABEL[k.kind]} <span className="tabular text-amber/70">{k.n}</span>
              </span>
            ))}
            {suspended > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-red/20 bg-red-soft px-1.5 py-0.5 text-2xs text-red">
                {`${int(suspended)} ${suspended === 1 ? "store" : "stores"} suspended`}
              </span>
            )}
            {frozen > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-red/20 bg-red-soft px-1.5 py-0.5 text-2xs text-red">
                {`${int(frozen)} ${frozen === 1 ? "wallet" : "wallets"} frozen`}
              </span>
            )}
          </div>
          <ul className="-mx-1.5 mt-1.5">
            <AnimatePresence initial={false}>
              {latest.map((c) => {
                const st = caseStatus(c);
                return (
                  <motion.li
                    key={c.id}
                    layout={reduce ? false : "position"}
                    initial={reduce ? false : { opacity: 0, y: -8, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: "auto" }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                    transition={{ duration: 0.4, ease: EASE }}
                    className="overflow-hidden"
                  >
                    <Link
                      href={`/oracle?case=${encodeURIComponent(c.id)}`}
                      title={`${KIND_LABEL[c.kind]} · score ${c.score.toFixed(2)} · open on the Oracle page`}
                      className="group relative flex h-7 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-surface-3/60"
                    >
                      <span className={cx("size-1.5 shrink-0 rounded-full", st.dot)} />
                      <span className="min-w-0 flex-1 truncate text-xs text-text">{c.title}</span>
                      <span className="shrink-0 text-2xs text-text-3 tabular group-hover:text-teal">{c.score.toFixed(2)}</span>
                      <span className={cx("w-[62px] shrink-0 text-right text-2xs", st.cls)}>{st.label}</span>
                      {/* Anomaly score as a hairline under the row. */}
                      <span className="absolute bottom-0 left-5 right-1.5 h-px overflow-hidden bg-surface-3/70">
                        <motion.span
                          className={cx("block h-full", st.bar)}
                          initial={reduce ? false : { width: 0 }}
                          animate={{ width: `${Math.round(Math.max(0.04, Math.min(1, c.score)) * 100)}%` }}
                          transition={{ duration: 0.8, ease: EASE }}
                        />
                      </span>
                    </Link>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </>
      )}
    </div>
  );
}

function RadarGlyph({ active }: { active: boolean }) {
  return (
    <span className="relative inline-grid size-3 place-items-center">
      {active && <span className="absolute inset-0 animate-ping rounded-full bg-amber/30 [animation-duration:2.4s]" />}
      <span className="relative size-1.5 rounded-full bg-amber" />
    </span>
  );
}
