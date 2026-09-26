"use client";

import { motion } from "motion/react";
import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("glass rounded-[var(--radius-panel)] border border-line shadow-[var(--shadow-panel)]", className)}>{children}</div>
  );
}

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("px-4 py-3.5", className)}>
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Divider() {
  return <div className="h-px bg-line" />;
}

type Tone = "neutral" | "teal" | "amber" | "red" | "storm";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-3 text-text-2 border-line",
  teal: "bg-teal-soft text-teal border-teal/20",
  amber: "bg-amber-soft text-amber border-amber/20",
  red: "bg-red-soft text-red border-red/20",
  storm: "bg-storm-soft text-storm border-storm/15",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-2xs font-medium tabular", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone = "teal", pulse }: { tone?: Tone; pulse?: boolean }) {
  const c = { neutral: "bg-text-3", teal: "bg-teal", amber: "bg-amber", red: "bg-red", storm: "bg-storm" }[tone];
  return (
    <span className="relative inline-flex size-1.5">
      {pulse && <span className={cx("absolute inset-0 animate-ping rounded-full opacity-60", c)} />}
      <span className={cx("relative inline-flex size-1.5 rounded-full", c)} />
    </span>
  );
}

export function Button({
  variant = "ghost",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "solid" | "outline"; size?: "sm" | "md" | "icon" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex select-none items-center justify-center gap-1.5 rounded-lg font-medium transition-[background,color,border,opacity] duration-150 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" && "h-7 px-2.5 text-xs",
        size === "md" && "h-8 px-3 text-sm",
        size === "icon" && "size-8",
        variant === "ghost" && "text-text-2 hover:bg-surface-3 hover:text-text",
        variant === "outline" && "border border-line text-text-2 hover:border-line-strong hover:text-text",
        variant === "solid" && "bg-teal text-bg hover:bg-teal/90",
        className,
      )}
    />
  );
}

/** Segmented control with a sliding highlight (shared layout animation). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = "md",
  className,
  stretch,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
  className?: string;
  /** Fill the container's width, options sharing it equally. */
  stretch?: boolean;
}) {
  const id = useId();
  return (
    <div role="radiogroup" className={cx("relative inline-flex rounded-lg border border-line bg-surface-1/80 p-0.5", stretch && "flex w-full", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative z-0 inline-flex items-center gap-1.5 rounded-md font-medium transition-colors duration-150",
              stretch && "flex-1 justify-center",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-3 text-sm",
              active ? "text-text" : "text-text-3 hover:text-text-2",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                className="absolute inset-0 -z-10 rounded-md border border-line-strong bg-surface-3"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-text-3">
      {children}
    </kbd>
  );
}

/** Label + big number, the unit every KPI card is built from. */
export function Stat({
  label,
  children,
  sub,
  tone,
  size = "md",
}: {
  label: ReactNode;
  children: ReactNode;
  sub?: ReactNode;
  tone?: "teal" | "amber" | "red" | "storm";
  size?: "md" | "lg";
}) {
  const color = tone ? { teal: "text-teal", amber: "text-amber", red: "text-red", storm: "text-storm" }[tone] : "text-text";
  return (
    <div className="min-w-0">
      <div className="text-xs text-text-3">{label}</div>
      <div className={cx("mt-0.5 font-semibold tracking-tight tabular", size === "lg" ? "text-[28px] leading-8" : "text-lg leading-6", color)}>
        {children}
      </div>
      {sub && <div className="mt-0.5 text-2xs text-text-3 tabular">{sub}</div>}
    </div>
  );
}
