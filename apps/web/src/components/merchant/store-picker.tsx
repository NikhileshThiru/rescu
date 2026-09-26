"use client";

import type { MerchantCategory, StoreState, StoreSummary } from "@rescu/live";
import { motion } from "motion/react";
import { memo, useDeferredValue, useMemo, useState } from "react";
import { cx, Dot } from "../ui/primitives";
import { CATEGORY_LABEL } from "./money";

type Filter = "all" | MerchantCategory;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "grocery", label: "Grocery" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "hardware", label: "Hardware" },
  { value: "general", label: "General" },
];

export function storeTone(status: StoreSummary["status"], flagged: boolean): "teal" | "amber" | "red" | "neutral" {
  if (status === "suspended") return "red";
  if (flagged) return "amber";
  if (status === "pending") return "neutral";
  return "teal";
}

/** Search + category chips + every store in the run, suspended and flagged ones marked. */
export function StorePicker({
  stores,
  states,
  selected,
  onSelect,
}: {
  stores: StoreSummary[] | null;
  states: Record<number, StoreState>;
  selected: number | null;
  onSelect: (idx: number) => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Filter>("all");
  const query = useDeferredValue(q.trim().toLowerCase());
  const list = useMemo(() => {
    if (!stores) return [];
    return stores.filter((s) => (cat === "all" || s.category === cat) && (!query || s.name.toLowerCase().includes(query) || s.county.toLowerCase().includes(query)));
  }, [stores, cat, query]);
  const counts = useMemo(() => {
    let flagged = 0;
    let suspended = 0;
    for (const s of stores ?? []) {
      const st = states[s.idx];
      if ((st?.status ?? s.status) === "suspended") suspended++;
      else if (st ? st.flagged : s.flagged) flagged++;
    }
    return { flagged, suspended };
  }, [stores, states]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2.5 px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between">
          <h2 className="eyebrow">Stores</h2>
          <span className="text-2xs tabular text-text-3">
            {stores ? `${stores.length} in the network` : "Loading"}
            {counts.flagged ? <span className="text-amber"> · {counts.flagged} flagged</span> : null}
            {counts.suspended ? <span className="text-red"> · {counts.suspended} suspended</span> : null}
          </span>
        </div>
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface-1/80 px-2.5 focus-within:border-line-strong">
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden className="shrink-0 text-text-3">
            <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="m9.2 9.2 3.3 3.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search stores or counties"
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-3"
            aria-label="Search stores"
          />
        </label>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Store type">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              role="radio"
              aria-checked={cat === f.value}
              onClick={() => setCat(f.value)}
              className={cx(
                "h-6 rounded-full border px-2.5 text-2xs font-medium transition-colors duration-150",
                cat === f.value ? "border-line-strong bg-surface-3 text-text" : "border-line text-text-3 hover:border-line-strong hover:text-text-2",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 [scrollbar-width:thin]">
        {stores && !list.length && <p className="px-3 py-6 text-center text-xs text-text-3">No stores match.</p>}
        {!stores && (
          <div className="space-y-1.5 px-2 pt-1">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-surface-2/60" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        )}
        <ul>
          {list.map((s) => (
            <StoreRow key={s.idx} store={s} state={states[s.idx]} active={s.idx === selected} onSelect={onSelect} />
          ))}
        </ul>
      </div>
    </div>
  );
}

const StoreRow = memo(function StoreRow({ store: s, state, active, onSelect }: { store: StoreSummary; state?: StoreState; active: boolean; onSelect: (idx: number) => void }) {
  const status = state?.status ?? s.status;
  const flagged = state ? state.flagged : s.flagged;
  const tone = storeTone(status, flagged);
  return (
    <li>
      <button
        onClick={() => onSelect(s.idx)}
        className={cx("relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors", active ? "text-text" : "text-text-2 hover:bg-surface-2/70")}
      >
        {active && <motion.span layoutId="store-active" className="absolute inset-0 -z-0 rounded-lg border border-line-strong bg-surface-3" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
        <span className="relative">
          <Dot tone={tone} pulse={tone === "amber"} />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{s.name}</span>
          <span className="block truncate text-2xs text-text-3">
            {CATEGORY_LABEL[s.category]} · {s.county}
          </span>
        </span>
        <span className="relative shrink-0 text-2xs">
          {status === "suspended" ? (
            <span className="text-red">Suspended</span>
          ) : flagged ? (
            <span className="text-amber">Flagged</span>
          ) : !s.open ? (
            <span className="text-text-3">Closed</span>
          ) : null}
        </span>
      </button>
    </li>
  );
});
