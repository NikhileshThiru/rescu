import type { FeedOrigin, OrderLine, StoreState } from "@rescu/live";

/**
 * What a Run emits besides `info` and `clock`, for the oracle engine and anything else that
 * watches the network. Listeners attach per run: a new run (reset / another storm) is a new
 * emitter, so re-attach on `sim.on("run")` when `sim.run` changes.
 */
export interface NetworkEvents {
  info: [];
  clock: [];
  /** Every payment attempt that reached the chain (sim households and app residents alike). */
  payment: [PaymentEvent];
  /** A store's listed price changed (the merchant terminal, or a planted gouger's markup kicking in). */
  price: [PriceEvent];
  /** Someone registered a phone ("I live here"). Sim households are in `world.households` from the start. */
  join: [JoinEvent];
  /** A store's status or oracle flag changed. */
  store: [StoreState];
  /** A resident's wallet was frozen/thawed or flagged. */
  resident: [ResidentEvent];
}

export interface PaymentEvent {
  seq: number;
  /** Wall ms. */
  at: number;
  simT: number;
  resident: number;
  /** Store index, -1 when the destination isn't a registered store (resale / unregistered). */
  merchant: number;
  cents: number;
  lines: OrderLine[];
  ok: boolean;
  /** On-chain rule that rejected it. */
  rule: string | null;
  origin: FeedOrigin;
  signature: string | null;
  orderId: string | null;
}

export interface PriceEvent {
  merchant: number;
  itemId: number;
  fromCents: number;
  toCents: number;
  simT: number;
  at: number;
  by: "merchant" | "planted";
}

export interface JoinEvent {
  resident: number;
  name: string;
  lat: number;
  lon: number;
  county: string;
  aidCents: number;
  identity: { device: string; phone: string; address: string };
  simT: number;
  at: number;
}

export interface ResidentEvent {
  resident: number;
  frozen: boolean;
  caseId: string | null;
  signature: string | null;
}
