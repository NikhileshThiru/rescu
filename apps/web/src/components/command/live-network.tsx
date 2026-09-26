"use client";

import { explorerAddress, explorerTx, type FeedItem, type FeedOrigin, type Kpis, type RunInfo } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { type SimClock, useClockTime } from "@/lib/clock";
import { compact, formatClock, int, pct, relative, ruleLabel as ruleName, usd, usdCompact } from "@/lib/format";
import { type LiveClient, useLive } from "@/lib/live";
import type { Timeline } from "@/lib/storm-data";
import { NumberTicker } from "../ui/number-ticker";
import { Badge, Button, cx, Dot, Section, Stat } from "../ui/primitives";
import { frozenWallets, OracleBlock, suspendedStores } from "./oracle-rail";

const CATEGORY_STYLE: Record<string, { label: string; color: string }> = {
  grocery: { label: "Groceries", color: "#2dd4bf" },
  pharmacy: { label: "Pharmacy", color: "#a78bfa" },
  hardware: { label: "Hardware", color: "#f5b83d" },
  general: { label: "General", color: "#86a8e2" },
};

const FEED_TONE: Record<FeedItem["kind"], "teal" | "red" | "storm" | "amber"> = {
  aid: "teal",
  payment: "storm",
  blocked: "red",
  fund: "teal",
  clawback: "amber",
  join: "teal",
  oracle: "amber",
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

function ruleLabel(rule: string, run: RunInfo): string {
  return ruleName(rule, run.rules);
}

/** Who started a feed row, when it wasn't the sim's own households. */
const ORIGIN_BADGE: Partial<Record<FeedOrigin, { label: string; cls: string }>> = {
  agent: { label: "Grok", cls: "border-storm/20 bg-storm-soft text-storm" },
  shop: { label: "Phone", cls: "border-teal/20 bg-teal-soft text-teal" },
  join: { label: "Phone", cls: "border-teal/20 bg-teal-soft text-teal" },
  mcp: { label: "Agent", cls: "border-storm/20 bg-storm-soft text-storm" },
  counter: { label: "Counter", cls: "border-line bg-surface-3 text-text-2" },
  oracle: { label: "Oracle", cls: "border-amber/25 bg-amber-soft text-amber" },
  breakit: { label: "Test", cls: "border-line bg-surface-3 text-text-2" },
};

/**
 * The live relief network in the rail: prepare, declare & fund, then real on-chain aid and
 * payments with Tiger-backed KPIs. Everything here comes from the server; nothing is simulated
 * in the browser.
 */
export function LiveNetwork({
  live,
  clock,
  slug,
  timeline,
  onStorm,
}: {
  live: LiveClient;
  clock: SimClock;
  slug: string;
  timeline: Timeline;
  onStorm: (slug: string) => void;
}) {
  const link = useLive(live, (s) => s.link);
  const run = useLive(live, (s) => s.run);
  const history = useLive(live, (s) => s.history);
  const error = useLive(live, (s) => s.error);

  const here = run?.slug === slug;
  const phase = link !== "open" ? "nolink" : !run ? "booting" : run.phase === "live" && run.progress ? "closing" : run.phase;

  return (
    <Section title="Live network" aside={<PhaseBadge phase={here || phase === "nolink" ? phase : "elsewhere"} history={history && here} />}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${phase === "closing" ? "live" : phase}:${here}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {phase === "nolink" && (
            <Note>
              {link === "connecting" ? "Connecting to the relief network…" : "Can't reach the relief network server. Retrying."}
            </Note>
          )}
          {phase === "booting" && <Note>The relief network is starting up.</Note>}
          {run && phase !== "nolink" && !here && <Elsewhere run={run} slug={slug} live={live} onStorm={onStorm} />}
          {run && phase === "offline" && here && (
            <Note tone="red">{run.error ?? "The chain or database is unreachable."} Retrying automatically.</Note>
          )}
          {run && phase === "staging" && here && <Staging run={run} />}
          {run && phase === "ready" && here && <Ready run={run} live={live} clock={clock} timeline={timeline} />}
          {run && (phase === "live" || phase === "closing" || phase === "ended") && here && (
            <Running run={run} live={live} timeline={timeline} history={history} />
          )}
        </motion.div>
      </AnimatePresence>
      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 overflow-hidden text-2xs text-amber"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </Section>
  );
}

function PhaseBadge({ phase, history }: { phase: string; history: boolean }) {
  if (history) return <Badge tone="amber">Viewing history</Badge>;
  switch (phase) {
    case "live":
      return (
        <Badge tone="teal">
          <Dot tone="teal" pulse /> Live on Solana
        </Badge>
      );
    case "closing":
      return <Badge tone="amber">Closing out</Badge>;
    case "ready":
      return <Badge tone="teal">Ready</Badge>;
    case "staging":
      return <Badge tone="amber">Preparing</Badge>;
    case "ended":
      return <Badge>Closed out</Badge>;
    case "offline":
      return <Badge tone="red">Offline</Badge>;
    case "nolink":
      return <Badge>No link</Badge>;
    case "elsewhere":
      return <Badge>Standby</Badge>;
    default:
      return <Badge>Starting</Badge>;
  }
}

function Note({ children, tone }: { children: ReactNode; tone?: "red" }) {
  return <p className={`text-xs leading-relaxed ${tone === "red" ? "text-red" : "text-text-3"}`}>{children}</p>;
}

function Elsewhere({ run, slug, live, onStorm }: { run: RunInfo; slug: string; live: LiveClient; onStorm: (s: string) => void }) {
  const busy = run.phase === "live" || run.phase === "staging";
  return (
    <div className="space-y-2.5">
      <Note>
        {run.phase === "live"
          ? `Aid is flowing for Hurricane ${run.stormName}.`
          : run.phase === "staging"
            ? `Preparing the network for Hurricane ${run.stormName}.`
            : `The network is set up for Hurricane ${run.stormName}.`}
      </Note>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => onStorm(run.slug)}>
          Show {run.stormName}
        </Button>
        {!busy && (
          <Button variant="ghost" size="sm" onClick={() => live.stage(slug)}>
            Prepare for this storm
          </Button>
        )}
      </div>
    </div>
  );
}

function Progress({ progress: p }: { progress: RunInfo["progress"] }) {
  const f = p && p.total > 0 ? p.done / p.total : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-text-2">{p?.label ?? "Preparing"}</span>
        {p && p.total > 0 && (
          <span className="shrink-0 tabular text-text-3">
            {int(p.done)} / {int(p.total)}
          </span>
        )}
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
        <motion.div className="h-full rounded-full bg-amber/80" animate={{ width: `${f * 100}%` }} transition={{ duration: 0.3 }} />
      </div>
    </div>
  );
}

function Staging({ run }: { run: RunInfo }) {
  return (
    <div>
      <Progress progress={run.progress} />
      <p className="mt-2 text-2xs leading-relaxed text-text-3">
        Creating the declaration, registering {int(run.merchants)} stores and enrolling {int(run.households)} households on Solana.
      </p>
    </div>
  );
}

function Rules({ run }: { run: RunInfo }) {
  const chips = [
    `${usd(run.rules.perOrderCapUsd)} per order`,
    `${usd(run.rules.dailyCapUsd)} per 24 h`,
    "Registered stores only",
    "Expires Day 30",
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c} className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-2xs text-text-2">
          {c}
        </span>
      ))}
    </div>
  );
}

function Ready({ run, live, clock, timeline }: { run: RunInfo; live: LiveClient; clock: SimClock; timeline: Timeline }) {
  const t = useClockTime(clock, 2);
  const tooLate = t > timeline.end - 2 * 86400;
  const from = formatClock(t, timeline.timeZone);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Households" sub={`sample of ${compact(run.fullScaleHouseholds)}`}>
          {compact(run.households)}
        </Stat>
        <Stat label="Stores" sub="registered">
          {int(run.merchants)}
        </Stat>
        <Stat label="Budget" tone="teal" sub="relief dollars">
          {usdCompact(run.budgetUsd)}
        </Stat>
      </div>
      <Rules run={run} />
      <Button
        variant="solid"
        className="h-9 w-full shadow-[0_0_24px_-6px_rgba(45,212,191,0.6)]"
        disabled={tooLate}
        onClick={() => live.declare(clock.t, clock.speed)}
      >
        Declare disaster &amp; fund {usdCompact(run.budgetUsd)}
      </Button>
      <p className="text-2xs leading-relaxed text-text-3">
        {tooLate
          ? "Rewind the timeline to declare."
          : `Mints relief dollars on Solana and starts the clock from ${from.date}, ${from.time}. Aid lands as the storm reaches each household.`}
      </p>
    </div>
  );
}

function Running({ run, live, timeline, history }: { run: RunInfo; live: LiveClient; timeline: Timeline; history: boolean }) {
  const kpis = useLive(live, (s) => s.kpis);
  const ended = run.phase === "ended";
  const closedOut = ended && !!kpis && (!history || kpis.returnedUsd > 0);
  return (
    <div className="space-y-3.5">
      {history && kpis && <HistoryBanner kpis={kpis} live={live} timeline={timeline} />}
      {run.phase === "live" && run.progress && <Progress progress={run.progress} />}
      {!kpis ? (
        <Note>Waiting for the first numbers from Tiger…</Note>
      ) : closedOut ? (
        <Closed run={run} kpis={kpis} live={live} />
      ) : (
        <Flowing run={run} kpis={kpis} />
      )}
      {kpis && <Blocked run={run} kpis={kpis} />}
      <OracleBlock live={live} stores={run.merchants} />
      <Feed live={live} run={run} />
      {kpis && <Categories kpis={kpis} />}
      {kpis && <TigerLine kpis={kpis} />}
      {ended && !history && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => live.reset()}>
          Run it again
        </Button>
      )}
    </div>
  );
}

function HistoryBanner({ kpis, live, timeline }: { kpis: Kpis; live: LiveClient; timeline: Timeline }) {
  const d = kpis.simT - timeline.landfall;
  const when =
    d < 0
      ? `${relative(-d).replace(/^in /, "")} before landfall`
      : d < 86400
        ? `${relative(-d).replace(/ ago$/, "")} after landfall`
        : `Day ${Math.floor(d / 86400)} of recovery`;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-amber/20 bg-amber-soft px-2.5 py-1.5">
      <span className="text-xs text-amber">Network as of {when}</span>
      <Button size="sm" variant="ghost" className="h-6 text-amber hover:bg-amber/10 hover:text-amber" onClick={() => live.backToLive()}>
        Back to live
      </Button>
    </div>
  );
}

function Flowing({ run, kpis }: { run: RunInfo; kpis: Kpis }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
        <Stat label="Aid disbursed" size="lg" tone="teal" sub={`${int(kpis.householdsPaid)} of ${int(run.households)} households`}>
          <NumberTicker value={kpis.disbursedUsd} format={usdCompact} />
        </Stat>
        <Stat
          label="Time to aid"
          size="lg"
          sub={kpis.timeToAidMs ? `p95 ${seconds(kpis.timeToAidMs.p95)} · D-SNAP takes weeks` : "storm arrival to wallet"}
        >
          {kpis.timeToAidMs ? <NumberTicker value={kpis.timeToAidMs.p50} format={seconds} /> : "—"}
        </Stat>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {kpis.history ? (
          <Stat label="Transactions/s" sub="live only">
            —
          </Stat>
        ) : (
          <div className="min-w-0">
            <div className="text-xs text-text-3">Transactions/s</div>
            <div className="mt-0.5 text-lg font-semibold leading-6 tracking-tight">
              <NumberTicker value={kpis.txPerSec} format={int} duration={0.6} />
            </div>
            <Sparkline values={kpis.txSeries} />
          </div>
        )}
        <Stat label="Spent" sub={`${compact(kpis.payments)} purchases`}>
          <NumberTicker value={kpis.spentUsd} format={usdCompact} />
        </Stat>
        <Stat label="Blocked" tone={kpis.blocked ? "red" : undefined} sub="by the chain">
          <NumberTicker value={kpis.blocked} format={int} />
        </Stat>
      </div>
    </>
  );
}

function Closed({ run, kpis, live }: { run: RunInfo; kpis: Kpis; live: LiveClient }) {
  const balanced = Math.abs(kpis.disbursedUsd - kpis.spentUsd - kpis.returnedUsd) < 1;
  const cases = useLive(live, (s) => s.cases);
  const suspended = useLive(live, (s) => suspendedStores(s.stores));
  const frozen = frozenWallets(cases);
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Disbursed" sub={`${int(kpis.householdsPaid)} households`}>
          {usdCompact(kpis.disbursedUsd)}
        </Stat>
        <Stat label="Spent" sub={`${compact(kpis.payments)} purchases`}>
          {usdCompact(kpis.spentUsd)}
        </Stat>
        <Stat label="Returned" tone="teal" sub="to the treasury">
          <NumberTicker value={kpis.returnedUsd} format={usdCompact} />
        </Stat>
      </div>
      <p className="text-2xs leading-relaxed text-text-3">
        Day 30: unspent aid expired and went back to the treasury.{" "}
        {kpis.returnedUsd > 0 && balanced && <span className="text-teal">Disbursed = spent + returned, to the cent.</span>}
        {kpis.returnedUsd === 0 && `Returning ${usdCompact(run.budgetUsd - kpis.spentUsd)}…`}
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-2.5 py-1.5 text-2xs text-text-2 tabular">
        <span className="size-1.5 shrink-0 rounded-full bg-amber" />
        <span className="text-text-3">Oracle</span>
        <span>
          {int(cases.length)} {cases.length === 1 ? "case" : "cases"} opened
        </span>
        <span className="text-text-3">·</span>
        <span className={suspended ? "text-red" : undefined}>
          {int(suspended)} {suspended === 1 ? "store" : "stores"} suspended
        </span>
        <span className="text-text-3">·</span>
        <span className={frozen ? "text-red" : undefined}>
          {int(frozen)} {frozen === 1 ? "wallet" : "wallets"} frozen
        </span>
      </div>
    </>
  );
}

function Blocked({ run, kpis }: { run: RunInfo; kpis: Kpis }) {
  if (!kpis.blockedBy.length) return null;
  return (
    <div>
      <div className="mb-1.5 text-xs text-text-3">Stopped by the transfer hook</div>
      <div className="flex flex-wrap gap-1">
        {kpis.blockedBy.map((b) => (
          <span key={b.rule} className="inline-flex items-center gap-1.5 rounded-md border border-red/20 bg-red-soft px-1.5 py-0.5 text-2xs text-red">
            {ruleLabel(b.rule, run)} <span className="tabular text-red/70">{int(b.count)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Categories({ kpis }: { kpis: Kpis }) {
  const total = kpis.spentByCategory.reduce((a, c) => a + c.usd, 0);
  if (total <= 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-xs text-text-3">Where the aid is spent</div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-3">
        {kpis.spentByCategory.map((c) => (
          <motion.div
            key={c.category}
            animate={{ width: `${(100 * c.usd) / total}%` }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            style={{ background: CATEGORY_STYLE[c.category]?.color ?? "#7c8aa0" }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {kpis.spentByCategory.map((c) => (
          <span key={c.category} className="flex items-center gap-1.5 text-2xs text-text-2 tabular">
            <span className="size-1.5 rounded-full" style={{ background: CATEGORY_STYLE[c.category]?.color ?? "#7c8aa0" }} />
            {CATEGORY_STYLE[c.category]?.label ?? c.category} {pct(c.usd / total)}
          </span>
        ))}
      </div>
    </div>
  );
}

const FEED_ROWS = 5;
const ROW_H = 38;

/** Fixed-height rows moved by CSS transforms: no layout measurement while the map is busy. */
function Feed({ live, run }: { live: LiveClient; run: RunInfo }) {
  const feed = useLive(live, (s) => s.feed);
  if (!feed.length) return null;
  return (
    <div>
      <div className="mb-1 text-xs text-text-3">On-chain now</div>
      <ul className="relative -mx-1.5 overflow-hidden" style={{ height: Math.min(feed.length, FEED_ROWS) * ROW_H }}>
        {feed.map((f, i) => (
          <FeedRow key={f.signature || `${f.kind}:${f.simT}`} item={f} index={i} run={run} />
        ))}
      </ul>
    </div>
  );
}

function FeedRow({ item: f, index, run }: { item: FeedItem; index: number; run: RunInfo }) {
  const [entered, setEntered] = useState(false);
  const badge = f.origin ? ORIGIN_BADGE[f.origin] : undefined;
  const oracleRestore = f.kind === "oracle" && /reinstated|thawed/i.test(f.title);
  const tone = f.kind === "oracle" ? (oracleRestore ? "teal" : "red") : FEED_TONE[f.kind];
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const gone = index >= FEED_ROWS;
  return (
    <li
      className="absolute inset-x-0 top-0 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ height: ROW_H, transform: `translateY(${entered ? index * ROW_H : -10}px)`, opacity: entered && !gone ? 1 : 0 }}
    >
      <a
        href={f.signature ? explorerTx(f.signature, run.explorerCluster) : explorerAddress(run.declaration, run.explorerCluster)}
        target="_blank"
        rel="noreferrer"
        className={cx(
          "group flex h-full items-start gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-3/60",
          f.kind === "join" && "bg-teal/[0.06]",
          f.kind === "oracle" && (oracleRestore ? "bg-teal/[0.05]" : "bg-red/[0.07]"),
        )}
      >
        <span className="mt-[5px]">
          <Dot tone={tone} pulse={f.kind === "join" || f.kind === "oracle"} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className={cx("truncate", f.kind === "join" ? "text-teal" : f.kind === "oracle" && !oracleRestore ? "text-red" : "text-text")}>
                {f.title}
              </span>
              {badge && (
                <span className={cx("shrink-0 rounded border px-1 text-[10px] font-medium leading-[14px]", badge.cls)}>{badge.label}</span>
              )}
            </span>
            {f.kind !== "oracle" && (
              <span className={`shrink-0 tabular ${f.kind === "blocked" ? "text-red line-through decoration-red/50" : f.kind === "join" ? "text-teal" : "text-text-2"}`}>
                {f.kind === "join" ? "+" : ""}
                {f.usd >= 1e4 ? usdCompact(f.usd) : `$${f.usd.toFixed(2)}`}
              </span>
            )}
          </span>
          <span className="flex items-baseline justify-between gap-2 text-2xs text-text-3">
            <span className={`truncate ${f.kind === "blocked" ? "text-red/80" : ""}`}>{f.detail}</span>
            <span className="shrink-0 tabular transition-colors group-hover:text-teal">
              {f.latencyMs >= 10_000 ? seconds(f.latencyMs) : `${f.latencyMs} ms`} ↗
            </span>
          </span>
        </span>
      </a>
    </li>
  );
}

function TigerLine({ kpis }: { kpis: Kpis }) {
  const t = kpis.tiger;
  return (
    <div className="flex items-center gap-1.5 text-2xs text-text-3 tabular">
      <Dot tone={t.ok ? "teal" : "amber"} />
      <span className="text-text-2">Tiger</span>
      <span>{compact(t.rows)} rows</span>
      <span>·</span>
      <span>{int(t.rowsPerSec)}/s in</span>
      <span>·</span>
      <span>{t.queryMs} ms query</span>
      {t.compressionPct !== null && (
        <>
          <span>·</span>
          <span>{pct(t.compressionPct / 100)} compressed</span>
        </>
      )}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const id = useId();
  const w = 100;
  const h = 18;
  const max = Math.max(1, ...values);
  const n = values.length;
  if (n < 2) return <div className="mt-1 h-[18px]" />;
  const pts = values.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-1 h-[18px] w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#2dd4bf" stopOpacity="0.35" />
          <stop offset="1" stopColor="#2dd4bf" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M0,${h} L${pts.join(" L")} L${w},${h} Z`} fill={`url(#${id})`} />
      <path d={`M${pts.join(" L")}`} fill="none" stroke="#2dd4bf" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
