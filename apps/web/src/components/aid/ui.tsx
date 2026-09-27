"use client";

import { explorerAddress, explorerTx } from "@rescu/live";
import { motion, useReducedMotion } from "motion/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "@/components/ui/primitives";
import { useAid } from "./aid-context";
import { IconExternal } from "./icons";

export const EASE = [0.16, 1, 0.3, 1] as const;

/** Motion presets that collapse to instant changes under prefers-reduced-motion. */
export function useMotion() {
  const reduce = useReducedMotion();
  return {
    reduce: !!reduce,
    fadeUp: reduce
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
      : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: { duration: 0.35, ease: EASE } },
    spring: reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 420, damping: 36 },
  };
}

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: "teal" | "red" | "amber" }) {
  return (
    <div
      className={cx(
        "rounded-2xl border bg-surface-1 shadow-[0_1px_0_0_rgb(255_255_255/0.03)_inset]",
        tone === "red" ? "border-red/30 bg-[linear-gradient(180deg,rgb(240_97_109/0.10),rgb(240_97_109/0.03))]" : tone === "teal" ? "border-teal/25" : tone === "amber" ? "border-amber/30" : "border-line",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function BigButton({
  tone = "teal",
  className,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "teal" | "outline" | "ghost" | "red"; busy?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        "relative inline-flex h-12 w-full select-none items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold transition-[background,color,border,opacity,transform] duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50",
        tone === "teal" && "bg-teal text-bg shadow-[0_8px_24px_-10px_rgb(45_212_191/0.7)] hover:bg-teal/90",
        tone === "outline" && "border border-line-strong bg-surface-2/60 text-text hover:bg-surface-3",
        tone === "ghost" && "text-text-2 hover:bg-surface-2 hover:text-text",
        tone === "red" && "border border-red/30 bg-red-soft text-red",
        className,
      )}
    >
      {busy ? <Spinner /> : children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent", className)} aria-label="Working" />
  );
}

export function ExplorerLink({ signature, address, label, className }: { signature?: string | null; address?: string; label?: ReactNode; className?: string }) {
  const { run } = useAid();
  if (!signature && !address) return null;
  const cluster = run?.explorerCluster ?? "";
  const href = signature ? explorerTx(signature, cluster) : explorerAddress(address!, cluster);
  const short = signature ?? address!;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cx("inline-flex min-h-6 items-center gap-1 font-mono text-2xs text-text-3 underline-offset-2 transition-colors hover:text-teal hover:underline", className)}
      onClick={(e) => e.stopPropagation()}
    >
      {label ?? `${short.slice(0, 6)}…${short.slice(-4)}`}
      <IconExternal size={12} />
    </a>
  );
}

/** Soft animated check in a teal disc. */
export function SuccessMark({ size = 56 }: { size?: number }) {
  const { reduce } = useMotion();
  return (
    <motion.div
      initial={reduce ? false : { scale: 0.6, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 22 }}
      className="grid place-items-center rounded-full bg-teal-soft text-teal ring-1 ring-teal/30"
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <motion.path d="m5 12.5 4.5 4.5L19 7.5" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, delay: 0.12, ease: EASE }} />
      </svg>
    </motion.div>
  );
}

export function Pill({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "teal" | "amber" | "red" | "storm"; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-2xs font-medium tabular",
        tone === "neutral" && "border-line bg-surface-2 text-text-2",
        tone === "teal" && "border-teal/20 bg-teal-soft text-teal",
        tone === "amber" && "border-amber/25 bg-amber-soft text-amber",
        tone === "red" && "border-red/25 bg-red-soft text-red",
        tone === "storm" && "border-storm/15 bg-storm-soft text-storm",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const CATEGORY_COLOR: Record<string, string> = {
  grocery: "#2dd4bf",
  pharmacy: "#a78bfa",
  hardware: "#f5b83d",
  general: "#86a8e2",
};

export function CategoryDot({ category }: { category: string }) {
  return <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[category] ?? "#9aa8bd" }} />;
}
