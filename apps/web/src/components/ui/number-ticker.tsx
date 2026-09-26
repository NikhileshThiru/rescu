"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

/** Counts smoothly to `value`, writing straight to the DOM (no re-render per frame). */
export function NumberTicker({
  value,
  format,
  duration = 1.1,
  className,
}: {
  value: number;
  format: (x: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const reduce = useReducedMotion();
  const fmt = useRef(format);
  fmt.current = format;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      shown.current = value;
      el.textContent = fmt.current(value);
      return;
    }
    const controls = animate(shown.current, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (x) => {
        shown.current = x;
        el.textContent = fmt.current(x);
      },
    });
    return () => controls.stop();
  }, [value, duration, reduce]);

  return (
    <span ref={ref} className={`tabular ${className ?? ""}`}>
      {format(shown.current)}
    </span>
  );
}
