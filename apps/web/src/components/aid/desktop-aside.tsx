"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { renderSVG } from "uqr";
import { Dot } from "@/components/ui/primitives";
import { aidUrl } from "@/lib/site";
import { useAid } from "./aid-context";
import { IconShield, IconSpark, IconStorm } from "./icons";
import { EASE, useMotion } from "./ui";

const POINTS = [
  { icon: IconStorm, title: "Aid lands with the storm", text: "Relief dollars arrive the moment the storm reaches your home. No forms, no weeks of waiting." },
  { icon: IconSpark, title: "Grok shops for you", text: "Say what you need. Grok finds the nearest open store with stock; you confirm every payment." },
  { icon: IconShield, title: "Rules enforced by the chain", text: "Only verified stores, $200 per order, $300 a day. Gougers get suspended and the chain refuses them." },
];

/** The laptop caption next to the phone: what this is, the live run, and a QR to try it for real. */
export function DesktopAside() {
  const { run, wallet } = useAid();
  const { reduce } = useMotion();
  const [qr, setQr] = useState<string | null>(null);
  const [qrHref, setQrHref] = useState("");
  useEffect(() => {
    const url = aidUrl();
    setQrHref(url);
    setQr(renderSVG(url, { pixelSize: 4, whiteColor: "#e6edf7", blackColor: "#070b14", border: 2 }));
  }, []);

  const phase = run?.phase;
  return (
    <motion.aside
      initial={reduce ? false : { opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
      className="hidden w-[340px] shrink-0 lg:block"
    >
      <div className="eyebrow">Resident app</div>
      <h1 className="mt-3 text-[30px] font-semibold leading-[1.15] tracking-tight text-text">
        Aid in your pocket,
        <br />
        <span className="text-teal">seconds</span> after the storm.
      </h1>
      <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-line bg-surface-1/80 px-3 py-1.5 text-xs text-text-2">
        <Dot tone={phase === "live" ? "teal" : phase === "ended" ? "neutral" : "storm"} pulse={phase === "live"} />
        {run ? (
          <span>
            Hurricane {run.stormName.replace(/\s\d{4}$/, "")} relief network ·{" "}
            <span className="text-text">{phase === "live" ? "live" : phase === "ready" ? "ready to declare" : phase === "ended" ? "closed out" : phase}</span>
          </span>
        ) : (
          <span>Connecting to the relief network…</span>
        )}
      </div>

      <ul className="mt-7 space-y-5">
        {POINTS.map((p) => (
          <li key={p.title} className="flex gap-3.5">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-1 text-teal">
              <p.icon size={17} />
            </span>
            <div>
              <div className="text-sm font-medium text-text">{p.title}</div>
              <p className="mt-0.5 text-[13px] leading-5 text-text-3">{p.text}</p>
            </div>
          </li>
        ))}
      </ul>

      {qr && (
        <div className="mt-8 flex items-center gap-4 rounded-2xl border border-line bg-surface-1/80 p-3.5">
          <div className="size-[92px] shrink-0 overflow-hidden rounded-lg [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qr }} />
          <div>
            <div className="text-sm font-medium text-text">Try it on your phone</div>
            <p className="mt-1 text-[12.5px] leading-[18px] text-text-3">
              Scan, tap &ldquo;I live here&rdquo;, and your phone makes its own wallet key. {wallet ? "" : "Aid lands when the storm reaches you."}
            </p>
            {qrHref && (
              <p className="mt-1.5 truncate font-mono text-[11px] text-text-3">{qrHref.replace(/^https?:\/\//, "")}</p>
            )}
          </div>
        </div>
      )}
    </motion.aside>
  );
}
