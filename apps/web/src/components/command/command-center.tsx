"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SimClock } from "@/lib/clock";
import { LiveClient, useLive } from "@/lib/live";
import { LiveEffects } from "@/lib/live-effects";
import { buildTimeline, DEMO_STORMS, loadStorm, type StormFile, type Timeline } from "@/lib/storm-data";
import { Panel } from "../ui/primitives";
import { BreakitDrawer } from "./breakit-drawer";
import { HexTooltip } from "./hex-tooltip";
import { MapControls } from "./map-controls";
import { type HexHover, type LayerMode, MapView, type MapViewHandle } from "./map-view";
import { RightRail } from "./right-rail";
import { TimelineBar } from "./timeline-bar";
import { TopBar } from "./top-bar";

const INTRO_DELAY_MS = 700;
const INTRO_FLY_MS = 4200;
const SWITCH_FLY_MS = 2600;

/** Hover lives outside React state so moving the mouse re-renders only the tooltip. */
export interface HoverStore {
  get: () => HexHover | null;
  set: (h: HexHover | null) => void;
  subscribe: (fn: () => void) => () => void;
}

function createHoverStore(): HoverStore {
  let value: HexHover | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (h) => {
      if (h === value || (h && value && h.index === value.index && h.x === value.x && h.y === value.y)) return;
      value = h;
      for (const fn of subs) fn();
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function CommandCenter() {
  const [clock] = useState(() => new SimClock());
  const [slug, setSlug] = useState(DEMO_STORMS[0]!.slug);
  const [file, setFile] = useState<StormFile | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [mode, setMode] = useState<LayerMode>("wind");
  const [res, setRes] = useState(5);
  const [hover] = useState(createHoverStore);
  const [mapReady, setMapReady] = useState(false);
  const [cameraAuto, setCameraAuto] = useState(true);
  const [breakit, setBreakit] = useState(false);
  const [qr, setQr] = useState(false);
  const map = useRef<MapViewHandle>(null);
  const flown = useRef<string | null>(null);
  const [live] = useState(() => new LiveClient());
  const [effects] = useState(() => new LiveEffects(live));

  useEffect(() => {
    live.onClock = () => clock.driverChanged();
    live.connect();
    const detach = effects.attach();
    return () => {
      detach();
      live.onClock = null;
      live.close();
    };
  }, [live, clock, effects]);

  useEffect(() => {
    effects.slug = file?.storm.slug ?? null;
    effects.clear();
  }, [effects, file]);

  // While the live network runs this storm, the server owns time; otherwise the replay is local.
  const drive = useLive(live, (s) => {
    const r = s.run;
    return s.link === "open" && !!r && r.slug === slug && (r.phase === "live" || r.phase === "ended");
  });
  const loaded = file?.storm.slug === slug && timeline !== null;
  useEffect(() => {
    const next = drive && loaded ? live.driver : null;
    const was = clock.driver;
    clock.attach(next);
    // A finished run hands time back parked at Day 30; rewind so the next declaration has a storm to follow.
    if (was && !next && clock.t >= clock.end) clock.seek(clock.start);
  }, [drive, loaded, clock, live]);

  useEffect(() => {
    let cancelled = false;
    if (!clock.driver) clock.setPlaying(false);
    loadStorm(slug).then((f) => {
      if (cancelled) return;
      const tl = buildTimeline(f);
      clock.setDomain(tl.start, tl.end, tl.start);
      setTimeline(tl);
      setFile(f);
      hover.set(null);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, clock, hover]);

  // Fly in once per storm: from the US on first load, region to region after.
  useEffect(() => {
    if (!mapReady || !file || flown.current === file.storm.slug) return;
    const first = flown.current === null;
    flown.current = file.storm.slug;
    const fly = first ? INTRO_FLY_MS : SWITCH_FLY_MS;
    const t1 = setTimeout(() => map.current?.introduce(file, { duration: fly }), first ? INTRO_DELAY_MS : 0);
    const t2 = setTimeout(() => !clock.driver && clock.setPlaying(true), (first ? INTRO_DELAY_MS : 0) + fly * 0.8);
    // Warm the other storms once the intro is done, so switching never waits on the network.
    const t3 = setTimeout(() => DEMO_STORMS.forEach((s) => void loadStorm(s.slug)), INTRO_DELAY_MS + fly + 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [mapReady, file, clock]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __rescu: unknown }).__rescu = { clock, live, effects, setMode, setRes, setSlug };
  }, [clock, live, effects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "b" || e.key === "B") {
        setBreakit((o) => !o);
        setQr(false);
        return;
      }
      if (e.key === "q" || e.key === "Q") {
        setQr((o) => !o);
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        clock.setPlaying(!clock.playing);
      } else if (e.key === "w") setMode("wind");
      else if (e.key === "a") setMode("aid");
      else if (e.key === "ArrowRight" && !(e.target instanceof HTMLElement && e.target.getAttribute("role") === "slider")) {
        clock.seek(clock.t + (e.shiftKey ? 6 : 1) * 3600);
      } else if (e.key === "ArrowLeft" && !(e.target instanceof HTMLElement && e.target.getAttribute("role") === "slider")) {
        clock.seek(clock.t - (e.shiftKey ? 6 : 1) * 3600);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clock]);

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg">
      <MapView
        ref={map}
        file={file}
        res={res}
        mode={mode}
        clock={clock}
        effects={effects}
        onHover={hover.set}
        onReady={() => setMapReady(true)}
        onCameraAuto={setCameraAuto}
      />

      {/* Soft edge vignette so panels sit on a calm frame. */}
      <div className="pointer-events-none absolute inset-0 z-[5] bg-[radial-gradient(ellipse_at_center,transparent_60%,rgba(4,6,12,0.32)_100%)]" />

      <TopBar
        clock={clock}
        timeline={timeline}
        live={live}
        breakitOpen={breakit}
        onBreakit={() => {
          setBreakit((o) => !o);
          setQr(false);
        }}
        qrOpen={qr}
        onQr={setQr}
      />

      <AnimatePresence>
        {file && timeline && (
          <motion.div
            key="chrome"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="pointer-events-none absolute inset-0 z-10"
          >
            <MapControls
              storms={DEMO_STORMS}
              slug={slug}
              onStorm={setSlug}
              mode={mode}
              onMode={setMode}
              res={res}
              onRes={setRes}
              cameraAuto={cameraAuto}
              onFollow={() => map.current?.follow()}
            />
            <RightRail file={file} clock={clock} timeline={timeline} live={live} onStorm={setSlug} />
            <div className="pointer-events-auto absolute inset-x-4 bottom-4">
              <Panel>
                <TimelineBar clock={clock} timeline={timeline} storm={file.storm} live={live} />
              </Panel>
            </div>
            <HexTooltip store={hover} file={file} clock={clock} />
            <BreakitDrawer open={breakit} onClose={() => setBreakit(false)} live={live} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!mapReady && (
          <motion.div
            key="boot"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8 }}
            className="absolute inset-0 z-40 grid place-items-center bg-bg"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="size-6 animate-spin rounded-full border-2 border-teal/20 border-t-teal" />
              <span className="eyebrow">Loading the map</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
