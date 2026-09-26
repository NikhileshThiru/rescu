import { type ClockState, clockAt } from "@rescu/live";

/** Sim time for a live run. The web app's SimClock follows this over the WebSocket. */
export class ServerClock {
  private s: ClockState;
  /** Wall time (ms) of the last re-anchor that changed the flow of time (play, seek, speed). */
  lastChangeMs: number;

  constructor(start: number, end: number, speed: number) {
    this.s = { t: start, at: Date.now(), speed, playing: false, start, end };
    this.lastChangeMs = this.s.at;
  }

  now(): number {
    return clockAt(this.s, Date.now());
  }

  get state(): ClockState {
    return { ...this.s };
  }

  get playing() {
    return this.s.playing;
  }

  get speed() {
    return this.s.speed;
  }

  get end() {
    return this.s.end;
  }

  set(t: number, speed: number, playing: boolean) {
    const at = Date.now();
    this.s = { ...this.s, t: Math.min(this.s.end, Math.max(this.s.start, t)), at, speed, playing };
    this.lastChangeMs = at;
  }

  play() {
    this.set(this.now(), this.s.speed, true);
  }

  pause() {
    this.set(this.now(), this.s.speed, false);
  }

  setSpeed(speed: number) {
    this.set(this.now(), speed, this.s.playing);
  }

  seek(t: number) {
    this.set(t, this.s.speed, this.s.playing);
  }

  /** Wall time (ms) when the clock passed sim time `simT`, never before the last re-anchor. */
  wallTimeOf(simT: number): number {
    const now = Date.now();
    if (!this.s.playing || simT >= this.now()) return now;
    const wall = this.s.at + ((simT - this.s.t) / this.s.speed) * 1000;
    return Math.max(this.lastChangeMs, Math.min(now, wall));
  }
}
