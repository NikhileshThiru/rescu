import type { CatalogItem, Listing, ListStoresInput, MerchantStatus, Offer, OrderLine, SearchItemsInput, StoreDetail, StoreState, StoreSummary } from "@rescu/live";
import { ALL_ITEMS, GENERATOR, type Item, shelfCents, STOCK } from "../catalog.js";
import { Rng } from "../rng.js";
import { countyLabel, isOpen, type World } from "../world.js";

const DAY = 86_400;
const MAX_ITEMS = 64;
/** Items a planted gouger marks up once the storm has hit. */
export const GOUGE_NEEDS = new Set(["water", "food", "power", "fuel", "baby"]);

const key = (m: number, itemId: number) => m * MAX_ITEMS + itemId;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** "$24.99"-style: rounded to 10 cents, minus one. */
const shelfRound = (cents: number) => Math.max(9, Math.round(cents / 10) * 10 - 1);

/**
 * The run's stores as a market: what each shelf carries, the price it charges now (pre-storm
 * shelf price, a planted gouger's markup, or whatever the merchant terminal set), stock that
 * sells down and restocks daily, and each store's status and oracle flag.
 */
export class Market {
  readonly status: MerchantStatus[];
  readonly caseOf: (string | null)[];
  readonly salesCents: Float64Array;
  readonly payments: Uint32Array;
  readonly blocked: Uint32Array;
  /** Price overrides from the merchant terminal. */
  private readonly overrides = new Map<number, number>();
  /** Every listed-price change, per store+item (the oracle's evidence series). */
  private readonly changes = new Map<number, { simT: number; priceCents: number }[]>();
  private readonly par: Uint16Array;
  private readonly sold: Uint16Array;
  private readonly restockDay: Int32Array;

  constructor(
    readonly world: World,
    /** Merchant wallet (base58) by store index; empty until staging derives the keys. */
    private readonly owner: (m: number) => string,
    seed: string,
  ) {
    const n = world.merchants.n;
    this.status = new Array<MerchantStatus>(n).fill("approved");
    this.caseOf = new Array<string | null>(n).fill(null);
    this.salesCents = new Float64Array(n);
    this.payments = new Uint32Array(n);
    this.blocked = new Uint32Array(n);
    this.par = new Uint16Array(n * MAX_ITEMS);
    this.sold = new Uint16Array(n * MAX_ITEMS);
    this.restockDay = new Int32Array(n).fill(-1);
    const rng = new Rng(`stock:${seed}`);
    for (let m = 0; m < n; m++) for (const item of this.shelf(m)) this.par[key(m, item.id)] = item === GENERATOR ? rng.int(2, 6) : rng.int(30, 160);
  }

  get n() {
    return this.world.merchants.n;
  }

  // ---------- shelves and prices ----------

  /** What a store carries. Hardware stores also sell the (over-cap) generator. */
  shelf(m: number): Item[] {
    const cat = this.world.merchants.category[m]!;
    return cat === "hardware" ? [...STOCK[cat], GENERATOR] : STOCK[cat];
  }

  carries(m: number, itemId: number): boolean {
    return this.shelf(m).some((i) => i.id === itemId);
  }

  /** The store's own pre-storm shelf price. */
  preStorm(m: number, itemId: number): number {
    const item = ALL_ITEMS[itemId];
    if (!item) throw new Error(`unknown item ${itemId}`);
    return item === GENERATOR ? GENERATOR.cents : shelfCents(m, item);
  }

  /** The planted markup in force at sim time t (1 = none). */
  gougeAt(m: number, itemId: number, t: number): number {
    const M = this.world.merchants;
    const from = M.gougeFrom[m]!;
    if (Number.isNaN(from) || t < from || M.gouge[m] === 1) return 1;
    const item = ALL_ITEMS[itemId];
    return item && GOUGE_NEEDS.has(item.need) && item !== GENERATOR ? M.gouge[m]! : 1;
  }

  /** What the store charges now: the terminal's override, else the pre-storm price times any planted markup. */
  price(m: number, itemId: number, t: number): number {
    const o = this.overrides.get(key(m, itemId));
    if (o !== undefined) return o;
    const pre = this.preStorm(m, itemId);
    const g = this.gougeAt(m, itemId, t);
    return g === 1 ? pre : shelfRound(pre * g);
  }

  /** The merchant terminal set this item's price (it wins over any planted markup). */
  hasOverride(m: number, itemId: number): boolean {
    return this.overrides.has(key(m, itemId));
  }

  /** Sets a listed price (merchant terminal). Returns the previous price. */
  setPrice(m: number, itemId: number, cents: number, t: number): number {
    const before = this.price(m, itemId, t);
    this.overrides.set(key(m, itemId), cents);
    this.noteChange(m, itemId, t, cents);
    return before;
  }

  /** Records a listed-price change for the evidence series (also used when a planted markup kicks in). */
  noteChange(m: number, itemId: number, t: number, cents: number) {
    const k = key(m, itemId);
    let list = this.changes.get(k);
    if (!list) {
      list = [{ simT: this.world.domain.start, priceCents: this.preStorm(m, itemId) }];
      this.changes.set(k, list);
    }
    list.push({ simT: t, priceCents: cents });
  }

  /** The store's listed price over sim time, as steps (pre-storm price first). */
  priceSeries(m: number, itemId: number, t: number): { simT: number; priceCents: number }[] {
    const out = [...(this.changes.get(key(m, itemId)) ?? [{ simT: this.world.domain.start, priceCents: this.preStorm(m, itemId) }])];
    // A planted markup with no recorded change yet still shows as a step.
    const from = this.world.merchants.gougeFrom[m]!;
    if (!this.overrides.has(key(m, itemId)) && !Number.isNaN(from) && from <= t && this.gougeAt(m, itemId, t) !== 1 && !out.some((p) => p.simT === from)) {
      out.push({ simT: from, priceCents: this.price(m, itemId, t) });
    }
    out.sort((a, b) => a.simT - b.simT);
    out.push({ simT: t, priceCents: this.price(m, itemId, t) });
    return out;
  }

  // ---------- stock ----------

  private rollover(m: number, t: number) {
    const day = Math.floor(t / DAY);
    if (this.restockDay[m] === day) return;
    this.restockDay[m] = day;
    this.sold.fill(0, m * MAX_ITEMS, (m + 1) * MAX_ITEMS);
  }

  stock(m: number, itemId: number, t: number): number {
    this.rollover(m, t);
    const k = key(m, itemId);
    return Math.max(0, this.par[k]! - this.sold[k]!);
  }

  /** Books a landed sale: stock sells down, the store's takings go up. */
  recordSale(m: number, lines: { itemId: number; qty: number }[], cents: number, t: number) {
    if (m < 0 || m >= this.n) return;
    this.rollover(m, t);
    for (const l of lines) {
      const k = key(m, l.itemId);
      this.sold[k] = Math.min(this.par[k]!, this.sold[k]! + l.qty);
    }
    this.salesCents[m]! += cents;
    this.payments[m]!++;
  }

  recordBlocked(m: number) {
    if (m >= 0 && m < this.n) this.blocked[m]!++;
  }

  // ---------- status ----------

  isOpen(m: number, t: number) {
    return isOpen(this.world, m, t);
  }

  setStatus(m: number, status: MerchantStatus): StoreState {
    this.status[m] = status;
    return this.state(m);
  }

  setFlag(m: number, caseId: string | null): StoreState {
    this.caseOf[m] = caseId;
    return this.state(m);
  }

  state(m: number): StoreState {
    return { idx: m, status: this.status[m]!, flagged: this.caseOf[m] !== null, caseId: this.caseOf[m]! };
  }

  /** Stores that aren't plain "approved, not flagged". */
  nonDefaultStates(): StoreState[] {
    const out: StoreState[] = [];
    for (let m = 0; m < this.n; m++) if (this.status[m] !== "approved" || this.caseOf[m] !== null) out.push(this.state(m));
    return out;
  }

  // ---------- views ----------

  listing(m: number, item: Item, t: number): Listing {
    return { itemId: item.id, name: item.name, need: item.need, priceCents: this.price(m, item.id, t), preStormCents: this.preStorm(m, item.id), stock: this.stock(m, item.id, t), maxQty: item.maxQty };
  }

  listings(m: number, t: number): Listing[] {
    return this.shelf(m).map((item) => this.listing(m, item, t));
  }

  summary(m: number, t: number, near?: { lat: number; lon: number }): StoreSummary {
    const M = this.world.merchants;
    const open = this.isOpen(m, t);
    const reopens = M.reopensAt[m]!;
    return {
      idx: m,
      owner: this.owner(m),
      name: M.name[m]!,
      category: M.category[m]!,
      county: countyLabel(this.world, M.county[m]!),
      lat: M.lat[m]!,
      lon: M.lon[m]!,
      h3: M.h3[m]!,
      status: this.status[m]!,
      flagged: this.caseOf[m] !== null,
      open,
      reopensAt: !open && !Number.isNaN(reopens) ? reopens : null,
      distanceKm: near ? Math.round(haversineKm(near.lat, near.lon, M.lat[m]!, M.lon[m]!) * 10) / 10 : null,
    };
  }

  detail(m: number, t: number, near?: { lat: number; lon: number }): StoreDetail {
    return { ...this.summary(m, t, near), listings: this.listings(m, t), salesCents: this.salesCents[m]!, payments: this.payments[m]!, blocked: this.blocked[m]! };
  }

  /** Stores nearest first. Suspended and pending stores are left out unless `includeAll`. */
  stores(q: ListStoresInput & { includeAll?: boolean }, t: number, home?: { lat: number; lon: number }): StoreSummary[] {
    const near = q.near ?? home;
    const text = q.query?.trim().toLowerCase();
    const M = this.world.merchants;
    const out: StoreSummary[] = [];
    for (let m = 0; m < this.n; m++) {
      if (!q.includeAll && this.status[m] !== "approved") continue;
      if (q.category && M.category[m] !== q.category) continue;
      if (text && !M.name[m]!.toLowerCase().includes(text)) continue;
      if ((q.openOnly ?? true) && !this.isOpen(m, t)) continue;
      out.push(this.summary(m, t, near));
    }
    if (near) out.sort((a, b) => a.distanceKm! - b.distanceKm!);
    else out.sort((a, b) => a.name.localeCompare(b.name));
    return out.slice(0, q.limit ?? 10);
  }

  /** Items matching the query at approved stores, nearest store first, then cheapest. In stock only. */
  search(q: SearchItemsInput, t: number, home?: { lat: number; lon: number }): Offer[] {
    const near = q.near ?? home;
    const words = (q.query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
      .map((w) => w.replace(/(es|s)$/, ""));
    const matches = (item: Item) => {
      if (q.need && item.need !== q.need) return false;
      if (!words.length) return true;
      const name = item.name.toLowerCase();
      return words.some((w) => name.includes(w) || item.need.startsWith(w) || SYNONYMS[w]?.includes(item.id));
    };
    const M = this.world.merchants;
    const stores: { m: number; d: number }[] = [];
    for (let m = 0; m < this.n; m++) {
      if (this.status[m] !== "approved") continue;
      if (q.category && M.category[m] !== q.category) continue;
      if ((q.openOnly ?? true) && !this.isOpen(m, t)) continue;
      stores.push({ m, d: near ? haversineKm(near.lat, near.lon, M.lat[m]!, M.lon[m]!) : 0 });
    }
    stores.sort((a, b) => a.d - b.d);
    const limit = q.limit ?? 8;
    const out: Offer[] = [];
    for (const { m } of stores) {
      const items = this.shelf(m).filter(matches);
      if (!items.length) continue;
      const summary = this.summary(m, t, near);
      const listed = items.map((i) => this.listing(m, i, t)).filter((l) => l.stock > 0);
      listed.sort((a, b) => a.priceCents - b.priceCents);
      for (const item of listed) {
        out.push({ store: summary, item });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Prices the lines at this store now, clamped to shelf and stock. Throws a readable reason. */
  priceLines(m: number, lines: { itemId: number; qty: number }[], t: number): OrderLine[] {
    return lines.map((l) => {
      const item = ALL_ITEMS[l.itemId];
      if (!item || !this.carries(m, l.itemId)) throw new MarketError("not_carried", `${this.world.merchants.name[m]} doesn't carry item ${l.itemId}`);
      const stock = this.stock(m, l.itemId, t);
      if (stock < l.qty) throw new MarketError("out_of_stock", `Only ${stock} ${item.name} left at ${this.world.merchants.name[m]}`);
      return { itemId: item.id, name: item.name, qty: l.qty, unitCents: this.price(m, item.id, t) };
    });
  }

  static catalog(): CatalogItem[] {
    return ALL_ITEMS.map((i) => ({ id: i.id, name: i.name, need: i.need, baseCents: i.cents, maxQty: i.maxQty, sells: i === GENERATOR ? ["hardware"] : i.sells }));
  }
}

export class MarketError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Words people use that aren't in the item names. */
const SYNONYMS: Record<string, number[]> = (() => {
  const id = (name: string) => ALL_ITEMS.findIndex((i) => i.name.startsWith(name));
  return {
    med: [id("Pain reliever"), id("Prescription"), id("Insulin"), id("First aid"), id("Bandages")],
    medicine: [id("Pain reliever"), id("Prescription"), id("Insulin")],
    prescription: [id("Prescription"), id("Insulin")],
    refill: [id("Prescription"), id("Insulin")],
    drink: [id("Bottled water"), id("Water, 1-gallon")],
    power: [id("AA batteries"), id("D batteries"), id("LED flashlight"), id("Battery lantern"), id("Phone power bank")],
    light: [id("LED flashlight"), id("Battery lantern")],
    gas: [id("Fuel, per gallon"), id("Gas can"), id("Propane")],
    roof: [id("Tarp"), id("Plywood"), id("Roofing nails"), id("Duct tape")],
    baby: [id("Baby formula"), id("Diapers"), id("Baby wipes")],
    dog: [id("Pet food")],
    cat: [id("Pet food")],
    clean: [id("Bleach"), id("Mold cleaner"), id("Contractor trash bags"), id("Work gloves")],
  };
})();
