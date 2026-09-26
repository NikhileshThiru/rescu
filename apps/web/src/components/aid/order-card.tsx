"use client";

import type { Order } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cx } from "@/components/ui/primitives";
import { payOrder, setAllowance } from "@/lib/aid/actions";
import { blockedHeadline, cents, km } from "@/lib/aid/format";
import { api, ApiRequestError } from "@/lib/api";
import { useAid } from "./aid-context";
import { IconBlock, IconCheck, IconPin, IconSpark } from "./icons";
import { BigButton, Card, CategoryDot, EASE, ExplorerLink, Pill, Spinner, useMotion } from "./ui";

const ORIGIN: Record<Order["origin"], string> = { shop: "Shop", agent: "Grok", mcp: "Outside agent", counter: "Store counter" };
const DEFAULT_ALLOWANCE = 15_000;

/**
 * One order, in whatever state it's in: proposed (with Confirm & pay), paying, paid (explorer
 * link) or blocked by the chain (red, the rule in plain words). Used by Ask, Shop, Receipts and
 * the counter-charge sheet.
 */
export function OrderCard({
  order,
  payer,
  onChange,
  compact,
  footer,
}: {
  order: Order;
  /** Who signs if the resident confirms here. */
  payer: "resident" | "agent";
  onChange?: (o: Order) => void;
  compact?: boolean;
  footer?: React.ReactNode;
}) {
  const { session, wallet, refresh, setWallet } = useAid();
  const [busy, setBusy] = useState<null | "pay" | "allow" | "cancel">(null);
  const [error, setError] = useState<string | null>(null);
  const { reduce } = useMotion();
  const o = order;
  const needsAllowance = payer === "agent" && o.status === "proposed" && wallet !== null && wallet.agent.allowanceCents < o.totalCents;

  async function pay() {
    if (!session) return;
    setBusy("pay");
    setError(null);
    onChange?.({ ...o, status: "paying" });
    try {
      const done = await payOrder(session, o.id, payer);
      onChange?.(done);
      void refresh();
    } catch (err) {
      setError((err as Error).message);
      // Re-read: the order may have moved on even though the request failed.
      try {
        onChange?.(await api("GET /api/market/orders/:id", { params: { id: o.id } }));
      } catch {
        onChange?.(o);
      }
    } finally {
      setBusy(null);
    }
  }

  async function allowAndPay() {
    if (!session) return;
    setBusy("allow");
    setError(null);
    try {
      const want = Math.max(DEFAULT_ALLOWANCE, Math.ceil(o.totalCents / 100) * 100);
      const w = await setAllowance(session, want);
      if (w) setWallet(w);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
      return;
    }
    await pay();
  }

  async function cancel() {
    if (!session) return;
    setBusy("cancel");
    try {
      onChange?.(await api("POST /api/market/orders/:id/cancel", { params: { id: o.id }, token: session.token }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't cancel");
    } finally {
      setBusy(null);
    }
  }

  const tone = o.status === "rejected" ? "red" : o.status === "paid" ? "teal" : undefined;
  return (
    <Card tone={tone} className={cx("overflow-hidden", o.status === "cancelled" && "opacity-55")}>
      <AnimatePresence initial={false}>
        {o.status === "rejected" && (
          <motion.div
            key="blocked"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="overflow-hidden"
          >
            <div className="flex items-start gap-2.5 border-b border-red/20 bg-red/10 px-4 py-3">
              <motion.span
                initial={reduce ? false : { scale: 0.4, rotate: -30 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 18, delay: 0.1 }}
                className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-red text-bg"
              >
                <IconBlock size={15} strokeWidth={2.4} />
              </motion.span>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold leading-5 text-red">{blockedHeadline(o.rule, o.message)}</div>
                <div className="mt-0.5 text-2xs text-red/75">No relief dollars left your wallet. The chain refused the payment{o.rule ? ` (${o.rule})` : ""}.</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="px-4 pt-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CategoryDot category={o.category} />
              <span className="truncate text-[15px] font-semibold text-text">{o.storeName}</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-2xs text-text-3">
              <IconPin size={12} />
              <span className="truncate">
                {o.pickup.county}
                {o.pickup.distanceKm !== null && ` · ${km(o.pickup.distanceKm)}`}
              </span>
            </div>
          </div>
          <StatusPill order={o} />
        </div>

        {!compact && (
          <ul className="mt-3 space-y-1.5">
            {o.lines.map((l) => (
              <li key={l.itemId} className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate text-text-2">
                  <span className="tabular text-text-3">{l.qty} ×</span> {l.name}
                </span>
                <span className="tabular text-text-2">{cents(l.qty * l.unitCents)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className={cx("flex items-baseline justify-between pb-3.5", compact ? "mt-2" : "mt-3 border-t border-line pt-3")}>
          <span className="text-xs text-text-3">
            {compact ? `${o.lines.reduce((a, l) => a + l.qty, 0)} items · ` : ""}
            {ORIGIN[o.origin]}
          </span>
          <span className={cx("text-[17px] font-semibold tabular", o.status === "rejected" ? "text-red" : "text-text")}>{cents(o.totalCents)}</span>
        </div>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {o.status === "proposed" && (
          <motion.div key="actions" {...(reduce ? {} : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })} className="px-4 pb-4">
            {o.message && <p className="mb-2.5 rounded-lg bg-amber-soft px-3 py-2 text-2xs leading-4 text-amber">{o.message}</p>}
            {needsAllowance ? (
              <div className="rounded-xl border border-teal/20 bg-teal-soft/50 p-3">
                <div className="flex items-start gap-2 text-[13px] leading-5 text-text-2">
                  <IconSpark size={16} className="mt-0.5 shrink-0 text-teal" />
                  <span>
                    Grok pays through an allowance you control on-chain.{" "}
                    {wallet && wallet.agent.allowanceCents > 0 ? `It has ${cents(wallet.agent.allowanceCents)} left.` : "You haven't given it one yet."}
                  </span>
                </div>
                <BigButton className="mt-3" onClick={allowAndPay} busy={busy === "allow" || busy === "pay"}>
                  Allow {cents(Math.max(DEFAULT_ALLOWANCE, Math.ceil(o.totalCents / 100) * 100)).replace(".00", "")} &amp; pay {cents(o.totalCents)}
                </BigButton>
              </div>
            ) : (
              <BigButton onClick={pay} busy={busy === "pay"}>
                Confirm &amp; pay {cents(o.totalCents)}
              </BigButton>
            )}
            <button onClick={cancel} disabled={!!busy} className="mt-1 h-10 w-full rounded-xl text-[13px] font-medium text-text-3 transition-colors hover:text-text-2">
              {busy === "cancel" ? <Spinner /> : "Not now"}
            </button>
          </motion.div>
        )}
        {o.status === "paying" && (
          <motion.div key="paying" {...(reduce ? {} : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })} className="flex items-center justify-center gap-2 px-4 pb-4 text-[13px] text-text-2">
            <Spinner className="text-teal" /> Paying on Solana…
          </motion.div>
        )}
        {(o.status === "paid" || o.status === "rejected") && (
          <motion.div key="done" {...(reduce ? {} : { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 } })} className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
            <span className={cx("text-2xs tabular", o.status === "paid" ? "text-teal" : "text-red/80")}>
              {o.status === "paid" ? `Paid on-chain${o.latencyMs ? ` in ${(o.latencyMs / 1000).toFixed(2)} s` : ""} · pick up at the store` : "Rejected on-chain"}
            </span>
            <ExplorerLink signature={o.signature} label="Explorer" />
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p className="px-4 pb-3 text-2xs text-red">{error}</p>}
      {footer}
    </Card>
  );
}

function StatusPill({ order }: { order: Order }) {
  switch (order.status) {
    case "paid":
      return (
        <Pill tone="teal">
          <IconCheck size={12} strokeWidth={2.4} /> Paid
        </Pill>
      );
    case "rejected":
      return <Pill tone="red">Blocked</Pill>;
    case "paying":
      return <Pill tone="storm">Paying</Pill>;
    case "cancelled":
      return <Pill>Cancelled</Pill>;
    default:
      return <Pill tone="storm">To confirm</Pill>;
  }
}
