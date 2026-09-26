/**
 * Relief Market: one catalog over every relief store in the run. People shop it in the resident
 * app (/aid); agents shop the same API through REST, MCP and Grok's tool calls. Money in this
 * file is always integer cents.
 */
import { z } from "zod";

export type MerchantCategory = "pharmacy" | "grocery" | "hardware" | "general";
export const CATEGORIES = ["pharmacy", "grocery", "hardware", "general"] as const satisfies readonly MerchantCategory[];

/** What a purchase is for. */
export type Need = "water" | "food" | "baby" | "medical" | "power" | "fuel" | "shelter" | "cleanup" | "hygiene" | "pet";
export const NEEDS = ["water", "food", "baby", "medical", "power", "fuel", "shelter", "cleanup", "hygiene", "pet"] as const satisfies readonly Need[];

/** Registered is not approved: pending stores can't take aid yet; suspended ones were stopped by the oracle. */
export type MerchantStatus = "pending" | "approved" | "suspended";

export interface CatalogItem {
  id: number;
  name: string;
  need: Need;
  /** Typical pre-storm shelf price. */
  baseCents: number;
  /** Most a household buys per order. */
  maxQty: number;
  sells: MerchantCategory[];
}

export interface StoreSummary {
  idx: number;
  /** Merchant wallet (base58); the merchant PDA is derived from it. */
  owner: string;
  name: string;
  category: MerchantCategory;
  /** "Lowndes, GA". */
  county: string;
  lat: number;
  lon: number;
  /** H3 res 5. */
  h3: string;
  status: MerchantStatus;
  /** An open oracle case names this store. */
  flagged: boolean;
  /** Open right now (the storm closes stores in the worst hexes, then they reopen). */
  open: boolean;
  /** Sim time the store reopens, when closed by the storm. */
  reopensAt: number | null;
  /** From the query point (or the resident's home); null without one. */
  distanceKm: number | null;
}

export interface Listing {
  itemId: number;
  name: string;
  need: Need;
  /** What the store charges now. */
  priceCents: number;
  /** The store's own shelf price before the storm (the oracle compares against the regional median). */
  preStormCents: number;
  stock: number;
  maxQty: number;
}

export interface StoreDetail extends StoreSummary {
  listings: Listing[];
  /** Relief dollars this store has taken in this run (landed payments). */
  salesCents: number;
  payments: number;
  blocked: number;
}

/** One item at one store, as search returns it. */
export interface Offer {
  store: StoreSummary;
  item: Listing;
}

export type OrderStatus = "proposed" | "paying" | "paid" | "rejected" | "cancelled";
/** Where an order came from: the Shop tab, Grok, an outside agent over MCP, or a store's counter QR. */
export type OrderOrigin = "shop" | "agent" | "mcp" | "counter";
/** Who signs the payment: the resident's own key, or the agent key spending its delegated allowance. */
export type PayerKind = "resident" | "agent";

export interface OrderLine {
  itemId: number;
  name: string;
  qty: number;
  unitCents: number;
}

export interface Order {
  id: string;
  runId: string;
  /** Null for a counter charge nobody has scanned yet. */
  resident: number | null;
  residentName: string | null;
  store: number;
  storeName: string;
  category: MerchantCategory;
  lines: OrderLine[];
  totalCents: number;
  origin: OrderOrigin;
  payer: PayerKind;
  status: OrderStatus;
  /** Wall ms. */
  createdAt: number;
  /** Sim time of the latest status change. */
  simT: number;
  pickup: { name: string; county: string; lat: number; lon: number; distanceKm: number | null };
  /** Resident's home [lon, lat] (for the map arc), null until a resident is attached. */
  home: [number, number] | null;
  /** Why the agent proposed it, in plain words. */
  note: string | null;
  signature: string | null;
  /** On-chain rule that rejected the payment, e.g. "MerchantSuspended". */
  rule: string | null;
  /** Plain-English reason for a rejection or a validation failure. */
  message: string | null;
  latencyMs: number | null;
  paidAt: number | null;
}

// ---------- residents ----------

/** Server custody: a simulated household's key (seeded). Device custody: the key never left the person's phone. */
export type Custody = "server" | "device";

export interface Persona {
  resident: number;
  name: string;
  /** One line: "Family of four in Valdosta; the power's been out since landfall." */
  blurb: string;
  county: string;
  lat: number;
  lon: number;
  size: number;
  kids: boolean;
  pet: boolean;
  aidCents: number;
  /** Sim time the storm reaches their home (aid is due). */
  aidDueAt: number;
  landed: boolean;
  /** Already being driven by someone's phone (the sim stopped shopping for it). */
  claimed: boolean;
  /** Suggested asks for the Ask tab. */
  prompts: string[];
}

export interface Session {
  token: string;
  resident: number;
  runId: string;
  custody: Custody;
}

export interface Eligibility {
  eligible: boolean;
  /** Why not, in plain words ("Outside the declared counties"). */
  reason: string | null;
  county: string | null;
  h3: string | null;
  aidCents: number;
  /** Sim time the storm reaches this spot (aid lands then). */
  aidDueAt: number | null;
  /** A nearby eligible spot to offer instead. */
  suggestion: { lat: number; lon: number; county: string } | null;
}

export const LatLon = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** "I live here": a person registers their own phone key at a spot in the storm zone. */
export const JoinInput = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  name: z.string().trim().min(1).max(40),
  /** Base58 ed25519 public key generated on the phone (WebCrypto, non-extractable). Null = server custody fallback. */
  pubkey: z.string().min(32).max(44).nullable(),
  /** Mock ID check. The oracle looks for the same device, phone or address across households. */
  identity: z.object({
    deviceId: z.string().min(8).max(64),
    phone: z.string().max(24).optional(),
    address: z.string().max(120).optional(),
  }),
});
export type JoinInput = z.infer<typeof JoinInput>;

export interface WalletView {
  runId: string;
  resident: number;
  owner: string;
  name: string;
  custody: Custody;
  home: { lat: number; lon: number; county: string; h3: string };
  household: { size: number; kids: boolean; pet: boolean };
  aid: {
    cents: number;
    landed: boolean;
    /** Sim time the storm reaches their home. */
    dueAt: number;
    landedAt: number | null;
    signature: string | null;
    /** Storm reaching their hex -> aid confirmed in the wallet, real ms. */
    timeToAidMs: number | null;
  };
  /** Read from the chain (token account), not from the sim's books. */
  balanceCents: number;
  spentCents: number;
  /** The chain's rolling 24 h cap, as the sim's clock sees it. */
  window: { spentCents: number; capCents: number; remainingCents: number; perOrderCapCents: number };
  agent: { approved: boolean; allowanceCents: number; signature: string | null };
  frozen: boolean;
  /** An open oracle case names this resident. */
  flagged: boolean;
  /** Sim time aid expires (Day 30); unspent aid returns to the treasury. */
  expiresAt: number;
  simNow: number;
}

/** A transaction the phone must sign (device custody): sign `messageB64` with the resident key, POST the signature to the relay. */
export interface SignRequest {
  id: string;
  purpose: "approve_agent" | "pay";
  /** Base64 of the serialized legacy transaction message (fee payer = relayer). */
  messageB64: string;
  /** Base58 key that must sign. */
  signer: string;
  orderId: string | null;
  /** Wall ms; the blockhash goes stale after that. */
  expiresAt: number;
}

export interface ConfirmResult {
  order: Order;
  /** Device custody paying as the resident: sign this, then POST it to the relay. */
  sign: SignRequest | null;
}

export const RelayInput = z.object({ signatureB64: z.string().min(80).max(100) });
export type RelayInput = z.infer<typeof RelayInput>;

export interface RelayResult {
  ok: boolean;
  signature: string | null;
  rule: string | null;
  message: string | null;
  order: Order | null;
  wallet: WalletView | null;
}

export const AllowanceInput = z.object({
  /** 0 revokes. At most the $200 order cap... the chain enforces the caps on top either way. */
  allowanceCents: z.number().int().min(0).max(100_000),
});
export type AllowanceInput = z.infer<typeof AllowanceInput>;

export interface AllowanceResult {
  wallet: WalletView | null;
  sign: SignRequest | null;
}

// ---------- agent (Grok) ----------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Orders the assistant proposed in this message (ids). */
  orders?: string[];
}

export const ChatInput = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2_000), orders: z.array(z.string()).optional() }))
    .min(1)
    .max(24),
});
export type ChatInput = z.infer<typeof ChatInput>;

export interface ChatResult {
  reply: string;
  /** Proposed in this turn; the resident confirms each one (Grok never pays by itself). */
  orders: Order[];
  /** What Grok looked up, for the "thinking" chips. */
  tools: { name: string; summary: string }[];
  model: string;
  /** True when the spend limit or an API error sent us to the scripted planner. */
  fallback: boolean;
  usage: { inputTokens: number; outputTokens: number; usd: number };
}

// ---------- tool inputs (REST bodies, MCP tools and Grok function calls share these) ----------

export const SearchItemsInput = z.object({
  query: z.string().max(80).optional().describe("Free text, e.g. 'water', 'insulin', 'diapers'"),
  need: z.enum(NEEDS).optional().describe("Filter by need"),
  category: z.enum(CATEGORIES).optional().describe("Filter by store type"),
  near: LatLon.optional().describe("Search around this point; defaults to the resident's home"),
  openOnly: z.boolean().optional().describe("Only stores open right now (default true)"),
  limit: z.number().int().min(1).max(25).optional().describe("Max offers (default 8)"),
});
export type SearchItemsInput = z.infer<typeof SearchItemsInput>;

export const ListStoresInput = z.object({
  query: z.string().max(80).optional().describe("Store name contains"),
  category: z.enum(CATEGORIES).optional(),
  near: LatLon.optional().describe("Defaults to the resident's home"),
  openOnly: z.boolean().optional().describe("Default true"),
  limit: z.number().int().min(1).max(50).optional().describe("Default 10"),
});
export type ListStoresInput = z.infer<typeof ListStoresInput>;

export const GetStoreInput = z.object({ store: z.number().int().min(0).describe("Store index from search results") });
export type GetStoreInput = z.infer<typeof GetStoreInput>;

export const OrderLineInput = z.object({
  itemId: z.number().int().min(0),
  qty: z.number().int().min(1).max(20),
});

export const ProposeOrderInput = z.object({
  store: z.number().int().min(0).describe("One store per order (pickup there)"),
  lines: z.array(OrderLineInput).min(1).max(12),
  note: z.string().max(280).optional().describe("Why this basket, in one plain sentence for the resident"),
});
export type ProposeOrderInput = z.infer<typeof ProposeOrderInput>;

export const ConfirmOrderInput = z.object({
  orderId: z.string().min(1).max(64),
  /** Default "agent" over MCP, "resident" in the Shop tab. */
  payer: z.enum(["resident", "agent"]).optional(),
});
export type ConfirmOrderInput = z.infer<typeof ConfirmOrderInput>;

export const ListOrdersInput = z.object({ limit: z.number().int().min(1).max(50).optional() });
export type ListOrdersInput = z.infer<typeof ListOrdersInput>;

export const GetWalletInput = z.object({});

/**
 * The Relief Market's tools. Grok gets all but `confirm_order` (the resident taps Confirm in the
 * app); MCP clients get all of them, and `confirm_order` pays through the agent's on-chain
 * allowance, inside the same per-order and 24 h caps.
 */
export const MARKET_TOOLS = {
  get_wallet: {
    description: "The resident's relief wallet: balance, what they can still spend in the rolling 24 h window, the per-order cap, the agent's remaining allowance, and home location.",
    input: GetWalletInput,
  },
  search_items: {
    description: "Find items at nearby relief stores (nearest first), with each store's current price and stock. Use before proposing an order.",
    input: SearchItemsInput,
  },
  list_stores: {
    description: "Nearby registered relief stores, nearest first, with open/closed status.",
    input: ListStoresInput,
  },
  get_store: {
    description: "One store's full shelf: every item with price and stock.",
    input: GetStoreInput,
  },
  propose_order: {
    description: "Put together an order at ONE store for the resident to review. Nothing is paid until the resident confirms. Must fit the per-order cap, the 24 h window and the stock.",
    input: ProposeOrderInput,
  },
  confirm_order: {
    description: "Pay a proposed order from the resident's wallet using the agent's delegated allowance. The chain enforces the caps and the allowance.",
    input: ConfirmOrderInput,
  },
  list_orders: {
    description: "The resident's recent orders and receipts, with on-chain signatures.",
    input: ListOrdersInput,
  },
} as const;
export type MarketToolName = keyof typeof MARKET_TOOLS;

// ---------- merchant terminal ----------

export const SetPriceInput = z.object({
  itemId: z.number().int().min(0),
  priceCents: z.number().int().min(1).max(500_000),
});
export type SetPriceInput = z.infer<typeof SetPriceInput>;

export const ChargeInput = z.object({
  lines: z.array(OrderLineInput).min(1).max(12),
});
export type ChargeInput = z.infer<typeof ChargeInput>;

export type ActivityKind = "payment" | "blocked" | "price" | "status" | "order";

/** One row on the merchant terminal: sim shoppers and app orders alike. */
export interface StoreActivity {
  seq: number;
  kind: ActivityKind;
  /** Wall ms. */
  at: number;
  simT: number;
  cents: number;
  lines: OrderLine[];
  resident: number | null;
  residentName: string | null;
  origin: FeedOrigin;
  signature: string | null;
  rule: string | null;
  /** Free text: "Bottled water, 24-pack: $5.99 -> $24.99", "Suspended by the oracle". */
  detail: string;
}

export interface ActivityPage {
  seq: number;
  events: StoreActivity[];
}

/** Who started it. The sim's households are "sim"; everything else came from a person, an agent or the oracle. */
export type FeedOrigin = "sim" | "shop" | "agent" | "mcp" | "counter" | "join" | "oracle" | "breakit";
