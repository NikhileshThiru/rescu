import type { ActivityPage, StoreActivity } from "@rescu/live";

const KEEP = 80;
const PAGE = 50;

/** The last few things that happened at each store, for the merchant terminal (it polls with `since`). */
export class Activity {
  private seq = 0;
  private readonly rings: StoreActivity[][];

  constructor(stores: number) {
    this.rings = Array.from({ length: stores }, () => []);
  }

  push(m: number, e: Omit<StoreActivity, "seq">) {
    const ring = this.rings[m];
    if (!ring) return;
    ring.push({ ...e, seq: ++this.seq });
    if (ring.length > KEEP) ring.splice(0, ring.length - KEEP);
  }

  /** Newest first, only events after `since`. */
  page(m: number, since = 0): ActivityPage {
    const ring = this.rings[m] ?? [];
    const events: StoreActivity[] = [];
    for (let i = ring.length - 1; i >= 0 && events.length < PAGE; i--) {
      if (ring[i]!.seq <= since) break;
      events.push(ring[i]!);
    }
    return { seq: this.seq, events };
  }
}
