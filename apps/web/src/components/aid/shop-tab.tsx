"use client";

import { type Listing, type Need, NEEDS, type Offer, type Order, type StoreSummary } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "@/components/ui/primitives";
import { cents, km } from "@/lib/aid/format";
import { api, ApiRequestError } from "@/lib/api";
import { useAid } from "./aid-context";
import { IconMinus, IconPlus, IconSearch } from "./icons";
import { OrderCard } from "./order-card";
import { Sheet } from "./sheet";
import { BigButton, CategoryDot, EASE, Pill, Spinner, useMotion } from "./ui";

const NEED_LABEL: Record<Need, string> = {
  water: "Water",
  food: "Food",
  baby: "Baby",
  medical: "Medicine",
  power: "Power",
  fuel: "Fuel",
  shelter: "Shelter",
  cleanup: "Cleanup",
  hygiene: "Hygiene",
  pet: "Pet",
};

interface Cart {
  store: StoreSummary;
  lines: { item: Listing; qty: number }[];
}

export function ShopTab({ active, onReceipts }: { active: boolean; onReceipts: () => void }) {
  const { session } = useAid();
  const [query, setQuery] = useState("");
  const [need, setNeed] = useState<Need | null>(null);
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [proposing, setProposing] = useState(false);
  const { reduce } = useMotion();
  const reqId = useRef(0);

  useEffect(() => {
    if (!active || !session) return;
    const id = ++reqId.current;
    const t = setTimeout(
      async () => {
        setLoading(true);
        try {
          const res = await api("POST /api/market/search", { body: { ...(query.trim() ? { query: query.trim() } : {}), ...(need ? { need } : {}), limit: 25 }, token: session.token });
          if (id === reqId.current) {
            setOffers(res);
            setError(null);
          }
        } catch (err) {
          if (id === reqId.current) setError((err as Error).message);
        } finally {
          if (id === reqId.current) setLoading(false);
        }
      },
      query ? 280 : 0,
    );
    return () => clearTimeout(t);
  }, [query, need, active, session]);

  const groups = useMemo(() => {
    const m = new Map<number, { store: StoreSummary; items: Listing[] }>();
    for (const o of offers ?? []) {
      const g = m.get(o.store.idx) ?? { store: o.store, items: [] };
      g.items.push(o.item);
      m.set(o.store.idx, g);
    }
    return [...m.values()];
  }, [offers]);

  function qtyOf(store: number, itemId: number) {
    return cart && cart.store.idx === store ? (cart.lines.find((l) => l.item.itemId === itemId)?.qty ?? 0) : 0;
  }

  function change(store: StoreSummary, item: Listing, delta: number) {
    setNotice(null);
    setCart((c) => {
      let next: Cart = c && c.store.idx === store.idx ? { store, lines: [...c.lines] } : { store, lines: [] };
      if (c && c.store.idx !== store.idx && c.lines.length) setNotice(`One store per order: your cart moved to ${store.name}.`);
      const i = next.lines.findIndex((l) => l.item.itemId === item.itemId);
      const q = Math.max(0, Math.min(item.maxQty, item.stock, (i >= 0 ? next.lines[i]!.qty : 0) + delta));
      if (i >= 0) next.lines[i] = { item, qty: q };
      else if (q > 0) next.lines.push({ item, qty: q });
      next = { ...next, lines: next.lines.filter((l) => l.qty > 0) };
      return next.lines.length ? next : null;
    });
  }

  const total = cart?.lines.reduce((a, l) => a + l.qty * l.item.priceCents, 0) ?? 0;
  const count = cart?.lines.reduce((a, l) => a + l.qty, 0) ?? 0;

  async function review() {
    if (!cart || !session) return;
    setProposing(true);
    setNotice(null);
    try {
      const o = await api("POST /api/market/orders", {
        body: { store: cart.store.idx, lines: cart.lines.map((l) => ({ itemId: l.item.itemId, qty: l.qty })), origin: "shop" },
        token: session.token,
      });
      setOrder(o);
    } catch (err) {
      setNotice(err instanceof ApiRequestError ? err.message : "Couldn't place that order");
    } finally {
      setProposing(false);
    }
  }

  function closeSheet() {
    if (order && (order.status === "paid" || order.status === "rejected")) setCart(null);
    setOrder(null);
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="shrink-0 px-4 pb-2 pt-2">
        <div className="flex h-12 items-center gap-2.5 rounded-2xl border border-line bg-surface-1 px-4 focus-within:border-line-strong">
          <IconSearch size={18} className="text-text-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search water, diapers, tarp…"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-text-3"
          />
          {loading && <Spinner className="size-3.5 text-text-3" />}
        </div>
        <div className="-mx-4 mt-2.5 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {NEEDS.map((n) => (
            <button
              key={n}
              onClick={() => setNeed(need === n ? null : n)}
              className={cx(
                "h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium transition-colors",
                need === n ? "border-teal/40 bg-teal-soft text-teal" : "border-line bg-surface-1 text-text-2 hover:text-text",
              )}
            >
              {NEED_LABEL[n]}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {error && <p className="mt-3 rounded-xl bg-red-soft px-3 py-2 text-[13px] text-red">{error}</p>}
        {offers && !groups.length && !loading && (
          <div className="mt-16 text-center text-[14px] text-text-3">Nothing in stock at an open store nearby. Stores reopen as the storm clears.</div>
        )}
        {!offers && !error && <div className="mt-3 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-2xl bg-surface-1" />)}</div>}
        <div className="space-y-3">
          {groups.map((g, gi) => (
            <motion.section
              key={g.store.idx}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: reduce ? 0 : Math.min(gi, 5) * 0.03, ease: EASE }}
              className={cx("overflow-hidden rounded-2xl border bg-surface-1", cart?.store.idx === g.store.idx ? "border-teal/30" : "border-line")}
            >
              <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <CategoryDot category={g.store.category} />
                    <span className="truncate text-[14.5px] font-semibold">{g.store.name}</span>
                  </div>
                  <div className="mt-0.5 text-2xs text-text-3">
                    {g.store.county} · {km(g.store.distanceKm)}
                  </div>
                </div>
                <Pill tone={g.store.open ? "teal" : "neutral"}>{g.store.open ? "Open" : "Closed"}</Pill>
              </header>
              <ul className="divide-y divide-line">
                {g.items.map((it) => {
                  const q = qtyOf(g.store.idx, it.itemId);
                  const hike = it.priceCents > it.preStormCents * 1.25;
                  return (
                    <li key={it.itemId} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] text-text">{it.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-2xs tabular text-text-3">
                          <span className={cx("font-medium", hike ? "text-amber" : "text-text-2")}>{cents(it.priceCents)}</span>
                          {hike && <span className="line-through">{cents(it.preStormCents)}</span>}
                          <span>· {it.stock} left</span>
                        </div>
                      </div>
                      <Stepper qty={q} max={Math.min(it.maxQty, it.stock)} onAdd={() => change(g.store, it, 1)} onRemove={() => change(g.store, it, -1)} />
                    </li>
                  );
                })}
              </ul>
            </motion.section>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {cart && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: 24, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="shrink-0 border-t border-line bg-surface-1/95 px-4 pb-3 pt-3 backdrop-blur"
          >
            {notice && <div className="mb-2 text-[12px] leading-4 text-amber">{notice}</div>}
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-text-3">
                  {count} {count === 1 ? "item" : "items"} · {cart.store.name}
                </div>
                <div className="text-[18px] font-semibold tabular">{cents(total)}</div>
              </div>
              <BigButton className="w-auto px-5" onClick={review} busy={proposing}>
                Review order
              </BigButton>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <Sheet open={!!order} onClose={closeSheet} title={order?.status === "paid" ? "Paid" : order?.status === "rejected" ? "Payment blocked" : "Your order"}>
        {order && (
          <>
            <OrderCard order={order} payer="resident" onChange={(o) => setOrder(o.status === "cancelled" ? null : o)} />
            {(order.status === "paid" || order.status === "rejected") && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <BigButton tone="outline" onClick={closeSheet}>
                  Done
                </BigButton>
                <BigButton
                  tone="outline"
                  onClick={() => {
                    closeSheet();
                    onReceipts();
                  }}
                >
                  Receipts
                </BigButton>
              </div>
            )}
          </>
        )}
      </Sheet>
    </div>
  );
}

function Stepper({ qty, max, onAdd, onRemove }: { qty: number; max: number; onAdd: () => void; onRemove: () => void }) {
  if (!qty) {
    return (
      <button onClick={onAdd} disabled={max <= 0} aria-label="Add" className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface-2 text-text-2 transition-colors hover:border-teal/40 hover:text-teal disabled:opacity-40">
        <IconPlus size={18} />
      </button>
    );
  }
  return (
    <div className="flex h-10 shrink-0 items-center rounded-full border border-teal/30 bg-teal-soft">
      <button onClick={onRemove} aria-label="Remove one" className="grid size-10 place-items-center text-teal">
        <IconMinus size={16} />
      </button>
      <span className="w-5 text-center text-[14px] font-semibold tabular text-teal">{qty}</span>
      <button onClick={onAdd} disabled={qty >= max} aria-label="Add one" className="grid size-10 place-items-center text-teal disabled:opacity-40">
        <IconPlus size={16} />
      </button>
    </div>
  );
}
