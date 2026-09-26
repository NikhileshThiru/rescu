"use client";

import { stormState } from "@rescu/aid-model";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { SimClock } from "@/lib/clock";
import { category, compact, int, mph, pct, relative, usd, usdCompact } from "@/lib/format";
import type { LiveClient } from "@/lib/live";
import type { StormFile, Timeline } from "@/lib/storm-data";
import { NumberTicker } from "../ui/number-ticker";
import { Badge, Divider, Dot, Panel, Section, Stat } from "../ui/primitives";
import { LiveNetwork } from "./live-network";

const HAZARD_STYLE: Record<string, { label: string; color: string }> = {
  wind: { label: "Wind", color: "#86a8e2" },
  rain: { label: "Rain flooding", color: "#2dd4bf" },
  surge: { label: "Storm surge", color: "#a78bfa" },
};

/**
 * Written straight to the DOM from the clock each frame (text only changes when a value does),
 * the same way as the map's storm label, so the two never disagree mid-playback.
 */
function StormNow({ file, clock, timeline }: { file: StormFile; clock: SimClock; timeline: Timeline }) {
  const status = useRef<HTMLSpanElement>(null);
  const wind = useRef<HTMLSpanElement>(null);
  const kt = useRef<HTMLDivElement>(null);
  const strength = useRef<HTMLSpanElement>(null);
  const strengthLong = useRef<HTMLDivElement>(null);
  const [alive, setAlive] = useState(true);
  const peak = Math.max(...file.storm.points.map((p) => p.vmax ?? 0));

  useEffect(() => {
    const shown = new Map<HTMLElement, string>();
    const put = (el: HTMLElement | null, text: string) => {
      if (el && shown.get(el) !== text) {
        shown.set(el, text);
        el.textContent = text;
      }
    };
    return clock.onFrame((t) => {
      const s = stormState(file.storm, t);
      const d = t - timeline.landfall;
      setAlive(!!s);
      put(status.current, s ? `Landfall ${relative(-d)}` : "Dissipated");
      put(wind.current, s ? `${mph(s.vmax)}` : "—");
      put(kt.current, s ? `${Math.round(s.vmax)} kt` : "—");
      const cat = s ? category(s.vmax) : null;
      put(strength.current, cat?.short ?? "—");
      put(strengthLong.current, cat?.long ?? "Outside track");
    });
  }, [clock, file, timeline]);

  return (
    <Section
      title="Storm now"
      aside={
        <span className="flex items-center gap-1.5 text-2xs text-text-3">
          <Dot tone="storm" pulse={alive} /> <span ref={status} className="tabular" />
        </span>
      }
    >
      <div className="grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <div className="text-xs text-text-3">Wind</div>
          <div className="mt-0.5 text-lg font-semibold leading-6 tracking-tight tabular text-storm">
            <span ref={wind} />
            <span className="ml-0.5 text-xs font-normal text-text-3">mph</span>
          </div>
          <div ref={kt} className="mt-0.5 text-2xs text-text-3 tabular" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-text-3">Strength</div>
          <div className="mt-0.5 text-lg font-semibold leading-6 tracking-tight tabular">
            <span ref={strength} />
          </div>
          <div ref={strengthLong} className="mt-0.5 text-2xs text-text-3" />
        </div>
        <Stat label="Peak" sub={category(peak).long}>
          {mph(peak)}
          <span className="ml-0.5 text-xs font-normal text-text-3">mph</span>
        </Stat>
      </div>
    </Section>
  );
}

export function RightRail({
  file,
  clock,
  timeline,
  live,
  onStorm,
}: {
  file: StormFile;
  clock: SimClock;
  timeline: Timeline;
  live: LiveClient;
  onStorm: (slug: string) => void;
}) {
  const p = file.projection;
  const hazardTotal = p.byHazard.reduce((x, h) => x + h.totalUsd, 0) || 1;
  const topCounties = file.counties.filter((c) => c.aidUsd > 0).slice(0, 6);
  const maxCounty = topCounties[0]?.aidUsd ?? 1;
  const f = file.fema;

  return (
    <aside className="pointer-events-auto absolute bottom-[152px] right-4 top-[72px] z-10 w-[372px]">
      <Panel className="flex h-full flex-col overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={file.storm.slug}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]"
          >
            <div className="px-4 pb-3 pt-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold tracking-tight">
                  Hurricane {file.storm.name} <span className="font-normal text-text-3">{file.storm.year}</span>
                </h2>
                <Badge tone="storm">{p.states.join(" · ")}</Badge>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-text-3">
                Who needs aid is decided from the storm itself at landfall: wind, rain and surge on every census tract.
              </p>
            </div>
            <Divider />
            <StormNow file={file} clock={clock} timeline={timeline} />
            <Divider />
            <LiveNetwork live={live} clock={clock} slug={file.storm.slug} timeline={timeline} onStorm={onStorm} />
            <Divider />

            <Section title="Aid decided at landfall" aside={<Badge tone="teal">Full-scale projection</Badge>}>
              <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
                <Stat label="Households" size="lg" sub={`in ${p.declaredCounties} counties`}>
                  <NumberTicker value={p.eligibleHouseholds} format={compact} />
                </Stat>
                <Stat label="Aid pot" size="lg" tone="teal" sub="$1,000 average">
                  <NumberTicker value={p.potUsd} format={usdCompact} />
                </Stat>
                <Stat label="Per household" sub={`${usd(p.minAidUsd)} to ${usd(p.maxAidUsd)}`}>
                  <NumberTicker value={p.medianAidUsd} format={usd} />
                  <span className="ml-1 text-xs font-normal text-text-3">median</span>
                </Stat>
                <Stat label="Counties" sub="declared by the model">
                  <NumberTicker value={p.declaredCounties} format={int} />
                </Stat>
              </div>
              <div className="mt-4">
                <div className="mb-1.5 text-xs text-text-3">What drove the aid</div>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-3">
                  {p.byHazard.map((h) => (
                    <motion.div
                      key={h.group}
                      initial={{ width: 0 }}
                      animate={{ width: `${(100 * h.totalUsd) / hazardTotal}%` }}
                      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
                      style={{ background: HAZARD_STYLE[h.group]?.color ?? "#7c8aa0" }}
                    />
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  {p.byHazard.map((h) => (
                    <span key={h.group} className="flex items-center gap-1.5 text-2xs text-text-2 tabular">
                      <span className="size-1.5 rounded-full" style={{ background: HAZARD_STYLE[h.group]?.color }} />
                      {HAZARD_STYLE[h.group]?.label ?? h.group} {pct(h.totalUsd / hazardTotal)}
                    </span>
                  ))}
                </div>
              </div>
            </Section>
            <Divider />

            <Section title="Hardest hit" aside={<span className="text-2xs text-text-3">Aid · FEMA households helped</span>}>
              <ul className="space-y-2">
                {topCounties.map((c, i) => (
                  <li key={c.fips}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="truncate text-text">
                        {c.name.replace(/ (County|Parish)$/, "")}, <span className="text-text-3">{c.state}</span>
                      </span>
                      <span className="shrink-0 tabular text-text-2">
                        {usdCompact(c.aidUsd)} <span className="text-text-3">· {c.femaApproved ? compact(c.femaApproved) : "none"}</span>
                      </span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                      <motion.div
                        className="h-full rounded-full bg-teal/80"
                        initial={{ width: 0 }}
                        animate={{ width: `${(100 * c.aidUsd) / maxCounty}%` }}
                        transition={{ duration: 0.8, delay: 0.04 * i, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
            <Divider />

            <Section title="Checked against FEMA">
              <div className="space-y-2.5 text-xs">
                {f.heldOutOverlap !== null && f.specRuleOverlap !== null && (
                  <Compare label="Match with FEMA's county split (never saw this storm)" ours={f.heldOutOverlap} theirs={f.specRuleOverlap} />
                )}
                {f.capturedShare !== null && (
                  <p className="leading-relaxed text-text-2">
                    Counties Rescu declares at landfall hold <span className="font-medium text-text tabular">{pct(f.capturedShare)}</span> of the{" "}
                    <span className="tabular">{int(f.approvedHouseholds)}</span> households FEMA approved weeks later.
                  </p>
                )}
              </div>
            </Section>
          </motion.div>
        </AnimatePresence>
      </Panel>
    </aside>
  );
}

function Compare({ label, ours, theirs }: { label: string; ours: number; theirs: number }) {
  return (
    <div>
      <div className="mb-1.5 text-text-3">{label}</div>
      {[
        { name: "Rescu", v: ours, cls: "bg-teal" },
        { name: "Wind-only rule", v: theirs, cls: "bg-text-3/60" },
      ].map((r) => (
        <div key={r.name} className="mb-1 flex items-center gap-2">
          <span className="w-24 shrink-0 text-text-2">{r.name}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <motion.div
              className={`h-full rounded-full ${r.cls}`}
              initial={{ width: 0 }}
              animate={{ width: `${r.v * 100}%` }}
              transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
          <span className="w-8 text-right tabular text-text-2">{r.v.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
