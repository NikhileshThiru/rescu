"use client";

import type { StoreActivity } from "@rescu/live";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cx, Dot } from "../ui/primitives";
import { money, ORIGIN_LABEL, simClock, txHref } from "./money";

const RULE_LABEL: Record<string, string> = {
  MerchantSuspended: "Store suspended",
  AccountFrozen: "Wallet frozen",
  OverDailyCap: "Over the 24 h limit",
  OverOrderCap: "Over the order limit",
  NotRegisteredMerchant: "Not a relief store",
  ResaleBlocked: "Resale blocked",
  AidExpired: "Aid expired",
};

function tone(e: StoreActivity): "teal" | "red" | "amber" | "storm" | "neutral" {
  if (e.kind === "payment") return "teal";
  if (e.kind === "blocked") return "red";
  if (e.kind === "price") return "storm";
  if (e.kind === "status") return e.detail.includes("reinstated") ? "teal" : "red";
  return "neutral";
}

/** What just happened at the store, newest first; rows slide in as the terminal polls. */
export function ActivityFeed({ events, cluster, loading }: { events: StoreActivity[]; cluster: string | null; loading: boolean }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 [scrollbar-width:thin]">
      {!events.length && (
        <p className="px-3 py-8 text-center text-xs leading-5 text-text-3">
          {loading ? "Loading…" : "Nothing yet. Payments, blocked attempts and price changes show up here the moment they happen."}
        </p>
      )}
      <ul>
        <AnimatePresence initial={false}>
          {events.map((e) => (
            <motion.li
              key={e.seq}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, y: -10, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            >
              <Row e={e} cluster={cluster} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

function Row({ e, cluster }: { e: StoreActivity; cluster: string | null }) {
  const href = txHref(e.signature, cluster);
  const app = e.origin !== "sim";
  const who = e.residentName ?? (e.kind === "payment" || e.kind === "blocked" ? ORIGIN_LABEL[e.origin] : null);
  const title =
    e.kind === "payment"
      ? `${who ?? "Resident"} paid`
      : e.kind === "blocked"
        ? `${who ?? "Resident"} was refused`
        : e.kind === "price"
          ? "Price changed"
          : e.kind === "status"
            ? e.detail.split(":")[0]!
            : "Order";
  const detail = e.kind === "status" ? e.detail.split(":").slice(1).join(":").trim() : e.kind === "blocked" && e.rule ? `${RULE_LABEL[e.rule] ?? e.rule}. ${e.detail}` : e.detail;
  const Body = (
    <div className={cx("group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors", href && "hover:bg-surface-2/70", e.kind === "status" && "bg-red-soft/50")}>
      <span className="flex h-5 items-center">
        <Dot tone={tone(e)} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] text-text">
            {title}
            {app && e.origin !== "oracle" && e.origin !== "counter" && (e.kind === "payment" || e.kind === "blocked") && (
              <span className="ml-1.5 text-2xs text-text-3">{ORIGIN_LABEL[e.origin]}</span>
            )}
            {e.origin === "counter" && (e.kind === "payment" || e.kind === "blocked") && <span className="ml-1.5 text-2xs text-teal">Counter QR</span>}
          </span>
          {(e.kind === "payment" || e.kind === "blocked") && (
            <span className={cx("shrink-0 text-[13px] tabular", e.kind === "payment" ? "text-teal" : "text-red line-through decoration-red/50")}>
              {e.kind === "payment" ? "+" : ""}
              {money(e.cents)}
            </span>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2 text-2xs text-text-3">
          <span className={cx("min-w-0 truncate", e.kind === "blocked" && "text-red/85", e.kind === "status" && "text-red/85")}>{detail}</span>
          <span className="shrink-0 tabular transition-colors group-hover:text-teal">
            {simClock(e.simT)}
            {href ? " ↗" : ""}
          </span>
        </div>
      </div>
    </div>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block">
      {Body}
    </a>
  ) : (
    Body
  );
}
