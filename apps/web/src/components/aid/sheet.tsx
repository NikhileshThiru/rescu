"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useMotion } from "./ui";

/** A bottom sheet inside the phone screen (absolute, so it stays in the frame on a laptop). */
export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  const { reduce } = useMotion();
  return (
    <AnimatePresence>
      {open && (
        <div className="absolute inset-0 z-50 flex flex-col justify-end">
          <motion.button
            aria-label="Close"
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.25 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            className="relative max-h-[88%] overflow-y-auto overscroll-contain rounded-t-[28px] border-t border-line-strong bg-surface-1 px-4 pb-8 pt-2 shadow-[0_-20px_60px_-20px_rgb(0_0_0/0.8)]"
            initial={reduce ? { opacity: 0 } : { y: "100%" }}
            animate={reduce ? { opacity: 1 } : { y: 0 }}
            exit={reduce ? { opacity: 0 } : { y: "100%" }}
            transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 38 }}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />
            {title && <div className="mb-3 px-1 text-[17px] font-semibold tracking-tight">{title}</div>}
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
