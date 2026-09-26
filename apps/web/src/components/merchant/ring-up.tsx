"use client";

import { counterChargeUrl, type Listing, type Order, type StoreActivity } from "@rescu/live";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { QrCode } from "../command/scan-to-join";
import { Button, cx } from "../ui/primitives";
import { money, txHref } from "./money";

type Step = { kind: "pick" } | { kind: "creating" } | { kind: "qr"; order: Order } | { kind: "error"; message: string };

const PER_ORDER_CAP = 20_000;

/**
 * "Ring up a sale": pick items, show a QR the resident scans with the relief app, then watch
 * the order until the chain confirms it (or refuses it).
 */
export function RingUp({
  store,
  storeName,
  listings,
  open,
  onClose,
  latest,
  cluster,
}: {
  store: number;
  storeName: string;
  listings: Listing[];
  open: boolean;
  onClose: () => void;
  /** The store's newest activity, to spot the payment landing even without the order route. */
  latest: StoreActivity[];
  cluster: string | null;
}) {
  const reduce = useReducedMotion() ?? false;
  const [qty, setQty] = useState<Record<number, number>>({});
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [since, setSince] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQty({});
    setStep({ kind: "pick" });
  }, [open, store]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const lines = useMemo(() => listings.filter((l) => (qty[l.itemId] ?? 0) > 0).map((l) => ({ l, q: qty[l.itemId]! })), [listings, qty]);
  const total = lines.reduce((a, x) => a + x.q * x.l.priceCents, 0);

  // Watch the order (public route); fall back to the store's activity feed for a counter payment of this amount.
  const order = step.kind === "qr" ? step.order : null;
  useEffect(() => {
    if (!order || order.status === "paid" || order.status === "rejected" || order.status === "cancelled") return;
    const ctrl = new AbortController();
    const id = setInterval(async () => {
      try {
        const o = await api("GET /api/market/orders/:id", { params: { id: order.id }, signal: ctrl.signal });
        if (o.status !== order.status || o.resident !== order.resident) setStep({ kind: "qr", order: o });
      } catch {
        // The order route may not be up; the activity feed below still catches the payment.
      }
    }, 1_000);
    return () => {
      clearInterval(id);
      ctrl.abort();
    };
  }, [order]);
  useEffect(() => {
    if (!order || order.status === "paid" || order.status === "rejected") return;
    const hit = latest.find((e) => e.seq > since && e.origin === "counter" && e.cents === order.totalCents && (e.kind === "payment" || e.kind === "blocked"));
    if (hit)
      setStep({
        kind: "qr",
        order: { ...order, status: hit.kind === "payment" ? "paid" : "rejected", signature: hit.signature, rule: hit.rule, residentName: hit.residentName, message: hit.kind === "blocked" ? hit.detail : null },
      });
  }, [latest, order, since]);

  const create = async () => {
    setStep({ kind: "creating" });
    setSince(latest[0]?.seq ?? 0);
    try {
      const o = await api("POST /api/merchant/stores/:idx/charges", { params: { idx: store }, body: { lines: lines.map((x) => ({ itemId: x.l.itemId, qty: x.q })) } });
      setStep({ kind: "qr", order: o });
    } catch (err) {
      setStep({ kind: "error", message: (err as Error).message });
    }
  };

  const url = order ? counterChargeUrl(process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin, order.id) : "";

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <div className="absolute inset-0 bg-bg/70 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-label="Ring up a sale"
            initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}
            className="glass relative flex max-h-[min(720px,90dvh)] w-[min(560px,100%)] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line shadow-[var(--shadow-panel)]"
          >
            <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
              <div>
                <h2 className="text-[15px] font-semibold tracking-tight">Ring up a sale</h2>
                <p className="text-2xs text-text-3">{storeName} · paid from the resident's relief wallet</p>
              </div>
              <Button size="icon" onClick={onClose} aria-label="Close">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <path d="m2.5 2.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </Button>
            </header>

            {(step.kind === "pick" || step.kind === "creating" || step.kind === "error") && (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 [scrollbar-width:thin]">
                  {listings.map((l) => {
                    const n = qty[l.itemId] ?? 0;
                    const max = Math.min(l.maxQty, l.stock);
                    return (
                      <div key={l.itemId} className={cx("flex items-center gap-3 rounded-lg px-2.5 py-1.5", n > 0 && "bg-teal-soft/40")}>
                        <span className="min-w-0 flex-1 truncate text-[13px]">{l.name}</span>
                        <span className="w-16 text-right text-xs tabular text-text-2">{money(l.priceCents)}</span>
                        <div className="flex items-center gap-1">
                          <Button size="icon" className="size-7" disabled={n <= 0} onClick={() => setQty((q) => ({ ...q, [l.itemId]: n - 1 }))} aria-label={`One less ${l.name}`}>
                            −
                          </Button>
                          <span className="w-5 text-center text-sm tabular">{n}</span>
                          <Button size="icon" className="size-7" disabled={n >= max} onClick={() => setQty((q) => ({ ...q, [l.itemId]: n + 1 }))} aria-label={`One more ${l.name}`}>
                            +
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <footer className="flex items-center gap-3 border-t border-line px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-2xs text-text-3">{lines.length ? `${lines.reduce((a, x) => a + x.q, 0)} items` : "Pick what the resident is buying"}</div>
                    <div className={cx("text-lg font-semibold tabular", total > PER_ORDER_CAP ? "text-red" : "text-text")}>{money(total)}</div>
                    {step.kind === "error" && <div className="text-2xs text-red">{step.message}</div>}
                    {total > PER_ORDER_CAP && step.kind !== "error" && <div className="text-2xs text-red">Over the $200 per-order limit; the chain would refuse it.</div>}
                  </div>
                  <Button variant="solid" disabled={!lines.length || step.kind === "creating"} onClick={create}>
                    {step.kind === "creating" ? "Creating…" : "Show QR code"}
                  </Button>
                </footer>
              </>
            )}

            {order && (
              <div className="flex flex-col items-center gap-4 px-6 py-6">
                <AnimatePresence mode="wait">
                  {order.status === "paid" ? (
                    <Paid key="paid" order={order} cluster={cluster} reduce={reduce} />
                  ) : order.status === "rejected" ? (
                    <motion.div key="rejected" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex flex-col items-center gap-2 py-6 text-center">
                      <div className="flex size-14 items-center justify-center rounded-full bg-red-soft text-red">
                        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
                          <path d="m6 6 10 10m0-10L6 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="text-lg font-semibold">Refused by the chain</div>
                      <div className="max-w-sm text-xs text-text-2">{order.message ?? order.rule}</div>
                      {txHref(order.signature, cluster) && (
                        <a href={txHref(order.signature, cluster)!} target="_blank" rel="noreferrer" className="text-2xs text-text-3 hover:text-teal">
                          View the transaction ↗
                        </a>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div key="qr" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} className="flex flex-col items-center gap-4">
                      <div className="relative rounded-2xl border border-line bg-bg p-3">
                        <QrCode text={url} size={232} />
                        {!reduce && <motion.div className="pointer-events-none absolute inset-3 rounded-lg border border-teal/40" animate={{ opacity: [0.2, 0.7, 0.2] }} transition={{ duration: 2.2, repeat: Infinity }} />}
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-semibold tabular">{money(order.totalCents)}</div>
                        <div className="mt-1 flex items-center justify-center gap-1.5 text-xs text-text-2">
                          <span className="block size-2.5 animate-spin rounded-full border border-teal border-t-transparent" />
                          {order.status === "paying" ? `${order.residentName ?? "Resident"} is paying…` : "Waiting for the resident to scan and confirm"}
                        </div>
                      </div>
                      <a href={url} target="_blank" rel="noreferrer" className="max-w-full truncate rounded-md border border-line px-2.5 py-1 font-mono text-2xs text-text-3 hover:border-line-strong hover:text-teal">
                        {url.replace(/^https?:\/\//, "")}
                      </a>
                    </motion.div>
                  )}
                </AnimatePresence>
                {(order.status === "paid" || order.status === "rejected") && (
                  <Button variant="outline" onClick={() => setStep({ kind: "pick" })}>
                    New sale
                  </Button>
                )}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Paid({ order, cluster, reduce }: { order: Order; cluster: string | null; reduce: boolean }) {
  const href = txHref(order.signature, cluster);
  return (
    <motion.div key="paid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-2 py-4 text-center">
      <div className="relative flex size-20 items-center justify-center">
        {!reduce && (
          <motion.span className="absolute inset-0 rounded-full bg-teal/25" initial={{ scale: 0.4, opacity: 0.9 }} animate={{ scale: 1.8, opacity: 0 }} transition={{ duration: 1.1, ease: "easeOut" }} />
        )}
        <motion.div
          className="flex size-16 items-center justify-center rounded-full bg-teal text-bg"
          initial={reduce ? false : { scale: 0.3 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18 }}
        >
          <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
            <motion.path
              d="M7 14.5 12 19.5 21.5 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ delay: 0.15, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            />
          </svg>
        </motion.div>
      </div>
      <div className="text-2xl font-semibold tabular text-teal">{money(order.totalCents)} paid</div>
      <div className="text-xs text-text-2">
        {order.residentName ? `${order.residentName} paid in relief dollars` : "Paid in relief dollars"}
        {order.latencyMs ? `, confirmed on-chain in ${order.latencyMs} ms` : ", confirmed on-chain"}
      </div>
      {href && (
        <a href={href} target="_blank" rel="noreferrer" className="text-2xs text-text-3 hover:text-teal">
          View the transaction ↗
        </a>
      )}
    </motion.div>
  );
}
