"use client";

import { DEFAULT_ALLOCATION } from "@rescu/aid-model";
import { useSyncExternalStore } from "react";
import type { SimClock } from "@/lib/clock";
import { category, int, mph, relative, usd, usdCompact } from "@/lib/format";
import type { StormFile } from "@/lib/storm-data";
import { Badge } from "../ui/primitives";
import type { HoverStore } from "./command-center";

const HAZARD_LABEL: Record<string, string> = { wind: "Wind", rain: "Rain flooding", surge: "Storm surge" };
const MIN_NEED_PCT = DEFAULT_ALLOCATION.minNeed * 100;

export function HexTooltip({ store, file, clock }: { store: HoverStore; file: StormFile; clock: SimClock }) {
  const hover = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!hover) return null;
  const { field, index: i } = hover;
  const c = field.cols;
  const county = c.county[i]! >= 0 ? file.counties[c.county[i]!] : null;
  const hazard = file.hazards[c.hazard[i]!] ?? "none";
  const aid = c.aid[i]!;
  const eligible = c.eligible[i]!;
  const windSoFar = field.windNow[i]!;
  const landsIn = field.aidAt[i]! - clock.t;
  const width = 256;
  const maxLeft = window.innerWidth - 392 - width;
  const left = hover.x + 16 > maxLeft ? hover.x - width - 16 : hover.x + 16;

  return (
    <div
      className="glass pointer-events-none absolute z-30 w-64 rounded-xl border border-line-strong p-3 shadow-[var(--shadow-panel)]"
      style={{ left, top: Math.max(64, hover.y - 20) }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{county ? county.name : "Open water"}</div>
          {county && <div className="text-2xs text-text-3">{county.state} · {county.declared ? "Declared by Rescu" : "Not declared"}</div>}
        </div>
        {aid > 0 && <Badge tone="teal">{HAZARD_LABEL[hazard] ?? "Aid"}</Badge>}
      </div>
      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <Row k="Peak wind" v={`${mph(c.kt[i]!)} mph`} sub={category(c.kt[i]!).short} />
        <Row k="So far" v={windSoFar > 20 ? `${mph(windSoFar)} mph` : "Calm"} />
        {c.households[i]! > 0 && (
          <>
            <Row k="Rain" v={`${c.rainIn[i]!.toFixed(1)} in`} />
            <Row k="Households" v={int(c.households[i]!)} />
            <Row k="Need help" v={`${c.needPct[i]!.toFixed(1)}%`} sub="expected" />
            <Row k="Vulnerability" v={c.svi[i]!.toFixed(2)} sub="SVI" />
          </>
        )}
      </dl>
      {aid === 0 && c.households[i]! > 0 && (
        <div className="mt-2.5 border-t border-line pt-2 text-2xs text-text-3">
          {county?.declared ? `No aid here: expected need is under the ${MIN_NEED_PCT}% cutoff.` : "No aid: this county wasn't declared."}
        </div>
      )}
      {aid > 0 && (
        <div className="mt-2.5 border-t border-line pt-2">
          <div className="flex items-baseline justify-between">
            <span className={`text-xl font-semibold tracking-tight tabular ${landsIn > 0 ? "text-text-2" : "text-teal"}`}>{usdCompact(aid)}</span>
            <span className="text-2xs text-text-2 tabular">
              {usd(aid / eligible)} × {int(eligible)} households
            </span>
          </div>
          {landsIn > 0 && <div className="mt-1 text-2xs text-text-3">Lands when the storm arrives, {relative(landsIn)}</div>}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs text-text-3">{k}</dt>
      <dd className="truncate tabular text-text">
        {v} {sub && <span className="text-text-3">{sub}</span>}
      </dd>
    </div>
  );
}
