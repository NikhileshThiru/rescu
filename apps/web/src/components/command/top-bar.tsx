"use client";

import { useEffect, useRef } from "react";
import { SPEEDS, type SimClock, useClockState } from "@/lib/clock";
import { formatClock, relative, usd } from "@/lib/format";
import { type LiveClient, useLive } from "@/lib/live";
import type { StormListing, Timeline } from "@/lib/storm-data";
import { AppNav } from "../ui/app-nav";
import { Wordmark } from "../ui/mark";
import { NumberTicker } from "../ui/number-ticker";
import { Badge, Button, cx, Dot, Kbd, Segmented } from "../ui/primitives";
import { ShieldIcon } from "./breakit-drawer";
import { ScanToJoin } from "./scan-to-join";

export function Logo({ compact }: { compact?: boolean } = {}) {
  return <Wordmark subtitle="Command Center" compact={compact} />;
}

function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="3" y="2.5" width="2.6" height="9" rx="0.8" fill="currentColor" />
      <rect x="8.4" y="2.5" width="2.6" height="9" rx="0.8" fill="currentColor" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M4 2.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L4.9 2.1a.6.6 0 0 0-.9.5z" fill="currentColor" />
    </svg>
  );
}

/** Sim date/time written straight to the DOM every frame. */
function ClockReadout({ clock, timeline }: { clock: SimClock; timeline: Timeline | null }) {
  const date = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const rel = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!timeline) return;
    let lastMinute = -1;
    return clock.onFrame((t) => {
      const minute = Math.floor(t / 60);
      if (minute === lastMinute) return;
      lastMinute = minute;
      const c = formatClock(t, timeline.timeZone);
      if (date.current) date.current.textContent = c.date;
      if (time.current) time.current.textContent = `${c.time} ${c.zone}`;
      if (rel.current) {
        const d = t - timeline.landfall;
        rel.current.textContent = d < 86400 ? `Landfall ${relative(-d)}` : `Day ${Math.floor(d / 86400)} of recovery`;
      }
    });
  }, [clock, timeline]);
  return (
    <div className="flex min-w-[220px] flex-col items-start leading-tight">
      <div className="flex items-baseline gap-2">
        <span ref={date} className="text-sm font-medium tabular" />
        <span ref={time} className="text-sm text-text-2 tabular" />
      </div>
      <span ref={rel} className="text-2xs text-text-3 tabular" />
    </div>
  );
}

export function TopBar({
  storms,
  slug,
  onStorm,
  clock,
  timeline,
  live,
  breakitOpen,
  onBreakit,
  qrOpen,
  onQr,
}: {
  /** Legacy: the storm picker now lives in MapControls; pass these to keep it here. */
  storms?: StormListing[];
  slug?: string;
  onStorm?: (slug: string) => void;
  clock: SimClock;
  timeline: Timeline | null;
  live: LiveClient;
  breakitOpen?: boolean;
  onBreakit?: () => void;
  qrOpen?: boolean;
  onQr?: (open: boolean) => void;
}) {
  const { playing, speed, driven } = useClockState(clock);
  const presenter = useLive(live, (s) => s.presenter);
  // A live network's clock is the presenter's; viewers see it but can't steer it.
  const locked = driven && !presenter;
  return (
    <header className="glass pointer-events-auto absolute inset-x-0 top-0 z-20 flex h-14 items-center gap-5 border-b border-line px-4">
      <Logo compact />
      <AppNav />
      {storms && slug && onStorm && (
        <Segmented
          value={slug}
          onChange={onStorm}
          options={storms.map((s) => ({
            value: s.slug,
            label: (
              <>
                {s.name}
                <span className="text-text-3 tabular">{s.year}</span>
              </>
            ),
          }))}
        />
      )}
      <div className="mx-auto flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => clock.setPlaying(!playing)}
          disabled={locked}
          title={locked ? "View only: the presenter controls the clock" : undefined}
          className="rounded-full"
        >
          <PlayIcon playing={playing} />
        </Button>
        <ClockReadout clock={clock} timeline={timeline} />
        <Segmented
          size="sm"
          value={speed}
          onChange={(s) => clock.setSpeed(s)}
          options={SPEEDS.map((s) => ({ value: s.scale, label: s.label, title: s.hint }))}
          className={locked ? "pointer-events-none opacity-40" : undefined}
        />
        <span className="hidden items-center gap-1 text-2xs text-text-3 2xl:flex">
          <Kbd>Space</Kbd> play
        </span>
      </div>
      <div className="flex items-center gap-2">
        {onBreakit && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBreakit}
            aria-pressed={!!breakitOpen}
            title="Try to break it (B)"
            className={cx("h-8 gap-2 pl-2.5 pr-2", breakitOpen && "border-red/40 bg-red-soft text-text")}
          >
            <ShieldIcon className="text-red" />
            <span>Try to break it</span>
            <Kbd>B</Kbd>
          </Button>
        )}
        {onQr && <ScanToJoin open={!!qrOpen} onOpenChange={onQr} />}
      </div>
      <Treasury live={live} />
    </header>
  );
}

/** What's left in the relief treasury: counts down as aid lands, back up when Day 30 returns the rest. */
function Treasury({ live }: { live: LiveClient }) {
  const link = useLive(live, (s) => s.link);
  const run = useLive(live, (s) => s.run);
  const treasury = useLive(live, (s) => s.kpis?.treasuryUsd ?? null);
  const history = useLive(live, (s) => s.history);
  const funded = !!run?.funded && treasury !== null;

  const badge =
    link !== "open" || run?.phase === "offline" ? (
      <Badge tone="red">Offline</Badge>
    ) : history ? (
      <Badge tone="amber">History</Badge>
    ) : run?.phase === "live" ? (
      <Badge tone="teal">
        <Dot tone="teal" pulse /> Live
      </Badge>
    ) : run?.phase === "ended" ? (
      <Badge>Closed out</Badge>
    ) : run?.phase === "ready" ? (
      <Badge tone="teal">Ready</Badge>
    ) : run?.phase === "staging" ? (
      <Badge tone="amber">Preparing</Badge>
    ) : (
      <Badge>Standby</Badge>
    );

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-[96px] text-right leading-tight">
        <div className="eyebrow">Treasury{run && funded ? ` · ${run.stormName}` : ""}</div>
        {funded && run?.phase === "live" && !history && (treasury ?? 0) < 0.5 ? (
          <div className="text-sm font-medium text-text-2">All aid out</div>
        ) : funded ? (
          <NumberTicker value={treasury ?? 0} format={usd} className="text-sm font-medium text-text" />
        ) : (
          <div className="text-sm font-medium tabular text-text-2">Not funded</div>
        )}
      </div>
      {badge}
    </div>
  );
}
