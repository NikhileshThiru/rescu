"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./primitives";

const LINKS = [
  { href: "/", label: "Command Center" },
  { href: "/aid", label: "Resident" },
  { href: "/merchant", label: "Merchant" },
  { href: "/oracle", label: "Oracle" },
] as const;

/** The four surfaces of the demo, one click apart. Same look on every page. */
export function AppNav({ className }: { className?: string }) {
  const path = usePathname();
  return (
    <nav className={cx("inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-1/80 p-0.5", className)}>
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path?.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={cx(
              "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors duration-150",
              active ? "border border-line-strong bg-surface-3 text-text" : "text-text-3 hover:text-text-2",
            )}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
