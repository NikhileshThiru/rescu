/**
 * Wire protocol between the sim server (apps/server) and the web app. JSON over one WebSocket.
 * The server owns sim time while a run is live; clients interpolate from `ClockState`.
 */

/** The server's clock, anchored at server wall time `at`. */
export interface ClockState {
  /** Sim time (unix seconds) at `at`. */
  t: number;
  /** Server wall clock (ms) when this state was anchored. */
  at: number;
  /** Sim seconds per real second. */
  speed: number;
  playing: boolean;
  start: number;
  end: number;
}

/** Sim time at a server wall time (ms). */
export function clockAt(c: ClockState, serverNowMs: number): number {
  if (!c.playing) return c.t;
  return Math.min(c.end, Math.max(c.start, c.t + ((serverNowMs - c.at) / 1000) * c.speed));
}

/**
 * staging: building the declaration, merchants and household registrations on-chain.
 * ready: staged, waiting for an official to declare. live: aid and payments flowing.
 * ended: Day 30 passed and unspent aid was returned. offline: the chain or database is down.
 */
export type RunPhase = "offline" | "staging" | "ready" | "live" | "ended";

export interface RunInfo {
  /** Declaration id (u64 as a string). */
  id: string;
  slug: string;
  stormName: string;
  phase: RunPhase;
  /** Staging progress, or why the network is offline. */
  progress: { label: string; done: number; total: number } | null;
  error: string | null;
  /** Households on-chain (a sample of the full-scale allocation, same distribution). */
  households: number;
  fullScaleHouseholds: number;
  merchants: number;
  budgetUsd: number;
  funded: boolean;
  fundSignature: string | null;
  mint: string;
  declaration: string;
  rules: { perOrderCapUsd: number; dailyCapUsd: number; expiresAt: number };
  /** Query string that points Solana Explorer at our validator. */
  explorerCluster: string;
}

export interface Kpis {
  /** Sim time the numbers describe: the live head, or the point being viewed in history. */
  simT: number;
  history: boolean;
  disbursedUsd: number;
  householdsPaid: number;
  treasuryUsd: number;
  returnedUsd: number;
  spentUsd: number;
  payments: number;
  blocked: number;
  blockedBy: { rule: string; count: number }[];
  /** Confirmed transactions per second over the last few seconds (all kinds). */
  txPerSec: number;
  /** Transactions per second, one value per second for the last minute, oldest first. */
  txSeries: number[];
  /** Storm reaching a household's hex -> aid confirmed in its wallet, real milliseconds. */
  timeToAidMs: { p50: number; p95: number } | null;
  paymentLatencyMs: number | null;
  spentByCategory: { category: string; usd: number }[];
  tiger: { ok: boolean; rowsPerSec: number; rows: number; queryMs: number; compressionPct: number | null };
}

/** Spending and aid over sim time, for the timeline. */
export interface SpendSeries {
  t0: number;
  /** Bucket width, sim seconds. */
  step: number;
  spentUsd: number[];
  aidUsd: number[];
}

export type FeedKind = "aid" | "payment" | "blocked" | "fund" | "clawback";

export interface FeedItem {
  kind: FeedKind;
  signature: string;
  simT: number;
  usd: number;
  title: string;
  detail: string;
  /** On-chain rule name when rejected. */
  rule: string | null;
  latencyMs: number;
}

export type MerchantCategory = "pharmacy" | "grocery" | "hardware" | "general";

export interface MerchantDot {
  idx: number;
  name: string;
  category: MerchantCategory;
  lon: number;
  lat: number;
  /** Closed by the storm between these sim times (null = never closed). */
  closedFrom: number | null;
  reopensAt: number | null;
}

export interface LiveBatch {
  /** Aid that landed per hex (H3 res 5) since the last batch. */
  aid: { h3: string; usd: number; households: number }[];
  /** A capped sample of payments since the last batch, for arcs: [lon, lat] pairs. */
  pays: { from: [number, number]; to: [number, number]; usd: number; ok: boolean; merchant: number }[];
  feed: FeedItem[];
}

export type ServerMsg =
  | { type: "hello"; serverTime: number; run: RunInfo | null; clock: ClockState | null }
  | { type: "run"; run: RunInfo | null }
  /** `head` is the live network's sim time; while `history` is on, the clock shows an earlier moment. */
  | { type: "clock"; clock: ClockState; history: boolean; head: number }
  | { type: "merchants"; runId: string; merchants: MerchantDot[] }
  | { type: "kpis"; runId: string; kpis: Kpis }
  | { type: "series"; runId: string; series: SpendSeries }
  | { type: "batch"; runId: string; batch: LiveBatch }
  | { type: "pong"; client: number; server: number }
  | { type: "error"; message: string };

export type ClientMsg =
  | { type: "ping"; client: number }
  /** Prepare a run for this storm (no-op if it's already staged or live). */
  | { type: "stage"; slug: string }
  /** Declare and fund; the run starts from the presenter's current replay position. */
  | { type: "declare"; t: number; speed: number; playing: boolean }
  | { type: "play" }
  | { type: "pause" }
  | { type: "speed"; speed: number }
  /** Forward only: the chain can't rewind. */
  | { type: "seek"; t: number }
  /** View the network as of sim time t (pauses the run); null returns to live. */
  | { type: "history"; t: number | null }
  /** Drop the current run and stage a fresh one. */
  | { type: "reset" };

// ---------- shared storm timing (the map and the sim must agree to the second) ----------

export const RECOVERY_DAYS = 30;
/** Rain-only hexes (no tropical-storm wind) get their aid this long after the main landfall. */
export const RAIN_ONLY_AID_DELAY = 12 * 3600;

interface TrackLike {
  points: { t: number; lon: number }[];
  landfalls: { t: number; lon: number; vmax: number | null }[];
}

/** The strongest landfall, or the first fix when the storm never made landfall. */
export function mainLandfall(storm: TrackLike): { t: number; lon: number } {
  const lfs = storm.landfalls;
  if (!lfs.length) return { t: storm.points[0]!.t, lon: storm.points[0]!.lon };
  return lfs.reduce((a, b) => ((b.vmax ?? 0) > (a.vmax ?? 0) ? b : a));
}

/**
 * The replay's domain: from 72 h before the main landfall (or a day before the first landfall,
 * whichever is earlier, never before the track starts) to Day 30 of recovery.
 */
export function timelineDomain(storm: TrackLike) {
  const pts = storm.points;
  const trackStart = pts[0]!.t;
  const trackEnd = pts[pts.length - 1]!.t;
  const main = mainLandfall(storm);
  const first = storm.landfalls.length ? storm.landfalls[0]!.t : main.t;
  const start = Math.max(trackStart, Math.min(first - 24 * 3600, main.t - 72 * 3600));
  const end = main.t + RECOVERY_DAYS * 86400;
  return { start, end, trackStart, trackEnd: Math.min(trackEnd, end), landfall: main.t, landfallLon: main.lon };
}

/**
 * When a hex's aid lands: when tropical-storm winds reach it, else at its peak wind, else (rain
 * only) half a day after the main landfall. Times are unix seconds, -1 = never.
 */
export function aidArrival(t34: number, peak: number, landfall: number): number {
  if (t34 >= 0) return t34;
  if (peak >= 0) return peak;
  return landfall + RAIN_ONLY_AID_DELAY;
}

export const WS_PATH = "/ws";

export function explorerTx(signature: string, cluster: string): string {
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

export function explorerAddress(address: string, cluster: string): string {
  return `https://explorer.solana.com/address/${address}${cluster}`;
}
