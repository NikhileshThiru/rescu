"use client";

import {
  type ClientMsg,
  type ClockState,
  clockAt,
  type FeedItem,
  type Kpis,
  type LiveBatch,
  type MerchantDot,
  type RunInfo,
  type ServerMsg,
  type SpendSeries,
  WS_PATH,
} from "@rescu/live";
import { useSyncExternalStore } from "react";
import type { ClockDriver } from "./clock";

export type LinkStatus = "connecting" | "open" | "closed";

export interface LiveState {
  link: LinkStatus;
  run: RunInfo | null;
  kpis: Kpis | null;
  series: SpendSeries | null;
  merchants: { runId: string; list: MerchantDot[] } | null;
  /** Newest first, revealed one at a time so the eye can follow. */
  feed: FeedItem[];
  /** Viewing the network as of an earlier moment. */
  history: boolean;
  /** Last error the server sent back (e.g. "A relief network is live for ..."). */
  error: string | null;
}

/** One more than the rail shows, so the row that drops off can fade out. */
const FEED_MAX = 6;
const FEED_REVEAL_MS = 380;
const FEED_QUEUE_MAX = 10;
/** A scrub within this many sim seconds of the live head counts as "back to live". */
const HEAD_SNAP_SECS = 90;
const SEEK_DEBOUNCE_MS = 220;

export function liveUrl(): string {
  const env = process.env.NEXT_PUBLIC_WS_URL;
  if (env) return env;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:4000${WS_PATH}`;
}

/**
 * The Command Center's link to the live network: one WebSocket with reconnect, server clock
 * offset from ping/pong, an external store for React, and a batch stream for the map.
 */
export class LiveClient {
  state: LiveState = { link: "connecting", run: null, kpis: null, series: null, merchants: null, feed: [], history: false, error: null };
  /** Called when the server's play state or speed changes (SimClock.driverChanged). */
  onClock: (() => void) | null = null;

  private listeners = new Set<() => void>();
  private batchListeners = new Set<(b: LiveBatch, runId: string) => void>();
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private feedTimer?: ReturnType<typeof setInterval>;
  private seekTimer?: ReturnType<typeof setTimeout>;
  private errorTimer?: ReturnType<typeof setTimeout>;
  private feedQueue: FeedItem[] = [];
  /** Server wall clock minus ours (ms), from the lowest-latency ping. */
  private offset = 0;
  private samples: { rtt: number; offset: number }[] = [];
  private server: ClockState | null = null;
  /** Optimistic clock after a local control, until the server confirms (or 1.5 s pass). */
  private local: { clock: ClockState; until: number } | null = null;
  private serverHead = 0;

  constructor(private readonly url: () => string = liveUrl) {}

  connect() {
    this.stopped = false;
    this.open();
    this.feedTimer ??= setInterval(() => this.revealFeed(), FEED_REVEAL_MS);
  }

  close() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.feedTimer);
    this.feedTimer = undefined;
    this.ws?.close();
    this.ws = null;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  onBatch(fn: (b: LiveBatch, runId: string) => void) {
    this.batchListeners.add(fn);
    return () => this.batchListeners.delete(fn);
  }

  // ---------- commands ----------

  stage(slug: string) {
    this.send({ type: "stage", slug });
  }

  declare(t: number, speed: number) {
    this.send({ type: "declare", t, speed, playing: true });
  }

  reset() {
    this.send({ type: "reset" });
  }

  backToLive() {
    this.send({ type: "history", t: null });
  }

  /** Where the live network is in sim time (null when not following a run). */
  head(): number | null {
    return this.server ? this.liveHead() : null;
  }

  /** The live network drives the SimClock through this while a run is live or closed out. */
  readonly driver: ClockDriver = {
    now: () => {
      const c = this.clock();
      return c ? clockAt(c, this.serverNow()) : Number.NaN;
    },
    playing: () => this.clock()?.playing ?? false,
    speed: () => this.clock()?.speed ?? 5760,
    play: () => {
      this.optimistic({ playing: true });
      this.send({ type: "play" });
    },
    pause: () => {
      this.optimistic({ playing: false });
      this.send({ type: "pause" });
    },
    setSpeed: (speed) => {
      this.optimistic({ speed });
      this.send({ type: "speed", speed });
    },
    seek: (t) => {
      // Hold the playhead where the presenter put it; the server decides once the scrub settles.
      this.optimistic({ t, playing: false });
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => {
        const head = this.liveHead();
        if (t < head - HEAD_SNAP_SECS) this.send({ type: "history", t });
        else if (t > head + HEAD_SNAP_SECS) this.send({ type: "seek", t });
        else this.send({ type: "history", t: null });
      }, SEEK_DEBOUNCE_MS);
    },
  };

  // ---------- internals ----------

  private serverNow() {
    return Date.now() + this.offset;
  }

  private clock(): ClockState | null {
    if (this.local && Date.now() > this.local.until) this.local = null;
    return this.local?.clock ?? this.server;
  }

  private liveHead() {
    if (!this.server) return 0;
    return this.state.history ? this.serverHead : clockAt(this.server, this.serverNow());
  }

  private optimistic(patch: Partial<ClockState>) {
    const c = this.clock();
    if (!c) return;
    const now = this.serverNow();
    this.local = { clock: { ...c, t: clockAt(c, now), at: now, ...patch }, until: Date.now() + 1500 };
    this.onClock?.();
  }

  private open() {
    if (this.stopped) return;
    this.set({ link: "connecting" });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.samples = [];
      this.set({ link: "open" });
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 5_000);
    };
    ws.onmessage = (e) => {
      try {
        this.handle(JSON.parse(String(e.data)) as ServerMsg);
      } catch (err) {
        console.error("live: bad message", err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      this.server = null;
      this.local = null;
      this.set({ link: "closed" });
      this.onClock?.();
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(8_000, 500 * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private ping() {
    this.send({ type: "ping", client: Date.now() });
  }

  private handle(msg: ServerMsg) {
    switch (msg.type) {
      case "hello":
        this.offset = msg.serverTime - Date.now();
        this.set({ run: msg.run, error: null });
        if (msg.clock) this.setServerClock(msg.clock, false, msg.clock.t);
        return;
      case "pong": {
        const rtt = Date.now() - msg.client;
        this.samples.push({ rtt, offset: msg.server - (msg.client + rtt / 2) });
        if (this.samples.length > 10) this.samples.shift();
        this.offset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
        return;
      }
      case "run": {
        const prev = this.state.run;
        const next = msg.run;
        const newRun = !prev || !next || prev.id !== next.id;
        this.set({
          run: next,
          ...(newRun ? { kpis: null, series: null, feed: [], history: false } : {}),
        });
        if (newRun) this.feedQueue = [];
        if (next?.phase !== "live" && next?.phase !== "ended") {
          this.server = null;
          this.local = null;
          this.onClock?.();
        }
        return;
      }
      case "clock":
        this.setServerClock(msg.clock, msg.history, msg.head);
        return;
      case "merchants":
        this.set({ merchants: { runId: msg.runId, list: msg.merchants } });
        return;
      case "kpis":
        if (msg.runId === this.state.run?.id) this.set({ kpis: msg.kpis });
        return;
      case "series":
        if (msg.runId === this.state.run?.id) this.set({ series: msg.series });
        return;
      case "batch":
        if (msg.runId !== this.state.run?.id) return;
        for (const item of msg.batch.feed) this.queueFeed(item);
        for (const fn of this.batchListeners) fn(msg.batch, msg.runId);
        return;
      case "error":
        this.set({ error: msg.message });
        clearTimeout(this.errorTimer);
        this.errorTimer = setTimeout(() => this.set({ error: null }), 6_000);
        return;
    }
  }

  private setServerClock(clock: ClockState, history: boolean, head: number) {
    this.server = clock;
    this.local = null;
    this.serverHead = head;
    if (history !== this.state.history) this.set({ history });
    this.onClock?.();
  }

  private queueFeed(item: FeedItem) {
    // Treasury events jump the queue; the queue stays short so the feed never lags the network.
    if (item.kind === "fund" || item.kind === "clawback") this.feedQueue.unshift(item);
    else this.feedQueue.push(item);
    while (this.feedQueue.length > FEED_QUEUE_MAX) {
      const drop = this.feedQueue.findIndex((f) => f.kind === "payment" || f.kind === "aid");
      this.feedQueue.splice(drop >= 0 ? drop : 0, 1);
    }
  }

  private revealFeed() {
    const item = this.feedQueue.shift();
    if (item) this.set({ feed: [item, ...this.state.feed].slice(0, FEED_MAX) });
  }

  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
}

/** Subscribe a component to one slice of the live state (return a stable value from `select`). */
export function useLive<T>(live: LiveClient, select: (s: LiveState) => T): T {
  return useSyncExternalStore(
    live.subscribe,
    () => select(live.state),
    () => select(live.state),
  );
}
