"use client";

import type { Order, Session, WalletView } from "@rescu/live";
import { api } from "../api";
import { keyId, loadDeviceKey, signMessage } from "./keys";

/**
 * Money moves. Device custody: the server hands back a SignRequest, the phone signs it with its
 * own key and posts the signature to the relay. Server custody (demo residents) pays directly.
 */

async function phoneSign(session: Session, sign: { id: string; messageB64: string }) {
  const keys = await loadDeviceKey(keyId(session.runId, session.resident));
  if (!keys) throw new Error("This phone's wallet key is missing. Register again from this browser.");
  const signatureB64 = await signMessage(keys, sign.messageB64);
  return api("POST /api/market/relay/:id", { params: { id: sign.id }, body: { signatureB64 }, token: session.token });
}

/** Pays a proposed order; resolves to the order as the chain left it (paid or rejected). */
export async function payOrder(session: Session, orderId: string, payer: "resident" | "agent"): Promise<Order> {
  const res = await api("POST /api/market/orders/:id/confirm", { params: { id: orderId }, body: { payer }, token: session.token });
  if (!res.sign) return res.order;
  const relayed = await phoneSign(session, res.sign);
  return relayed.order ?? res.order;
}

/** Grants (or revokes with 0) Grok's on-chain spending allowance. */
export async function setAllowance(session: Session, allowanceCents: number): Promise<WalletView | null> {
  const res = await api("POST /api/market/agent/allowance", { body: { allowanceCents }, token: session.token });
  if (!res.sign) return res.wallet;
  const relayed = await phoneSign(session, res.sign);
  if (!relayed.ok) throw new Error(relayed.message ?? "The chain refused the allowance");
  return relayed.wallet;
}

/** Proposes the same lines at the same store again ("Buy again"). */
export function reorder(session: Session, o: Order, origin: "shop" | "agent" = "shop"): Promise<Order> {
  return api("POST /api/market/orders", {
    body: { store: o.store, lines: o.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })), origin, note: o.note ?? undefined },
    token: session.token,
  });
}
