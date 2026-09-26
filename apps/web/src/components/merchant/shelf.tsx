"use client";

import type { Listing } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../ui/primitives";
import { money } from "./money";

const NEED_LABEL: Record<Listing["need"], string> = {
  water: "Water",
  food: "Food",
  baby: "Baby",
  medical: "Medical",
  power: "Power",
  fuel: "Fuel",
  shelter: "Shelter",
  cleanup: "Cleanup",
  hygiene: "Hygiene",
  pet: "Pet",
};

/** Above this markup over the store's own pre-storm price the price reads amber (the oracle's line is +25% over the regional median). */
const WARN = 1.25;

export type SaveState = { itemId: number; phase: "saving" | "saved" | "error"; message?: string };

/** The store's shelf: every item with its pre-storm and current price (click to edit) and stock. */
export function Shelf({
  listings,
  save,
  onEdit,
  disabled,
}: {
  listings: Listing[];
  save: SaveState | null;
  onEdit: (itemId: number, cents: number) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const maxStock = Math.max(1, ...listings.map((l) => l.stock));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-10 bg-surface-1/95 backdrop-blur">
          <tr className="text-left">
            <th className="eyebrow border-b border-line py-2 pr-3 pl-5 font-medium">Item</th>
            <th className="eyebrow border-b border-line px-3 py-2 text-right font-medium">Before the storm</th>
            <th className="eyebrow border-b border-line px-3 py-2 text-right font-medium">Price now</th>
            <th className="eyebrow border-b border-line py-2 pr-5 pl-3 font-medium">Stock</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((l) => {
            const ratio = l.priceCents / l.preStormCents;
            const hot = ratio > WARN;
            const s = save?.itemId === l.itemId ? save : null;
            return (
              <tr key={l.itemId} className="group">
                <td className="border-b border-line/60 py-2 pr-3 pl-5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-text">{l.name}</span>
                    <span className="shrink-0 rounded border border-line px-1.5 text-[10px] leading-4 text-text-3">{NEED_LABEL[l.need]}</span>
                  </div>
                </td>
                <td className="border-b border-line/60 px-3 py-2 text-right tabular text-text-3">{money(l.preStormCents)}</td>
                <td className="border-b border-line/60 px-3 py-1.5 text-right">
                  {editing === l.itemId ? (
                    <PriceInput
                      cents={l.priceCents}
                      onCancel={() => setEditing(null)}
                      onSave={(c) => {
                        setEditing(null);
                        if (c !== l.priceCents) onEdit(l.itemId, c);
                      }}
                    />
                  ) : (
                    <button
                      disabled={disabled}
                      onClick={() => setEditing(l.itemId)}
                      title="Change the price"
                      className={cx(
                        "relative inline-flex h-7 items-center justify-end gap-1.5 rounded-md border border-transparent px-2 tabular transition-colors",
                        "hover:border-line-strong hover:bg-surface-2",
                        hot ? "text-amber" : "text-text",
                      )}
                    >
                      {hot && <span className="rounded bg-amber-soft px-1 text-[10px] leading-4 text-amber">{ratio.toFixed(1)}x</span>}
                      <motion.span key={l.priceCents} initial={{ opacity: 0.2, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
                        {money(l.priceCents)}
                      </motion.span>
                      <PencilIcon />
                      <AnimatePresence>
                        {s && (
                          <motion.span
                            key={s.phase}
                            initial={{ opacity: 0, scale: 0.6 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute -right-4 top-1/2 -translate-y-1/2"
                          >
                            {s.phase === "saving" ? (
                              <span className="block size-2.5 animate-spin rounded-full border border-text-3 border-t-transparent" />
                            ) : s.phase === "saved" ? (
                              <svg width="12" height="12" viewBox="0 0 12 12" className="text-teal" aria-label="Saved">
                                <path d="M2.5 6.3 5 8.6l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ) : (
                              <span className="block size-2 rounded-full bg-red" title={s.message} />
                            )}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </button>
                  )}
                </td>
                <td className="border-b border-line/60 py-2 pr-5 pl-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
                      <div
                        className={cx("h-full rounded-full transition-[width] duration-500", l.stock === 0 ? "bg-red" : l.stock < 10 ? "bg-amber" : "bg-teal/70")}
                        style={{ width: `${(100 * l.stock) / maxStock}%` }}
                      />
                    </div>
                    <span className={cx("w-8 text-xs tabular", l.stock === 0 ? "text-red" : "text-text-3")}>{l.stock === 0 ? "Out" : l.stock}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden className="text-text-3 opacity-0 transition-opacity group-hover:opacity-100">
      <path d="m2 10 .6-2.4L8.3 1.9a1 1 0 0 1 1.4 0l.4.4a1 1 0 0 1 0 1.4L4.4 9.4z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function PriceInput({ cents, onSave, onCancel }: { cents: number; onSave: (cents: number) => void; onCancel: () => void }) {
  const [v, setV] = useState((cents / 100).toFixed(2));
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const x = Math.round(Number.parseFloat(v.replace(/[$,\s]/g, "")) * 100);
    if (Number.isFinite(x) && x >= 1 && x <= 500_000) onSave(x);
    else onCancel();
  };
  return (
    <span className="inline-flex h-7 items-center rounded-md border border-teal/50 bg-surface-2 pl-2 ring-2 ring-teal/15">
      <span className="text-text-3">$</span>
      <input
        ref={ref}
        value={v}
        inputMode="decimal"
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
        className="h-full w-16 bg-transparent pr-2 text-right tabular text-text outline-none"
        aria-label="New price in dollars"
      />
    </span>
  );
}
