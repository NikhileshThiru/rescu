"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { encode } from "uqr";
import { aidUrl } from "@/lib/site";
import { Button, cx, Kbd } from "../ui/primitives";

export function joinUrl(): string {
  return aidUrl();
}

/**
 * The QR as SVG: teal rounded modules on the navy base, finder eyes drawn as rounded squares.
 * Phones read light-on-dark codes; the quiet zone is kept at 3 modules.
 */
export function QrCode({ text, size = 200, className }: { text: string; size?: number; className?: string }) {
  const svg = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 0 });
    const n = qr.size;
    const q = 3;
    const total = n + q * 2;
    const eye = (x: number, y: number) => x < 7 && y < 7 ? true : x >= n - 7 && y < 7 ? true : x < 7 && y >= n - 7;
    const dots: string[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!qr.data[y]![x] || eye(x, y)) continue;
        dots.push(`M${x + q + 0.1} ${y + q + 0.1}h0.8v0.8h-0.8z`);
      }
    }
    const eyes = [
      [0, 0],
      [n - 7, 0],
      [0, n - 7],
    ]
      .map(
        ([x, y]) =>
          `<rect x="${x! + q + 0.5}" y="${y! + q + 0.5}" width="6" height="6" rx="1.7" fill="none" stroke="#2dd4bf" stroke-width="1"/>` +
          `<rect x="${x! + q + 2}" y="${y! + q + 2}" width="3" height="3" rx="0.9" fill="#a4f2e4"/>`,
      )
      .join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="geometricPrecision"><rect width="${total}" height="${total}" rx="2.4" fill="#070b14"/><path d="${dots.join("")}" fill="#2dd4bf"/>${eyes}</svg>`;
  }, [text]);
  return <div className={className} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} aria-label={`QR code for ${text}`} role="img" />;
}

function QrGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="1.5" y="1.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="8.5" y="1.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="1.5" y="8.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8.5 8.5h1.6v1.6H8.5zM11 11h1.5v1.5H11zM11 8.5h1.5M8.5 12.5h1.5" fill="currentColor" stroke="currentColor" strokeWidth="0.6" />
    </svg>
  );
}

/** Top-bar button + popover: "Scan to become a resident" (opens /aid on a phone). Key: Q. */
export function ScanToJoin({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const reduce = useReducedMotion() ?? false;
  const root = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(joinUrl()), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const display = url.replace(/^https?:\/\//, "");
  return (
    <div ref={root} className="relative">
      <Button
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-label="Scan to become a resident"
        title="Scan to become a resident (Q)"
        onClick={() => onOpenChange(!open)}
        className={cx("h-8 gap-1.5 px-2.5", open && "border-teal/40 text-teal")}
      >
        <QrGlyph />
        <span className="hidden xl:inline">Join</span>
      </Button>
      <AnimatePresence>
        {open && url && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={reduce ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-11 z-40 w-[280px] rounded-[var(--radius-panel)] border border-line-strong bg-surface-1 p-4 shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85)]"
          >
            <div className="flex items-center justify-between">
              <span className="eyebrow">Become a resident</span>
              <Kbd>Q</Kbd>
            </div>
            <div className="relative mx-auto mt-3 w-fit rounded-2xl border border-teal/25 bg-bg p-2 shadow-[0_0_40px_-12px_rgba(45,212,191,0.55)]">
              <QrCode text={url} size={216} />
            </div>
            <div className="mt-3 text-center text-sm font-medium text-text">Scan to become a resident</div>
            <p className="mt-1 text-center text-2xs leading-4 text-text-3">
              Register your phone inside the storm zone. Aid lands in your wallet the moment the storm reaches you.
            </p>
            <div className="mt-2.5 truncate rounded-md border border-line bg-surface-2 px-2 py-1 text-center font-mono text-[11px] text-text-2">
              {display}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
