"use client";

import type { Order } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { reorder } from "@/lib/aid/actions";
import { ago } from "@/lib/aid/format";
import { api, ApiRequestError } from "@/lib/api";
import { useAid } from "./aid-context";
import { IconReceipt, IconRefresh } from "./icons";
import { OrderCard } from "./order-card";
import { EASE, Spinner, useMotion } from "./ui";

/** Every order, newest first. A blocked payment is unmistakable: that's the demo's climax. */
export function ReceiptsTab({ active }: { active: boolean }) {
  const { session } = useAid();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [again, setAgain] = useState<Order | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { reduce } = useMotion();

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setOrders(await api("GET /api/market/orders", { token: session.token }));
    } catch {
      // The wallet poll handles a dead session.
    }
  }, [session]);

  useEffect(() => {
    if (!active) return;
    void load();
    const id = setInterval(load, 2_000);
    return () => clearInterval(id);
  }, [active, load]);

  async function buyAgain(o: Order) {
    if (!session) return;
    setBusy(o.id);
    setError(null);
    try {
      const next = await reorder(session, o, "shop");
      setAgain(next);
      setOrders((list) => (list ? [next, ...list] : [next]));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't reorder");
    } finally {
      setBusy(null);
    }
  }

  const replace = (o: Order) => {
    setOrders((list) => list?.map((x) => (x.id === o.id ? o : x)) ?? null);
    if (again?.id === o.id) setAgain(o.status === "proposed" || o.status === "paying" ? o : null);
  };

  const visible = orders?.filter((o) => o.status !== "cancelled") ?? null;
  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain px-4 pb-6 pt-2">
      <div className="flex items-center justify-between px-1 pb-3">
        <h2 className="text-[20px] font-semibold tracking-tight">Receipts</h2>
        <span className="text-2xs text-text-3">{visible ? `${visible.length} ${visible.length === 1 ? "order" : "orders"}` : ""}</span>
      </div>
      {error && <p className="mb-3 rounded-xl bg-red-soft px-3 py-2 text-[13px] text-red">{error}</p>}
      {!visible && (
        <div className="grid h-40 place-items-center text-text-3">
          <Spinner />
        </div>
      )}
      {visible && !visible.length && (
        <div className="mt-16 flex flex-col items-center text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-surface-1 text-text-3">
            <IconReceipt size={26} />
          </span>
          <p className="mt-4 text-[14px] text-text-2">No orders yet</p>
          <p className="mt-1 max-w-[240px] text-[13px] text-text-3">Ask Grok or shop a store; receipts with their Solana transactions show up here.</p>
        </div>
      )}
      <div className="space-y-3">
        <AnimatePresence initial={false}>
          {visible?.map((o) => (
            <motion.div
              key={o.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
            >
              <OrderCard
                order={o}
                payer={o.origin === "agent" ? "agent" : "resident"}
                onChange={replace}
                compact={o.status !== "proposed" && o.status !== "rejected"}
                footer={
                  (o.status === "paid" || o.status === "rejected") && (
                    <div className="flex items-center justify-between border-t border-line px-4 py-2">
                      <span className="text-2xs text-text-3">{ago(o.paidAt ?? o.createdAt)}</span>
                      <button
                        onClick={() => buyAgain(o)}
                        disabled={busy !== null}
                        className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                      >
                        {busy === o.id ? <Spinner className="size-3.5" /> : <IconRefresh size={15} />} Buy again
                      </button>
                    </div>
                  )
                }
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
