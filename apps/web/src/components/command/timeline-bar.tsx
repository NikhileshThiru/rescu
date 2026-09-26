"use client";

import type { Storm } from "@rescu/aid-model";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type SimClock, useClockTime } from "@/lib/clock";
import { formatClock } from "@/lib/format";
import { type LiveClient, useLive } from "@/lib/live";
import { fracToTime, type Timeline, timeToFrac } from "@/lib/storm-data";

const DAY = 86400;

/** Unix times of local midnight in `timeZone` between start and end (checked hour by hour). */
function localMidnights(start: number, end: number, timeZone: string): number[] {
  const hourOf = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" });
  const out: number[] = [];
  for (let t = Math.floor(start / 3600) * 3600; t < end; t += 3600) {
    if (t > start && Number(hourOf.format(new Date(t * 1000))) === 0) out.push(t);
  }
  return out;
}

/**
 * Forecast -> landfall -> response -> recovery -> Day 30 close-out. Storm days get most of the
 * width (non-linear), with the storm's intensity drawn above the bar. Drag anywhere to scrub.
 */
/** Floats above the timeline while the presenter looks at an earlier moment of a live run. */
function HistoryPill({ clock, timeline, live }: { clock: SimClock; timeline: Timeline; live: LiveClient }) {
  const t = useClockTime(clock, 4);
  const c = formatClock(t, timeline.timeZone);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="glass absolute -top-12 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-amber/25 py-1 pl-3.5 pr-1 shadow-[var(--shadow-panel)]"
    >
      <span className="whitespace-nowrap text-xs text-amber tabular">
        Viewing the network on {c.date}, {c.time}
      </span>
      <button
        type="button"
        onClick={() => live.backToLive()}
        className="h-6 rounded-full bg-amber/15 px-2.5 text-xs font-medium text-amber transition-colors hover:bg-amber/25"
      >
        Back to live
      </button>
    </motion.div>
  );
}

/** Where the live network is while the playhead shows the past. */
function LiveHead({ live, timeline }: { live: LiveClient; timeline: Timeline }) {
  const head = live.head();
  if (head === null) return null;
  return (
    <div className="pointer-events-none absolute top-0 h-11" style={{ left: `${timeToFrac(timeline, head) * 100}%` }}>
      <div className="absolute h-full w-px -translate-x-1/2 bg-teal/70" />
      <div className="absolute -top-0.5 left-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-teal">Live</div>
    </div>
  );
}

/**
 * Area path for one flow series (per-bucket totals), scaled to its own peak. Lightly smoothed so
 * bursty buckets (confirmations arrive in clumps) read as a flow rather than a comb.
 */
function flowPath(vals: number[], t0: number, step: number, timeline: Timeline, height: number): string | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i]! > 0) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const v = vals.map((x, i) => ((vals[i - 1] ?? x) + 2 * x + (vals[i + 1] ?? x)) / 4);
  const lo = Math.max(0, first - 1);
  let max = 0;
  for (let i = lo; i <= last; i++) max = Math.max(max, v[i]!);
  const x = (i: number) => (timeToFrac(timeline, t0 + (i + 0.5) * step) * 1000).toFixed(1);
  let d = `M${x(lo)},40`;
  for (let i = lo; i <= last; i++) d += `L${x(i)},${(40 - (v[i]! / max) * height).toFixed(1)}`;
  return `${d}L${x(last)},40Z`;
}

export function TimelineBar({ clock, timeline, storm, live }: { clock: SimClock; timeline: Timeline; storm: Storm; live: LiveClient }) {
  const run = useLive(live, (s) => s.run);
  const series = useLive(live, (s) => s.series);
  const history = useLive(live, (s) => s.history);
  const presenter = useLive(live, (s) => s.presenter);
  const here = run?.slug === storm.slug;
  // Viewers of a live network watch the presenter's clock; only the presenter scrubs it.
  const locked = here && (run?.phase === "live" || run?.phase === "ended") && !presenter;
  const bar = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  // Moved with transforms (compositor only), not left/width, so playback never triggers layout.
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const dragging = useRef<{ wasPlaying: boolean } | null>(null);

  useEffect(
    () =>
      clock.onFrame((t) => {
        const f = timeToFrac(timeline, t);
        if (head.current) head.current.style.transform = `translateX(${f * 100}%)`;
        if (fill.current) fill.current.style.transform = `scaleX(${f})`;
      }),
    [clock, timeline],
  );

  const intensity = useMemo(() => {
    const pts = storm.points.filter((p) => p.t >= timeline.start && p.t <= timeline.trackEnd);
    if (pts.length < 2) return "";
    const peak = Math.max(...pts.map((p) => p.vmax ?? 0), 64);
    const xy = pts.map((p) => [timeToFrac(timeline, p.t) * 1000, 40 - ((p.vmax ?? 0) / peak) * 34] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    return `${line}L${xy[xy.length - 1]![0].toFixed(1)},40L${xy[0]![0].toFixed(1)},40Z`;
  }, [storm, timeline]);

  const flows = useMemo(() => {
    if (!here || !series) return null;
    const aid = flowPath(series.aidUsd, series.t0, series.step, timeline, 34);
    const spent = flowPath(series.spentUsd, series.t0, series.step, timeline, 24);
    return aid || spent ? { aid, spent } : null;
  }, [here, series, timeline]);

  const ticks = useMemo(() => {
    const out: { f: number; label: string; major: boolean }[] = [];
    // Storm days: local midnights in the storm's time zone.
    for (const t of localMidnights(timeline.start, timeline.trackEnd, timeline.timeZone)) {
      const c = formatClock(t, timeline.timeZone);
      out.push({ f: timeToFrac(timeline, t), label: c.date.replace(/^\w+, /, ""), major: false });
    }
    for (const d of [5, 10, 15, 20, 25, 30]) {
      const t = timeline.landfall + d * DAY;
      if (t > timeline.trackEnd + DAY) out.push({ f: timeToFrac(timeline, t), label: `Day ${d}`, major: d === 30 });
    }
    return out;
  }, [timeline]);

  const phases = useMemo(() => {
    const lf = timeToFrac(timeline, timeline.landfall);
    return [
      { label: "Forecast", from: 0, to: lf },
      { label: "Landfall + response", from: lf, to: timeline.split },
      { label: "Recovery", from: timeline.split, to: 0.97 },
    ];
  }, [timeline]);

  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const f = (clientX - r.left) / r.width;
    return { x: Math.min(r.width, Math.max(0, clientX - r.left)), t: fracToTime(timeline, f) };
  };

  return (
    <div className="relative select-none px-5 pb-3 pt-2.5">
      <AnimatePresence>{history && here && <HistoryPill clock={clock} timeline={timeline} live={live} />}</AnimatePresence>
      <div className="relative mb-1 h-4">
        {phases.map((p) => (
          <div
            key={p.label}
            className="eyebrow absolute top-0 truncate text-center"
            style={{ left: `${p.from * 100}%`, width: `${(p.to - p.from) * 100}%` }}
          >
            {p.label}
          </div>
        ))}
        <div className="eyebrow absolute right-0 top-0 text-teal">Day 30 close-out</div>
      </div>

      <div
        ref={bar}
        className={`group relative h-14 touch-none ${locked ? "cursor-default" : "cursor-ew-resize"}`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          // A live network's clock decides for itself where a scrub lands (history, jump ahead, back to live).
          dragging.current = { wasPlaying: clock.playing && !clock.driver };
          if (!clock.driver) clock.setPlaying(false);
          clock.seek(at(e.clientX).t);
        }}
        onPointerMove={(e) => {
          const p = at(e.clientX);
          setHover(p);
          if (dragging.current) clock.seek(p.t);
        }}
        onPointerUp={() => {
          if (dragging.current?.wasPlaying) clock.setPlaying(true);
          dragging.current = null;
        }}
        onPointerCancel={() => {
          if (dragging.current?.wasPlaying) clock.setPlaying(true);
          dragging.current = null;
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          const step = (e.shiftKey ? 6 : 1) * 3600;
          if (e.key === "ArrowRight") clock.seek(clock.t + step);
          if (e.key === "ArrowLeft") clock.seek(clock.t - step);
        }}
        tabIndex={0}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={timeline.start}
        aria-valuemax={timeline.end}
      >
        <svg className="absolute inset-x-0 top-0 h-10 w-full" viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="intensity" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#dce8ff" stopOpacity="0.35" />
              <stop offset="1" stopColor="#dce8ff" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={intensity} fill="url(#intensity)" stroke="#dce8ff" strokeOpacity="0.5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {flows?.spent && (
            <path d={flows.spent} fill="#a4f2e4" fillOpacity="0.12" stroke="#a4f2e4" strokeOpacity="0.7" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}
          {flows?.aid && (
            <path d={flows.aid} fill="#2dd4bf" fillOpacity="0.28" stroke="#2dd4bf" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {flows && (
          <div className="pointer-events-none absolute left-0 top-0 flex items-center gap-3 text-2xs text-text-3">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full bg-teal" /> Aid landing
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full bg-aid-5" /> Spending
            </span>
          </div>
        )}
        {history && here && <LiveHead live={live} timeline={timeline} />}

        <div className="absolute inset-x-0 top-10 h-1 overflow-hidden rounded-full bg-surface-3">
          <div ref={fill} className="h-full origin-left bg-gradient-to-r from-storm/40 to-storm/80" style={{ transform: "scaleX(0)" }} />
        </div>
        <div className="absolute top-10 h-1 w-px bg-line-strong" style={{ left: `${timeline.split * 100}%` }} />

        {timeline.landfalls.map((lf) => (
          <div
            key={lf.t}
            className="absolute top-[37px] size-2.5 -translate-x-1/2 rotate-45 border border-storm bg-bg"
            style={{ left: `${timeToFrac(timeline, lf.t) * 100}%` }}
            title="Landfall"
          />
        ))}
        <div
          className={`absolute top-[37px] size-2.5 -translate-x-1/2 rotate-45 border border-teal transition-colors duration-700 ${here && run?.phase === "ended" ? "bg-teal shadow-[0_0_10px_rgba(45,212,191,0.7)]" : "bg-bg"}`}
          style={{ left: "100%" }}
          title={here && run?.phase === "ended" ? "Closed out: unspent aid returned" : "Day 30 close-out"}
        />

        {ticks.map((t) => (
          <div
            key={t.label}
            className={`absolute top-12 whitespace-nowrap text-2xs text-text-3 tabular ${t.f > 0.97 ? "-translate-x-full" : t.f < 0.03 ? "" : "-translate-x-1/2"}`}
            style={{ left: `${t.f * 100}%` }}
          >
            {t.label}
          </div>
        ))}

        {/* Full-width track translated by the playhead's fraction; the head sits at its left edge. */}
        <div ref={head} className="pointer-events-none absolute inset-x-0 top-0 h-11 will-change-transform" style={{ transform: "translateX(0%)" }}>
          <div className="absolute left-0 h-full w-px -translate-x-1/2 bg-storm shadow-[0_0_12px_rgba(220,232,255,0.6)]" />
          <div className="absolute -bottom-1 left-0 size-3 -translate-x-1/2 rounded-full border-2 border-bg bg-storm" />
        </div>

        {hover && !dragging.current && (
          <div
            className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded-md border border-line bg-surface-2 px-2 py-0.5 text-2xs text-text-2 tabular"
            style={{ left: hover.x }}
          >
            {(() => {
              const c = formatClock(hover.t, timeline.timeZone);
              return `${c.date} · ${c.time}`;
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
