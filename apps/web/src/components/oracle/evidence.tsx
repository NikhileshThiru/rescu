"use client";

import type { Evidence, OracleCase } from "@rescu/live";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { cx } from "../ui/primitives";
import { money, moneyShort, simClock } from "../merchant/money";

type Of<K extends Evidence["kind"]> = Extract<Evidence, { kind: K }>;

const EASE = [0.16, 1, 0.3, 1] as const;

/** The case's evidence, drawn for its kind. */
export function EvidenceView({ c }: { c: OracleCase }) {
  const e = c.evidence;
  switch (e.kind) {
    case "gouging":
      return <Gouging e={e} store={c.subjects[0]?.idx ?? null} />;
    case "duplicate_identity":
      return <Duplicate e={e} />;
    case "velocity":
      return <Velocity e={e} />;
    case "collusion":
      return <Collusion e={e} />;
  }
}

// ---------- gouging: the store's price over time vs the regional median band ----------

function Gouging({ e, store }: { e: Of<"gouging">; store: number | null }) {
  const reduce = useReducedMotion() ?? false;
  const W = 560;
  const H = 190;
  const pad = { l: 8, r: 92, t: 16, b: 24 };
  const series = e.series.length ? e.series : [{ simT: 0, priceCents: e.priceCents }];
  const t0 = series[0]!.simT;
  const t1 = Math.max(series[series.length - 1]!.simT, t0 + 1);
  const line = e.medianCents * (1 + e.thresholdPct / 100);
  const yMax = Math.max(...series.map((p) => p.priceCents), line) * 1.12;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (c: number) => pad.t + (1 - c / yMax) * (H - pad.t - pad.b);
  let d = `M${x(series[0]!.simT)},${y(series[0]!.priceCents)}`;
  for (let i = 1; i < series.length; i++) d += `H${x(series[i]!.simT)}V${y(series[i]!.priceCents)}`;
  d += `H${x(t1)}`;
  const peersMax = Math.max(e.priceCents, ...e.peers.map((p) => p.priceCents));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <Big label={`${e.item} now`} value={money(e.priceCents)} tone="amber" />
        <Big label="Nearby stores before the storm" value={money(e.medianCents)} />
        <Big label="Markup" value={`${e.ratio.toFixed(1)}x`} tone="amber" sub={`limit +${e.thresholdPct}%`} />
        <Big label="Overpaid by residents" value={money(e.overchargeCents)} tone={e.overchargeCents ? "red" : undefined} sub={`${e.sales} relief purchase${e.sales === 1 ? "" : "s"}`} />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Price of ${e.item} over time against the regional median`}>
        <defs>
          <linearGradient id="gouge-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f5b83d" stopOpacity="0.22" />
            <stop offset="1" stopColor="#f5b83d" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Fair zone: the regional median up to the gouging line. */}
        <rect x={pad.l} y={y(line)} width={W - pad.l - pad.r} height={y(e.medianCents) - y(line)} fill="#2dd4bf" opacity="0.1" />
        <line x1={pad.l} x2={W - pad.r} y1={y(e.medianCents)} y2={y(e.medianCents)} stroke="#2dd4bf" strokeOpacity="0.7" strokeWidth="1" />
        <line x1={pad.l} x2={W - pad.r} y1={y(line)} y2={y(line)} stroke="#f5b83d" strokeOpacity="0.6" strokeDasharray="4 4" strokeWidth="1" />
        <text x={W - pad.r + 8} y={y(e.medianCents) + 4} fontSize="10.5" fill="#2dd4bf">
          Median {money(e.medianCents)}
        </text>
        <text x={W - pad.r + 8} y={y(line) - 3} fontSize="10.5" fill="#f5b83d" opacity="0.85">
          +{e.thresholdPct}% line
        </text>
        <motion.path d={`${d}V${H - pad.b}H${pad.l}Z`} fill="url(#gouge-fill)" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5, duration: 0.6 }} />
        <motion.path
          d={d}
          fill="none"
          stroke="#f5b83d"
          strokeWidth="2"
          strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: EASE }}
        />
        <circle cx={x(t1)} cy={y(e.priceCents)} r="3.5" fill="#f5b83d" />
        <text x={W - pad.r + 8} y={y(e.priceCents) + 4} fontSize="11" fontWeight="600" fill="#f5b83d">
          {money(e.priceCents)}
        </text>
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="rgb(154 168 189 / 0.18)" />
        <text x={pad.l} y={H - 7} fontSize="10" fill="#7c8aa0">
          Before the storm
        </text>
        <text x={W - pad.r} y={H - 7} fontSize="10" fill="#7c8aa0" textAnchor="end">
          {simClock(t1)}
        </text>
      </svg>
      {!!e.peers.length && (
        <div>
          <div className="eyebrow mb-1.5">Same item at stores nearby, now</div>
          <ul className="space-y-1">
            <PeerRow name="This store" price={e.priceCents} max={peersMax} hot href={store !== null ? `/merchant?store=${store}` : null} />
            {e.peers.map((p) => (
              <PeerRow key={p.store} name={p.name} km={p.distanceKm} price={p.priceCents} max={peersMax} hot={p.priceCents > e.medianCents * (1 + e.thresholdPct / 100)} href={`/merchant?store=${p.store}`} />
            ))}
          </ul>
        </div>
      )}
      {!!e.otherItems.length && (
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-text-3">
          <span>Also marked up:</span>
          {e.otherItems.slice(0, 8).map((o) => (
            <span key={o.itemId} className="rounded-full border border-amber/20 bg-amber-soft px-2 py-0.5 text-amber">
              {o.item.split(",")[0]} {o.ratio.toFixed(1)}x
            </span>
          ))}
          {e.otherItems.length > 8 && <span>+{e.otherItems.length - 8} more</span>}
        </div>
      )}
    </div>
  );
}

function PeerRow({ name, km, price, max, hot, href }: { name: string; km?: number; price: number; max: number; hot: boolean; href: string | null }) {
  const body = (
    <div className="grid grid-cols-[minmax(0,1fr)_120px_64px] items-center gap-3 rounded-md px-1.5 py-1 text-xs hover:bg-surface-2/60">
      <span className="truncate text-text-2">
        {name}
        {km !== undefined && <span className="ml-1.5 text-text-3">{km} km</span>}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <motion.span className={cx("block h-full rounded-full", hot ? "bg-amber" : "bg-teal/60")} initial={{ width: 0 }} animate={{ width: `${(100 * price) / max}%` }} transition={{ duration: 0.8, ease: EASE }} />
      </span>
      <span className={cx("text-right tabular", hot ? "text-amber" : "text-text")}>{money(price)}</span>
    </div>
  );
  return <li>{href ? <Link href={href}>{body}</Link> : body}</li>;
}

// ---------- duplicate identity: registrations on one device / phone / address ----------

function Duplicate({ e }: { e: Of<"duplicate_identity"> }) {
  const keyLabel = e.key === "device" ? "Same device" : e.key === "phone" ? "Same phone number" : "Same address";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <Big label="Registrations" value={String(e.households.length)} tone="amber" />
        <Big label="Aid to the extra registrations" value={money(e.duplicateAidCents)} tone="red" />
      </div>
      <div className="flex flex-col items-center">
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 rounded-full border border-amber/30 bg-amber-soft px-3 py-1.5">
          <KeyIcon kind={e.key} />
          <span className="text-xs text-amber">{keyLabel}</span>
          <span className="font-mono text-xs text-text">{e.value}</span>
        </motion.div>
        <svg viewBox="0 0 600 34" className="h-[34px] w-full" preserveAspectRatio="none" aria-hidden>
          {e.households.map((_, i) => {
            const n = e.households.length;
            const cx0 = ((i + 0.5) / n) * 600;
            return <motion.path key={i} d={`M300,0 C300,18 ${cx0},14 ${cx0},34`} fill="none" stroke="#f5b83d" strokeOpacity="0.45" strokeWidth="1.2" vectorEffect="non-scaling-stroke" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.15 + i * 0.08, duration: 0.5 }} />;
          })}
        </svg>
        <div className="grid w-full gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(e.households.length, 5)}, minmax(0, 1fr))` }}>
          {e.households.map((h, i) => (
            <motion.div
              key={h.resident}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 + i * 0.08, duration: 0.4, ease: EASE }}
              className={cx("rounded-lg border px-3 py-2.5", i === 0 ? "border-line bg-surface-2/60" : "border-amber/25 bg-amber-soft/40")}
            >
              <div className="truncate text-[13px] font-medium">{h.name}</div>
              <div className="truncate text-2xs text-text-3">{h.county}</div>
              <div className={cx("mt-1.5 text-sm tabular", i === 0 ? "text-text" : "text-amber")}>{money(h.aidCents)}</div>
              <div className="text-[10px] text-text-3">{i === 0 ? "First registration" : "Extra registration"}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}

function KeyIcon({ kind }: { kind: "device" | "phone" | "address" }) {
  if (kind === "address")
    return (
      <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden className="text-amber">
        <path d="M2 6.5 7 2.5l5 4V12H2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    );
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden className="text-amber">
      <rect x="4" y="1.5" width="6" height="11" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.3 10.5h1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ---------- velocity: every order over time, cap refusals in red, spend vs aid ----------

function Velocity({ e }: { e: Of<"velocity"> }) {
  const reduce = useReducedMotion() ?? false;
  const W = 560;
  const H = 170;
  const pad = { l: 8, r: 70, t: 14, b: 22 };
  const tl = e.timeline.length ? e.timeline : [];
  const t0 = tl.length ? tl[0]!.simT : 0;
  const t1 = tl.length ? Math.max(tl[tl.length - 1]!.simT, t0 + 3600) : 1;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const maxC = Math.max(20_000, ...tl.map((p) => p.cents));
  const barH = (c: number) => (c / maxC) * (H - pad.t - pad.b) * 0.55;
  // Cumulative landed spend vs the grant (upper part of the chart).
  let cum = 0;
  const yCum = (c: number) => pad.t + (1 - c / Math.max(e.aidCents, 1)) * (H - pad.t - pad.b);
  let path = `M${x(t0)},${yCum(0)}`;
  for (const p of tl) {
    if (!p.ok) continue;
    path += `H${x(p.simT)}V${yCum((cum += p.cents))}`;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <Big label="Spent" value={money(e.spentCents)} tone="amber" sub={`of ${money(e.aidCents)} aid`} />
        <Big label="Orders" value={String(e.orders)} sub={`in ${Math.max(1, Math.round(e.hours))} h`} />
        <Big label="Refused for the caps" value={String(e.capHits)} tone={e.capHits ? "red" : undefined} sub="$200 per order · $300 per 24 h" />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Orders over time">
        <line x1={pad.l} x2={W - pad.r} y1={yCum(e.aidCents)} y2={yCum(e.aidCents)} stroke="#9aa8bd" strokeOpacity="0.35" strokeDasharray="3 4" />
        <text x={W - pad.r + 6} y={yCum(e.aidCents) + 4} fontSize="10" fill="#7c8aa0">
          All aid
        </text>
        <motion.path d={path} fill="none" stroke="#f5b83d" strokeWidth="1.8" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: EASE }} />
        <text x={W - pad.r + 6} y={yCum(cum) + 4} fontSize="10.5" fill="#f5b83d">
          {money(cum)}
        </text>
        {tl.map((p, i) => {
          const h = barH(p.cents);
          const bx = x(p.simT);
          return p.ok ? (
            <motion.rect key={i} x={bx - 2} width="4" rx="1" fill="#2dd4bf" fillOpacity="0.8" initial={{ height: 0, y: H - pad.b }} animate={{ height: h, y: H - pad.b - h }} transition={{ delay: 0.2 + i * 0.02, duration: 0.4 }} />
          ) : (
            <g key={i}>
              <motion.rect x={bx - 2} width="4" rx="1" fill="#f0616d" initial={{ height: 0, y: H - pad.b }} animate={{ height: h, y: H - pad.b - h }} transition={{ delay: 0.2 + i * 0.02, duration: 0.4 }} />
              <path d={`M${bx - 3.5},${H - pad.b - h - 10}l7,7m0,-7l-7,7`} stroke="#f0616d" strokeWidth="1.4" strokeLinecap="round" />
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="rgb(154 168 189 / 0.18)" />
        <text x={pad.l} y={H - 6} fontSize="10" fill="#7c8aa0">
          {tl.length ? simClock(t0) : ""}
        </text>
        <text x={W - pad.r} y={H - 6} fontSize="10" fill="#7c8aa0" textAnchor="end">
          {tl.length ? simClock(t1) : ""}
        </text>
      </svg>
      <div className="flex items-center gap-4 text-2xs text-text-3">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-1 rounded-sm bg-teal" /> Paid
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-1 rounded-sm bg-red" /> Refused by the chain
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-amber" /> Total spent
        </span>
      </div>
    </div>
  );
}

// ---------- collusion: residents' share at the store, store volume vs expected ----------

function Collusion({ e }: { e: Of<"collusion"> }) {
  const volMax = Math.max(e.storeVolumeCents, e.expectedVolumeCents, 1);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
        <Big label="Residents" value={String(e.residents.length)} tone="amber" sub="spent nearly everything here" />
        <Big label="Store takings" value={moneyShort(e.storeVolumeCents)} tone="amber" sub={`${(e.storeVolumeCents / Math.max(1, e.expectedVolumeCents)).toFixed(1)}x similar stores`} />
        <Big label="From these residents" value={`${Math.round(e.concentration * 100)}%`} sub="of its relief takings" />
      </div>
      <div className="space-y-1.5">
        <div className="eyebrow">Takings</div>
        <VolBar label="This store" cents={e.storeVolumeCents} max={volMax} hot />
        <VolBar label="Similar stores nearby" cents={e.expectedVolumeCents} max={volMax} />
      </div>
      <div>
        <div className="eyebrow mb-1.5">Share of each resident's spending at this store</div>
        <ul className="space-y-1">
          {e.residents.map((r, i) => (
            <li key={r.resident} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_48px_72px] items-center gap-3 text-xs">
              <span className="truncate text-text-2">{r.name}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <motion.span className="block h-full rounded-full bg-amber" initial={{ width: 0 }} animate={{ width: `${r.shareAtStore * 100}%` }} transition={{ delay: i * 0.05, duration: 0.7, ease: EASE }} />
              </span>
              <span className="text-right tabular text-amber">{Math.round(r.shareAtStore * 100)}%</span>
              <span className="text-right tabular text-text-3">{money(r.spentCents)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function VolBar({ label, cents, max, hot }: { label: string; cents: number; max: number; hot?: boolean }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)_80px] items-center gap-3 text-xs">
      <span className="text-text-2">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-surface-3">
        <motion.span className={cx("block h-full rounded-full", hot ? "bg-amber" : "bg-text-3/60")} initial={{ width: 0 }} animate={{ width: `${(100 * cents) / max}%` }} transition={{ duration: 0.8, ease: EASE }} />
      </span>
      <span className={cx("text-right tabular", hot ? "text-amber" : "text-text-2")}>{moneyShort(cents)}</span>
    </div>
  );
}

function Big({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "amber" | "red" | "teal" }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs text-text-3">{label}</div>
      <div className={cx("text-xl font-semibold tracking-tight tabular", tone === "amber" ? "text-amber" : tone === "red" ? "text-red" : tone === "teal" ? "text-teal" : "text-text")}>{value}</div>
      {sub && <div className="text-2xs text-text-3">{sub}</div>}
    </div>
  );
}
