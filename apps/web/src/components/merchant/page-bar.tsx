"use client";

import { RECOVERY_DAYS, type RunInfo } from "@rescu/live";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { formatClock, relative } from "@/lib/format";
import { LiveClient, useLive } from "@/lib/live";
import { AppNav } from "../ui/app-nav";
import { Wordmark } from "../ui/mark";
import { Badge, Dot } from "../ui/primitives";

/** One LiveClient per page (WebSocket to the sim server; honours ?server=). */
export function useLiveClient(): LiveClient {
  const live = useMemo(() => new LiveClient(), []);
  useEffect(() => {
    live.connect();
    return () => live.close();
  }, [live]);
  return live;
}

const PHASE: Record<RunInfo["phase"], { label: string; tone: "teal" | "amber" | "red" | "storm" | "neutral" }> = {
  live: { label: "Live", tone: "teal" },
  ready: { label: "Ready", tone: "storm" },
  staging: { label: "Preparing", tone: "neutral" },
  ended: { label: "Closed out", tone: "neutral" },
  offline: { label: "Offline", tone: "red" },
};

/** Sim date and "Day N of recovery", written to the DOM twice a second (no re-render). */
function SimTime({ live, landfall }: { live: LiveClient; landfall: number | null }) {
  const a = useRef<HTMLSpanElement>(null);
  const b = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const draw = () => {
      const t = live.driver.now();
      if (!Number.isFinite(t)) {
        if (a.current) a.current.textContent = "";
        if (b.current) b.current.textContent = "";
        return;
      }
      const c = formatClock(t, "America/New_York");
      if (a.current) a.current.textContent = `${c.date} · ${c.time}`;
      if (b.current && landfall) {
        const d = t - landfall;
        b.current.textContent = d < 86_400 ? `Landfall ${relative(-d)}` : `Day ${Math.floor(d / 86_400)} of recovery`;
      }
    };
    draw();
    const id = setInterval(draw, 500);
    return () => clearInterval(id);
  }, [live, landfall]);
  return (
    <div className="hidden flex-col items-end leading-tight md:flex">
      <span ref={a} className="text-xs font-medium tabular text-text" />
      <span ref={b} className="text-2xs tabular text-text-3" />
    </div>
  );
}

/** The shared top bar of the Merchant and Oracle pages: mark, page name, nav, the run and its clock. */
export function PageBar({ live, title, lead, children }: { live: LiveClient; title: string; lead?: string; children?: ReactNode }) {
  const run = useLive(live, (s) => s.run);
  // Aid expires on Day 30 after the main landfall.
  const landfall = run ? run.rules.expiresAt - RECOVERY_DAYS * 86_400 : null;
  const link = useLive(live, (s) => s.link);
  const phase = run ? PHASE[run.phase] : null;
  return (
    <div className="relative z-20 shrink-0">
      <header className="flex h-14 items-center gap-4 border-b border-line px-5">
        <Wordmark subtitle={title} />
        <AppNav className="ml-2" />
        <div className="flex-1" />
        {children}
        <div className="flex items-center gap-3">
          <SimTime live={live} landfall={landfall} />
          {link !== "open" ? (
            <Badge tone="amber">
              <Dot tone="amber" pulse /> {link === "connecting" ? "Connecting" : "Reconnecting"}
            </Badge>
          ) : run && phase ? (
            <Badge tone={phase.tone}>
              <Dot tone={phase.tone === "neutral" ? "neutral" : phase.tone} pulse={run.phase === "live"} />
              {run.stormName} · {phase.label}
            </Badge>
          ) : (
            <Badge>No relief network</Badge>
          )}
        </div>
      </header>
      {lead && (
        <p className="border-b border-line bg-surface-1/70 px-5 py-2 text-[12.5px] leading-[18px] text-text-2">{lead}</p>
      )}
    </div>
  );
}

/** Wraps a whole page: dark base, top bar, then the page's own layout filling the rest. */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-text">{children}</div>;
}
