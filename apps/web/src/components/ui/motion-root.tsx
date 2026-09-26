"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** Every Motion animation in the app follows the OS "reduce motion" setting (fades stay, movement goes). */
export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
