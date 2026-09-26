"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./primitives";

const LINKS = [
  { href: "/", label: "Command Center", hint: "The live map: storm, aid, and every payment" },
  { href: "/aid", label: "Resident", hint: "A survivor's phone — wallet, Grok shopper, store" },
  { href: "/merchant", label: "Merchant", hint: "A store's register — prices and checkout" },
  { href: "/oracle", label: "Oracle", hint: "Watchdog: flags gouging and fraud, suspends on-chain" },
] as const;

/** The four surfaces of the demo, one click apart. Same look on every page. */
export function AppNav({ className }: { className?: string }) {
  const path = usePathname();
  return (
    <nav className={cx("inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-1/80 p-0.5", className)} aria-label="Rescu pages">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path?.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            title={l.hint}
            className={cx(
              "group relative inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors duration-150",
              active ? "border border-line-strong bg-surface-3 text-text" : "text-text-3 hover:text-text-2",
            )}
          >
            {l.label}
            <span className="pointer-events-none absolute left-1/2 top-[calc(100%+10px)] z-50 hidden w-56 -translate-x-1/2 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-[11px] font-normal leading-4 text-text-2 shadow-panel group-hover:block group-focus-visible:block">
              {l.hint}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
