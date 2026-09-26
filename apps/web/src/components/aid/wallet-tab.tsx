"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { NumberTicker } from "@/components/ui/number-ticker";
import { cx } from "@/components/ui/primitives";
import { setAllowance } from "@/lib/aid/actions";
import { cents, seconds, simDay } from "@/lib/aid/format";
import { useAid } from "./aid-context";
import { IconBlock, IconLock, IconShield, IconSpark } from "./icons";
import { BigButton, Card, EASE, ExplorerLink, Pill, useMotion } from "./ui";

const usd2 = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function WalletTab({ onAsk }: { onAsk: () => void }) {
  const { wallet, session, timeZone, signOut, setWallet } = useAid();
  const { reduce } = useMotion();
  const [busy, setBusy] = useState<null | "grant" | "revoke">(null);
  const [error, setError] = useState<string | null>(null);
  if (!wallet || !session) return null;
  const w = wallet;
  const used = w.window.capCents - w.window.remainingCents;
  const usedPct = Math.min(1, used / w.window.capCents);
  const first = w.name.split(" ")[0];

  async function allowance(c: number) {
    if (!session) return;
    setBusy(c > 0 ? "grant" : "revoke");
    setError(null);
    try {
      const next = await setAllowance(session, c);
      if (next) setWallet(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain px-4 pb-6 pt-2">
      <div className="flex items-center justify-between px-1 pb-3">
        <div className="min-w-0">
          <div className="text-[13px] text-text-3">Hi {first}</div>
          <div className="truncate text-[15px] font-semibold">{w.home.county}</div>
        </div>
        <button onClick={signOut} className="h-9 rounded-full border border-line px-3 text-2xs font-medium text-text-3 hover:text-text-2">
          Switch
        </button>
      </div>

      <AnimatePresence>
        {w.frozen && (
          <motion.div initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <Card tone="red" className="mb-3 flex items-start gap-3 p-4">
              <IconBlock size={20} className="mt-0.5 shrink-0 text-red" />
              <div>
                <div className="text-[14px] font-semibold text-red">Wallet frozen by the oracle</div>
                <p className="mt-0.5 text-[12.5px] leading-[18px] text-red/75">Payments from this wallet are refused on-chain while the case is reviewed.</p>
              </div>
            </Card>
          </motion.div>
        )}
        {!w.frozen && w.flagged && (
          <motion.div initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <Card tone="amber" className="mb-3 p-3.5 text-[13px] text-amber">The oracle is reviewing activity on this wallet.</Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Balance */}
      <div className="relative overflow-hidden rounded-3xl border border-teal/20 bg-[linear-gradient(160deg,rgb(45_212_191/0.16),rgb(12_18_32)_55%)] p-5 shadow-[0_20px_50px_-24px_rgb(45_212_191/0.45)]">
        <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-[radial-gradient(circle,rgb(45_212_191/0.22),transparent_65%)]" />
        <div className="relative flex items-center justify-between">
          <span className="eyebrow text-teal/80">Relief dollars</span>
          <Pill tone={w.custody === "device" ? "teal" : "neutral"}>
            <IconLock size={11} /> {w.custody === "device" ? "Key on this phone" : "Demo resident"}
          </Pill>
        </div>
        <div className="relative mt-3 text-[44px] font-semibold leading-none tracking-tight">
          <NumberTicker value={w.balanceCents / 100} format={usd2} />
        </div>
        <div className="relative mt-2 text-[13px] text-text-3">
          of {cents(w.aid.cents)} aid · {cents(w.spentCents)} spent
        </div>
        <div className="relative mt-4 flex items-center justify-between border-t border-white/5 pt-3 text-2xs text-text-3">
          <span>Expires {simDay(w.expiresAt, timeZone)} (Day 30)</span>
          <ExplorerLink address={w.owner} label="Wallet" />
        </div>
      </div>

      {/* Aid landed */}
      <Card className="mt-3 flex items-center gap-3 p-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-teal-soft text-teal">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M12 4v10M7.5 10 12 14.5 16.5 10M6 19.5h12" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">Aid landed · {cents(w.aid.cents)}</div>
          <div className="mt-0.5 text-2xs text-text-3">
            {w.aid.timeToAidMs !== null ? `${seconds(w.aid.timeToAidMs)} after the storm reached you` : w.aid.landedAt ? `Landed ${simDay(w.aid.landedAt, timeZone)}` : ""}
          </div>
        </div>
        <ExplorerLink signature={w.aid.signature} label="Tx" />
      </Card>

      {/* Limits */}
      <Card className="mt-3 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[14px] font-medium">Today&apos;s limit</span>
          <span className="text-[13px] tabular text-text-2">
            <span className="text-text">{cents(w.window.remainingCents)}</span> left of {cents(w.window.capCents).replace(".00", "")}
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3">
          <motion.div
            className={cx("h-full rounded-full", usedPct > 0.85 ? "bg-amber" : "bg-teal")}
            initial={false}
            animate={{ width: `${Math.max(usedPct * 100, used > 0 ? 2 : 0)}%` }}
            transition={{ duration: reduce ? 0 : 0.8, ease: EASE }}
          />
        </div>
        <div className="mt-2.5 flex justify-between text-2xs text-text-3">
          <span>Rolling 24 hours, enforced on-chain</span>
          <span>Up to {cents(w.window.perOrderCapCents).replace(".00", "")} per order</span>
        </div>
      </Card>

      {/* Grok allowance */}
      <Card className="mt-3 p-4">
        <div className="flex items-start gap-3">
          <span className={cx("grid size-10 shrink-0 place-items-center rounded-xl", w.agent.approved ? "bg-teal-soft text-teal" : "bg-surface-3 text-text-3")}>
            <IconSpark size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-medium">Grok allowance</span>
              {w.agent.approved ? <Pill tone="teal">{cents(w.agent.allowanceCents)} left</Pill> : <Pill>Off</Pill>}
            </div>
            <p className="mt-1 text-[12.5px] leading-[18px] text-text-3">
              {w.agent.approved
                ? "Grok can pay for orders you confirm, up to this amount. The chain stops it past that."
                : "Let Grok pay for orders you confirm, from a capped allowance you can revoke."}
            </p>
            {w.agent.signature && (
              <div className="mt-1.5">
                <ExplorerLink signature={w.agent.signature} label="Allowance tx" />
              </div>
            )}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {w.agent.approved ? (
            <>
              <BigButton tone="outline" className="h-11 text-[14px]" onClick={() => allowance(15_000)} busy={busy === "grant"}>
                Reset to $150
              </BigButton>
              <BigButton tone="outline" className="h-11 text-[14px] text-red" onClick={() => allowance(0)} busy={busy === "revoke"}>
                Revoke
              </BigButton>
            </>
          ) : (
            <BigButton className="col-span-2 h-11 text-[14px]" onClick={() => allowance(15_000)} busy={busy === "grant"}>
              Allow up to $150
            </BigButton>
          )}
        </div>
        {error && <p className="mt-2 text-2xs text-red">{error}</p>}
      </Card>

      <button
        onClick={onAsk}
        className="mt-3 flex w-full items-center gap-3 rounded-2xl border border-line bg-surface-1 p-4 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[linear-gradient(135deg,#2dd4bf,#86a8e2)] text-bg">
          <IconSpark size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium">Tell Grok what you need</span>
          <span className="block text-2xs text-text-3">&ldquo;Out of water and food, no power&rdquo;</span>
        </span>
      </button>

      <div className="mt-5 flex items-center justify-center gap-1.5 text-2xs text-text-3">
        <IconShield size={13} /> Only verified relief stores can accept these dollars
      </div>
    </div>
  );
}
