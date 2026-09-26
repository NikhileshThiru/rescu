/**
 * Every REST route the sim server exposes, with its request and response shapes. The server's
 * handlers and the web app's `api()` client are both typed from this table, so a route can't
 * drift between them. Resident routes marked `auth` take `Authorization: Bearer <Session.token>`.
 * Errors come back as a non-2xx status with an `ApiError` body.
 */
import type { BreakitState, BreakResult } from "./breakit";
import type {
  ActivityPage,
  AllowanceInput,
  AllowanceResult,
  CatalogItem,
  ChargeInput,
  ChatInput,
  ChatResult,
  ConfirmOrderInput,
  ConfirmResult,
  Eligibility,
  JoinInput,
  ListStoresInput,
  Listing,
  Offer,
  Order,
  Persona,
  ProposeOrderInput,
  RelayInput,
  RelayResult,
  SearchItemsInput,
  Session,
  SetPriceInput,
  StoreDetail,
  StoreSummary,
  WalletView,
} from "./market";
import type { ActionInput, OracleCase, OracleMetrics } from "./oracle";

/** Metaplex-style JSON behind the relief mint's `uri` (https://rescu.tech/api/token/<declaration id>.json). */
export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url: string;
  attributes: { trait_type: string; value: string }[];
}

export interface ApiError {
  error: string;
  /** Stable machine code: "not_found", "unauthorized", "no_run", "over_cap", "closed", "out_of_stock", ... or an on-chain rule name. */
  code: string | null;
}

type Route<Res, Body = never, Query = never, Auth extends boolean = false> = { res: Res; body: Body; query: Query; auth: Auth };

export interface ApiRoutes {
  // ---- Relief Market: residents (apps/web /aid) ----
  /** Six ready-made residents of the live run to demo with. */
  "GET /api/market/personas": Route<Persona[]>;
  /** Take over a persona: the sim stops shopping for it and this phone drives it. */
  "POST /api/market/personas/:resident/claim": Route<Session>;
  "GET /api/market/eligibility": Route<Eligibility, never, { lat: number; lon: number }>;
  /** "I live here": enroll the phone's key on-chain; aid lands when the storm reaches the spot (at once if it already has). */
  "POST /api/market/join": Route<Session, JoinInput>;
  "GET /api/market/wallet": Route<WalletView, never, never, true>;
  /** Grant (or revoke with 0) the agent's on-chain spending allowance. Device custody gets a SignRequest back. */
  "POST /api/market/agent/allowance": Route<AllowanceResult, AllowanceInput, never, true>;
  "POST /api/market/relay/:id": Route<RelayResult, RelayInput, never, true>;

  // ---- Relief Market: shopping (Shop tab, Grok, MCP) ----
  "GET /api/market/catalog": Route<CatalogItem[]>;
  "POST /api/market/search": Route<Offer[], SearchItemsInput, never, true>;
  "POST /api/market/stores": Route<StoreSummary[], ListStoresInput, never, true>;
  "GET /api/market/stores/:idx": Route<StoreDetail>;
  "POST /api/market/orders": Route<Order, ProposeOrderInput & { origin?: "shop" | "agent" }, never, true>;
  "GET /api/market/orders": Route<Order[], never, never, true>;
  /** Public so a counter QR can be shown before anyone scans it. */
  "GET /api/market/orders/:id": Route<Order>;
  /** Pay it. Also claims an unscanned counter charge for the caller. */
  "POST /api/market/orders/:id/confirm": Route<ConfirmResult, Omit<ConfirmOrderInput, "orderId">, never, true>;
  "POST /api/market/orders/:id/cancel": Route<Order, never, never, true>;
  "POST /api/market/agent/chat": Route<ChatResult, ChatInput, never, true>;

  // ---- Merchant terminal (/merchant) ----
  "GET /api/merchant/stores": Route<StoreSummary[], never, { q?: string; category?: string }>;
  "GET /api/merchant/stores/:idx": Route<StoreDetail>;
  "PATCH /api/merchant/stores/:idx/prices": Route<Listing, SetPriceInput>;
  "GET /api/merchant/stores/:idx/activity": Route<ActivityPage, never, { since?: number }>;
  /** Ring up a counter sale: returns a proposed order to show as a QR (`/aid?order=<id>`). */
  "POST /api/merchant/stores/:idx/charges": Route<Order, ChargeInput>;

  // ---- Oracle (/oracle and the Command Center rail) ----
  "GET /api/oracle/cases": Route<OracleCase[], never, { status?: string }>;
  "GET /api/oracle/cases/:id": Route<OracleCase>;
  "POST /api/oracle/cases/:id/actions": Route<OracleCase, ActionInput>;
  "GET /api/oracle/metrics": Route<OracleMetrics>;

  // ---- Token metadata (the relief mint's on-chain uri points here, for explorers and wallets) ----
  "GET /api/token/:file": Route<TokenMetadata>;

  // ---- Try to break it (Command Center drawer) ----
  "GET /api/breakit": Route<BreakitState>;
  "POST /api/breakit/:id": Route<BreakResult>;
}

export type ApiRoute = keyof ApiRoutes;

/**
 * Header carrying the presenter key on the routes that change the shared demo (oracle actions,
 * price edits at the terminal, "Try to break it"). Without it they answer 403 presenter_only when
 * the server has a key configured.
 */
export const PRESENTER_HEADER = "x-presenter-key";

/** MCP (Streamable HTTP, stateless) lives here; `Authorization: Bearer <Session.token>` picks the resident. */
export const MCP_PATH = "/mcp";

/** `/aid?order=<id>` opens a counter charge on the resident's phone. */
export function counterChargeUrl(origin: string, orderId: string): string {
  return `${origin.replace(/\/$/, "")}/aid?order=${encodeURIComponent(orderId)}`;
}
