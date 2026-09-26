"use client";

import { AnimatePresence, motion } from "motion/react";
import { AID_STOPS, WIND_STOPS } from "@/lib/tokens";
import { Button, Kbd, Panel, Segmented } from "../ui/primitives";
import type { LayerMode } from "./map-view";

const gradient = (stops: [number, [number, number, number]][]) =>
  `linear-gradient(90deg, ${stops.map(([, c], i) => `rgb(${c.join(",")}) ${(100 * i) / (stops.length - 1)}%`).join(", ")})`;

export function MapControls({
  mode,
  onMode,
  res,
  onRes,
  cameraAuto,
  onFollow,
}: {
  mode: LayerMode;
  onMode: (m: LayerMode) => void;
  res: number;
  onRes: (r: number) => void;
  /** False once the presenter has moved the map; shows "Follow storm". */
  cameraAuto: boolean;
  onFollow: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute left-4 top-[72px] z-10 w-[268px]">
      <Panel className="p-3">
        <div className="flex items-center justify-between">
          <Segmented
            value={mode}
            onChange={onMode}
            options={[
              { value: "wind", label: "Wind impact", title: "W" },
              { value: "aid", label: "Aid $", title: "A" },
            ]}
          />
          <span className="flex gap-1">
            <Kbd>W</Kbd>
            <Kbd>A</Kbd>
          </span>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="mt-3"
          >
            {mode === "wind" ? (
              <>
                <div className="text-xs text-text-2">Strongest wind so far</div>
                <div className="mt-1.5 h-1.5 rounded-full" style={{ background: gradient(WIND_STOPS) }} />
                <div className="mt-1 flex justify-between text-2xs text-text-3 tabular">
                  <span>29 mph</span>
                  <span>Tropical storm</span>
                  <span>Hurricane</span>
                  <span>115+</span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-2xs leading-relaxed text-text-3">
                  <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0" aria-hidden>
                    <ellipse cx="9" cy="9" rx="8.2" ry="7.4" fill="none" stroke="rgb(134,168,226)" strokeWidth="1" />
                    <ellipse cx="8.4" cy="9" rx="5.4" ry="4.9" fill="none" stroke="rgb(170,196,240)" strokeWidth="1" />
                    <ellipse cx="8" cy="9" rx="2.8" ry="2.5" fill="none" stroke="rgb(220,232,255)" strokeWidth="1" />
                  </svg>
                  <span>Rings: how far 39, 58 and 74 mph winds reach right now.</span>
                </div>
              </>
            ) : (
              <>
                <div className="text-xs text-text-2">Aid per household · height = total aid</div>
                <div className="mt-1.5 h-1.5 rounded-full" style={{ background: gradient(AID_STOPS) }} />
                <div className="mt-1 flex justify-between text-2xs text-text-3 tabular">
                  <span>$250</span>
                  <span>$1,000</span>
                  <span>$2,000</span>
                </div>
                <div className="mt-2 text-2xs leading-relaxed text-text-3">Aid lands in each place as the storm reaches it.</div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
        <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5">
          <span className="text-xs text-text-3">Hex size</span>
          <Segmented
            size="sm"
            value={res}
            onChange={onRes}
            options={[
              { value: 5, label: "16 km" },
              { value: 4, label: "42 km" },
            ]}
          />
        </div>
        <AnimatePresence initial={false}>
          {!cameraAuto && (
            <motion.div
              key="follow"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <Button variant="outline" size="sm" onClick={onFollow} className="mt-2.5 w-full">
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="6" cy="6" r="1.4" fill="currentColor" />
                </svg>
                Follow storm
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </Panel>
    </div>
  );
}
