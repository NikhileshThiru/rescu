"use client";

import type { Order } from "@rescu/live";
import { useEffect, useState } from "react";
import { cents } from "@/lib/aid/format";
import { api } from "@/lib/api";
import { useAid } from "./aid-context";
import { OrderCard } from "./order-card";
import { Sheet } from "./sheet";
import { BigButton } from "./ui";

/**
 * `/aid?order=<id>`: a store rang up a counter sale and showed a QR. Once someone is signed in and
 * their aid has landed, a sheet asks them to pay it (their own key signs).
 */
export function CounterSheet() {
  const { session, wallet } = useAid();
  const [id, setId] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get("order"));
  }, []);

  useEffect(() => {
    if (!id) return;
    api("GET /api/market/orders/:id", { params: { id } })
      .then(setOrder)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  function close() {
    setOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("order");
    window.history.replaceState(null, "", url.toString());
  }

  if (!id || !open) return null;
  const ready = !!session && !!wallet?.aid.landed;
  if (!ready && !error) return null;
  const done = order && order.status !== "proposed" && order.status !== "paying";
  return (
    <Sheet open onClose={close} title={order ? (done ? (order.status === "paid" ? "Paid" : order.status === "rejected" ? "Payment blocked" : "Order") : `Pay ${order.storeName} ${cents(order.totalCents)}`) : "Store charge"}>
      {error && <p className="rounded-xl bg-red-soft px-3 py-2 text-[13px] text-red">{error}</p>}
      {order && (
        <>
          {!done && <p className="mb-3 px-1 text-[13px] leading-5 text-text-3">The store rang this up at the counter. Check the items, then pay with your relief dollars.</p>}
          {order.resident !== null && session && order.resident !== session.resident && order.status === "proposed" ? (
            <p className="rounded-xl bg-amber-soft px-3 py-2 text-[13px] text-amber">This charge belongs to someone else.</p>
          ) : (
            <OrderCard order={order} payer="resident" onChange={setOrder} />
          )}
        </>
      )}
      {(done || error) && (
        <BigButton tone="outline" className="mt-3" onClick={close}>
          Done
        </BigButton>
      )}
    </Sheet>
  );
}
