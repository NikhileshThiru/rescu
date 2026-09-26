/**
 * Sliding-window limits for the Grok agent: a few turns per resident and a global ceiling, so a
 * stuck client (or a curious judge with a script) can't burn the $25 of credits.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private all: number[] = [];

  constructor(
    readonly perKey = 10,
    readonly global = 40,
    readonly windowMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a turn and returns true, or returns false (and records nothing) when over a limit. */
  take(key: string): boolean {
    const t = this.now();
    const cut = t - this.windowMs;
    this.all = this.all.filter((x) => x > cut);
    const mine = (this.hits.get(key) ?? []).filter((x) => x > cut);
    if (mine.length >= this.perKey || this.all.length >= this.global) {
      this.hits.set(key, mine);
      return false;
    }
    mine.push(t);
    this.hits.set(key, mine);
    this.all.push(t);
    if (this.hits.size > 5_000) for (const [k, v] of this.hits) if (!v.some((x) => x > cut)) this.hits.delete(k);
    return true;
  }

  /** Seconds until the next turn is allowed for this key. */
  retryAfter(key: string): number {
    const t = this.now();
    const cut = t - this.windowMs;
    const mine = (this.hits.get(key) ?? []).filter((x) => x > cut);
    const all = this.all.filter((x) => x > cut);
    const waits: number[] = [];
    if (mine.length >= this.perKey) waits.push(mine[mine.length - this.perKey]! + this.windowMs - t);
    if (all.length >= this.global) waits.push(all[all.length - this.global]! + this.windowMs - t);
    return Math.max(1, Math.ceil(Math.max(0, ...waits) / 1000));
  }
}
