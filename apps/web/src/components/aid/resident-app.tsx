"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AppNav } from "@/components/ui/app-nav";
import { Wordmark } from "@/components/ui/mark";
import { cx } from "@/components/ui/primitives";
import { simClock, simDay } from "@/lib/aid/format";
import { AidProvider, useAid } from "./aid-context";
import { AskTab } from "./ask-tab";
import { CounterSheet } from "./counter-sheet";
import { DesktopAside } from "./desktop-aside";
import { IconBag, IconReceipt, IconSpark, IconWallet } from "./icons";
import { AidLanded, Onboarding, WaitingForAid } from "./onboarding";
import { ReceiptsTab } from "./receipts-tab";
import { ShopTab } from "./shop-tab";
import { EASE, useMotion } from "./ui";
import { WalletTab } from "./wallet-tab";

export type Tab = "wallet" | "ask" | "shop" | "receipts";

const PHONE_W = 390;
const PHONE_H = 844;
const BEZEL = 11;

/** /aid: the resident's phone. Full screen on a phone; a realistic phone on a laptop. */
export function ResidentApp() {
  return (
    <AidProvider>
      <Shell />
    </AidProvider>
  );
}

function useDesktop() {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => {
      setDesktop(mq.matches);
      setScale(Math.min(1, (window.innerHeight - 92) / (PHONE_H + BEZEL * 2)));
    };
    update();
    mq.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return { desktop, scale };
}

function Shell() {
  const { desktop, scale } = useDesktop();
  if (desktop === null) return null;
  if (!desktop) {
    return (
      <div className="fixed inset-0 bg-bg">
        <Screen desktop={false} />
      </div>
    );
  }
  const w = (PHONE_W + BEZEL * 2) * scale;
  const h = (PHONE_H + BEZEL * 2) * scale;
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-bg">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_62%_45%,rgb(45_212_191/0.07),transparent_70%),radial-gradient(40%_40%_at_20%_80%,rgb(134_168_226/0.06),transparent_70%)]" />
      <header className="relative z-10 flex h-14 items-center justify-between px-6">
        <Wordmark compact />
        <AppNav />
        <div className="w-[88px]" />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center gap-16 px-8 pb-6">
        <DesktopAside />
        <div style={{ width: w, height: h }} className="shrink-0">
          <div
            style={{ width: PHONE_W + BEZEL * 2, height: PHONE_H + BEZEL * 2, transform: `scale(${scale})`, transformOrigin: "top left", padding: BEZEL }}
            className="relative rounded-[56px] bg-[linear-gradient(145deg,#1d2638,#0a0f19_45%,#141c2c)] shadow-[0_0_0_1px_rgb(154_168_189/0.18),0_0_0_2px_#05080f,0_40px_90px_-20px_rgb(0_0_0/0.85),0_0_120px_-30px_rgb(45_212_191/0.18)]"
          >
            {/* Side buttons */}
            <span className="absolute -left-[3px] top-[150px] h-8 w-[3px] rounded-l bg-[#1a2233]" />
            <span className="absolute -left-[3px] top-[200px] h-14 w-[3px] rounded-l bg-[#1a2233]" />
            <span className="absolute -left-[3px] top-[268px] h-14 w-[3px] rounded-l bg-[#1a2233]" />
            <span className="absolute -right-[3px] top-[220px] h-20 w-[3px] rounded-r bg-[#1a2233]" />
            <div className="relative h-full w-full overflow-hidden rounded-[45px] bg-bg ring-1 ring-black/60">
              <Screen desktop />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Screen({ desktop }: { desktop: boolean }) {
  const { session, offline, run } = useAid();
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg text-text" style={desktop ? undefined : { paddingTop: "env(safe-area-inset-top)" }}>
      {desktop && <StatusBar />}
      {offline && (
        <div className="mx-4 mt-2 rounded-xl border border-red/25 bg-red-soft px-3 py-2 text-2xs text-red">Can&apos;t reach the Rescu network. Retrying…</div>
      )}
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          {session ? (
            <motion.div key={`app-${session.token}`} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <SignedIn desktop={desktop} />
            </motion.div>
          ) : (
            <motion.div key="onboarding" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <Onboarding run={run} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <CounterSheet />
      {desktop && <div className="pointer-events-none absolute bottom-2 left-1/2 z-50 h-[5px] w-[134px] -translate-x-1/2 rounded-full bg-text/70" />}
    </div>
  );
}

/** A phone status bar that shows the storm's local time (the sim clock), not the laptop's. */
function StatusBar() {
  const { wallet, timeZone } = useAid();
  const [now, setNow] = useState<string>(() => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, ""));
  useEffect(() => {
    if (wallet) return;
    const id = setInterval(() => setNow(new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, "")), 10_000);
    return () => clearInterval(id);
  }, [wallet]);
  const time = wallet ? simClock(wallet.simNow, timeZone) : now;
  return (
    <div className="relative z-40 flex h-[50px] shrink-0 items-center justify-between px-8 pt-1.5 text-[15px] font-semibold tabular text-text">
      <span className="w-14" title={wallet ? `Storm time: ${simDay(wallet.simNow, timeZone)}` : undefined}>
        {time}
      </span>
      <span className="absolute left-1/2 top-[11px] h-[31px] w-[118px] -translate-x-1/2 rounded-full bg-black" />
      <span className="flex w-14 items-center justify-end gap-1.5">
        <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor" aria-hidden>
          <rect x="0" y="7" width="3" height="4" rx="0.8" />
          <rect x="4.5" y="5" width="3" height="6" rx="0.8" />
          <rect x="9" y="2.5" width="3" height="8.5" rx="0.8" />
          <rect x="13.5" y="0" width="3" height="11" rx="0.8" opacity="0.35" />
        </svg>
        <svg width="24" height="12" viewBox="0 0 24 12" fill="none" aria-hidden>
          <rect x="0.5" y="0.5" width="20" height="11" rx="3" stroke="currentColor" opacity="0.45" />
          <rect x="2" y="2" width="11" height="8" rx="1.6" fill="currentColor" />
          <rect x="21.5" y="4" width="1.8" height="4" rx="0.9" fill="currentColor" opacity="0.45" />
        </svg>
      </span>
    </div>
  );
}

function SignedIn({ desktop }: { desktop: boolean }) {
  const { wallet } = useAid();
  const [tab, setTab] = useState<Tab>("wallet");
  const [celebrate, setCelebrate] = useState(false);
  const sawWaiting = useRef(false);
  const landed = wallet?.aid.landed;
  useEffect(() => {
    if (landed === false) sawWaiting.current = true;
    if (landed && sawWaiting.current) {
      sawWaiting.current = false;
      setCelebrate(true);
    }
  }, [landed]);

  if (!wallet) {
    return <div className="grid h-full place-items-center text-text-3" />;
  }
  if (!wallet.aid.landed) return <WaitingForAid />;
  if (celebrate) return <AidLanded onDone={() => setCelebrate(false)} />;
  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <TabPanel active={tab === "wallet"}>
          <WalletTab onAsk={() => setTab("ask")} />
        </TabPanel>
        <TabPanel active={tab === "ask"}>
          <AskTab active={tab === "ask"} />
        </TabPanel>
        <TabPanel active={tab === "shop"}>
          <ShopTab active={tab === "shop"} onReceipts={() => setTab("receipts")} />
        </TabPanel>
        <TabPanel active={tab === "receipts"}>
          <ReceiptsTab active={tab === "receipts"} />
        </TabPanel>
      </div>
      <TabBar tab={tab} onChange={setTab} desktop={desktop} />
    </div>
  );
}

/** Tabs stay mounted (chat, cart and scroll survive switching); the active one fades up. */
function TabPanel({ active, children }: { active: boolean; children: React.ReactNode }) {
  const { reduce } = useMotion();
  return (
    <motion.div
      className={cx("absolute inset-0", !active && "pointer-events-none")}
      initial={false}
      animate={active ? { opacity: 1, y: 0, visibility: "visible" } : { opacity: 0, y: reduce ? 0 : 8, transitionEnd: { visibility: "hidden" } }}
      transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
      aria-hidden={!active}
    >
      {children}
    </motion.div>
  );
}

const TABS: { id: Tab; label: string; icon: typeof IconWallet }[] = [
  { id: "wallet", label: "Wallet", icon: IconWallet },
  { id: "ask", label: "Ask Grok", icon: IconSpark },
  { id: "shop", label: "Shop", icon: IconBag },
  { id: "receipts", label: "Receipts", icon: IconReceipt },
];

function TabBar({ tab, onChange, desktop }: { tab: Tab; onChange: (t: Tab) => void; desktop: boolean }) {
  const { spring } = useMotion();
  return (
    <nav
      className="relative z-30 shrink-0 border-t border-line bg-surface-1/90 px-2 pt-1.5 backdrop-blur-xl"
      style={{ paddingBottom: desktop ? 22 : "max(8px, env(safe-area-inset-bottom))" }}
    >
      <div className="grid grid-cols-4">
        {TABS.map((t) => {
          const active = t.id === tab;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              className={cx("relative flex h-[52px] flex-col items-center justify-center gap-1 rounded-xl text-[10.5px] font-medium transition-colors", active ? "text-teal" : "text-text-3 hover:text-text-2")}
              aria-current={active ? "page" : undefined}
            >
              {active && <motion.span layoutId="aid-tab" transition={spring} className="absolute inset-x-3 inset-y-1 -z-0 rounded-xl bg-teal-soft/70" />}
              <Icon size={21} className="relative" strokeWidth={active ? 1.9 : 1.6} />
              <span className="relative">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
