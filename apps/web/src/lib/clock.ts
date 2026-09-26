"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Sim seconds per real second. 1440 = one sim day per real minute (the chain's default). */
export const SPEEDS = [
  { scale: 1440, label: "1×", hint: "1 day per minute" },
  { scale: 5760, label: "4×", hint: "1 day per 15 s" },
  { scale: 17280, label: "12×", hint: "1 day per 5 s" },
] as const;

type Listener = () => void;

/**
 * Something else that owns time (the live network's server clock). While attached, the SimClock
 * follows it every frame and forwards play, pause, speed and seek to it.
 */
export interface ClockDriver {
  /** NaN until the driver knows the time. */
  now(): number;
  playing(): boolean;
  speed(): number;
  play(): void;
  pause(): void;
  setSpeed(scale: number): void;
  seek(t: number): void;
}

/**
 * The one clock everything on the Command Center runs on. `tick` is called from a single
 * requestAnimationFrame loop; per-frame readers subscribe with `onFrame` and write to the DOM or
 * deck.gl directly, so React only re-renders on coarse changes (play, speed, storm, driver).
 */
export class SimClock {
  t = 0;
  start = 0;
  end = 1;
  playing = false;
  speed: number = SPEEDS[1].scale;
  /** Increments on every change of time. */
  frame = 0;
  driver: ClockDriver | null = null;
  private coarse = new Set<Listener>();
  private frameListeners = new Set<(t: number) => void>();
  private version = 0;

  setDomain(start: number, end: number, t = start) {
    this.start = start;
    this.end = end;
    this.moveTo(t);
    this.emitCoarse();
  }

  /** Hand time to a driver (the live network), or take it back with null. */
  attach(driver: ClockDriver | null) {
    if (driver === this.driver) return;
    this.driver = driver;
    if (driver) {
      this.playing = driver.playing();
      this.speed = driver.speed();
      const t = driver.now();
      if (Number.isFinite(t)) this.moveTo(t);
    } else this.playing = false;
    this.emitCoarse();
  }

  /** The driver's play state or speed changed. */
  driverChanged() {
    const d = this.driver;
    if (!d) return;
    if (d.playing() === this.playing && d.speed() === this.speed) return;
    this.playing = d.playing();
    this.speed = d.speed();
    this.emitCoarse();
  }

  seek(t: number) {
    const clamped = Math.min(this.end, Math.max(this.start, t));
    this.driver?.seek(clamped);
    this.moveTo(clamped);
  }

  tick(dtRealSec: number) {
    if (this.driver) {
      const t = this.driver.now();
      if (Number.isFinite(t) && t !== this.t) this.moveTo(t);
      return;
    }
    if (!this.playing) return;
    const next = this.t + dtRealSec * this.speed;
    if (next >= this.end) {
      this.moveTo(this.end);
      this.setPlaying(false);
      return;
    }
    this.moveTo(next);
  }

  setPlaying(p: boolean) {
    if (this.driver) {
      if (p) this.driver.play();
      else this.driver.pause();
    } else if (p && this.t >= this.end) this.moveTo(this.start);
    this.playing = p;
    this.emitCoarse();
  }

  setSpeed(s: number) {
    this.driver?.setSpeed(s);
    this.speed = s;
    this.emitCoarse();
  }

  onFrame(fn: (t: number) => void): () => void {
    this.frameListeners.add(fn);
    fn(this.t);
    return () => this.frameListeners.delete(fn);
  }

  subscribe = (fn: Listener) => {
    this.coarse.add(fn);
    return () => this.coarse.delete(fn);
  };

  getVersion = () => this.version;

  private moveTo(t: number) {
    this.t = Math.min(this.end, Math.max(this.start, t));
    this.frame++;
    for (const l of this.frameListeners) l(this.t);
  }

  private emitCoarse() {
    this.version++;
    for (const l of this.coarse) l();
  }
}

/** Re-renders on play/pause/speed/domain/driver changes only. */
export function useClockState(clock: SimClock) {
  useSyncExternalStore(clock.subscribe, clock.getVersion, clock.getVersion);
  return { playing: clock.playing, speed: clock.speed, start: clock.start, end: clock.end, driven: !!clock.driver };
}

/** Clock time sampled at most `hz` times a second, for text readouts. */
export function useClockTime(clock: SimClock, hz = 8): number {
  const [t, setT] = useState(clock.t);
  const last = useRef(0);
  useEffect(() => {
    return clock.onFrame((now) => {
      const wall = performance.now();
      if (wall - last.current < 1000 / hz && clock.playing) return;
      last.current = wall;
      setT(now);
    });
  }, [clock, hz]);
  return t;
}
