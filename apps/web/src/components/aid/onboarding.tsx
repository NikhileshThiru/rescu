"use client";

import type { Eligibility, Persona, RunInfo, Session } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Mark } from "@/components/ui/mark";
import { NumberTicker } from "@/components/ui/number-ticker";
import { cx } from "@/components/ui/primitives";
import { setAllowance } from "@/lib/aid/actions";
import { centsShort, seconds, until } from "@/lib/aid/format";
import { createDeviceKey, keyId, saveDeviceKey } from "@/lib/aid/keys";
import { deviceId } from "@/lib/aid/session";
import { api, ApiRequestError } from "@/lib/api";
import { useAid } from "./aid-context";
import { IconArrow, IconBack, IconCheck, IconHome, IconLock, IconPin, IconSpark, IconStorm, IconUser } from "./icons";
import { BigButton, Card, EASE, ExplorerLink, Pill, Spinner, SuccessMark, useMotion } from "./ui";

type Step = { id: "welcome" } | { id: "personas" } | { id: "allow"; session: Session; persona: Persona } | { id: "here" };

export function Onboarding({ run }: { run: RunInfo | null }) {
  const [step, setStep] = useState<Step>({ id: "welcome" });
  const { fadeUp } = useMotion();
  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={step.id} {...fadeUp} className="min-h-full">
          {step.id === "welcome" && <Welcome run={run} onPersonas={() => setStep({ id: "personas" })} onHere={() => setStep({ id: "here" })} />}
          {step.id === "personas" && <PersonaPicker onBack={() => setStep({ id: "welcome" })} onClaimed={(session, persona) => setStep({ id: "allow", session, persona })} />}
          {step.id === "allow" && <AllowanceOffer session={step.session} persona={step.persona} />}
          {step.id === "here" && <LiveHere onBack={() => setStep({ id: "welcome" })} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Header({ onBack, title, sub }: { onBack?: () => void; title: string; sub?: string }) {
  return (
    <div className="px-5 pt-3">
      {onBack && (
        <button onClick={onBack} className="-ml-2 mb-2 inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm text-text-2 hover:text-text">
          <IconBack size={18} /> Back
        </button>
      )}
      <h2 className="text-[26px] font-semibold leading-8 tracking-tight">{title}</h2>
      {sub && <p className="mt-1.5 text-[14px] leading-5 text-text-3">{sub}</p>}
    </div>
  );
}

// ---------- welcome ----------

function Welcome({ run, onPersonas, onHere }: { run: RunInfo | null; onPersonas: () => void; onHere: () => void }) {
  const storm = run?.stormName.replace(/\s\d{4}$/, "") ?? "";
  const live = run?.phase === "live";
  const usable = run && (run.phase === "live" || run.phase === "ready");
  return (
    <div className="flex min-h-full flex-col px-5 pb-8 pt-6">
      <div className="flex items-center gap-2.5">
        <Mark size={22} />
        <div>
          <div className="text-[17px] font-semibold tracking-tight">Rescu</div>
          <div className="text-2xs text-text-3">Aid airdropped in seconds</div>
        </div>
      </div>

      <Card className="relative mt-7 overflow-hidden p-4">
        <StormGlyph />
        <div className="relative">
          <div className="eyebrow">{live ? "Disaster declared" : run?.phase === "ended" ? "Recovery closed" : "Storm watch"}</div>
          <div className="mt-1.5 text-[22px] font-semibold tracking-tight">{run ? `Hurricane ${storm}` : "Connecting…"}</div>
          {run && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill tone={live ? "teal" : "storm"}>{live ? "Relief network live" : run.phase === "ready" ? "Ready to declare" : run.phase === "ended" ? "Closed out" : "Preparing"}</Pill>
              <Pill>{run.households.toLocaleString("en-US")} households</Pill>
              <Pill>{run.merchants} relief stores</Pill>
            </div>
          )}
          <p className="mt-3 text-[13px] leading-5 text-text-3">
            Relief dollars for groceries, water, medicine and repairs. Spendable only at verified stores, with the rules enforced on Solana.
          </p>
        </div>
      </Card>

      <div className="mt-6 space-y-3">
        <ChoiceCard icon={IconUser} title="Pick a resident" text="Step into one of six households in the storm's path." onClick={onPersonas} disabled={!usable} />
        <ChoiceCard icon={IconHome} title="I live here" text="Register this phone. Your key never leaves it." onClick={onHere} disabled={!usable} />
      </div>
      {run && !usable && <p className="mt-4 text-center text-2xs text-text-3">The relief network opens once it&apos;s staged.</p>}
      <div className="mt-auto pt-8 text-center text-2xs text-text-3">A HackGT 13 demo · simulated storm replay on a local Solana validator</div>
    </div>
  );
}

function StormGlyph() {
  const { reduce } = useMotion();
  return (
    <motion.svg
      width="170"
      height="170"
      viewBox="0 0 100 100"
      className="pointer-events-none absolute -right-10 -top-12 text-storm/10"
      animate={reduce ? undefined : { rotate: -360 }}
      transition={{ duration: 40, ease: "linear", repeat: Infinity }}
    >
      <g fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round">
        <path d="M58 18a33 33 0 0 0-40 26" />
        <path d="M42 82a33 33 0 0 0 40-26" />
        <circle cx="50" cy="50" r="9" />
      </g>
    </motion.svg>
  );
}

function ChoiceCard({ icon: Icon, title, text, onClick, disabled }: { icon: typeof IconUser; title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center gap-3.5 rounded-2xl border border-line bg-surface-1 p-4 text-left transition-[border,background,transform] duration-150 hover:border-line-strong hover:bg-surface-2 active:scale-[0.99] disabled:opacity-40"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-3 text-teal">
        <Icon size={21} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-text">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-text-3">{text}</span>
      </span>
      <IconArrow size={18} className="shrink-0 text-text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-text-2" />
    </button>
  );
}

// ---------- personas ----------

const AVATAR = ["#2dd4bf", "#86a8e2", "#a78bfa", "#f5b83d", "#f0616d", "#7dd3fc"];

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function PersonaPicker({ onBack, onClaimed }: { onBack: () => void; onClaimed: (s: Session, p: Persona) => void }) {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { wallet, run } = useAid();
  const { reduce } = useMotion();
  const simNow = wallet?.simNow ?? null;

  useEffect(() => {
    let stop = false;
    const load = () =>
      api("GET /api/market/personas")
        .then((p) => !stop && setPersonas(p))
        .catch((e: Error) => !stop && setError(e.message));
    void load();
    const id = setInterval(load, 3_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  async function claim(p: Persona) {
    setBusy(p.resident);
    setError(null);
    try {
      const s = await api("POST /api/market/personas/:resident/claim", { params: { resident: p.resident } });
      onClaimed(s, p);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="pb-8">
      <Header onBack={onBack} title="Pick a resident" sub={`Six households in ${run ? `Hurricane ${run.stormName.replace(/\s\d{4}$/, "")}'s` : "the storm's"} path. You'll see their wallet and shop for them.`} />
      <div className="mt-5 space-y-2.5 px-5">
        {!personas && !error && [0, 1, 2, 3].map((i) => <div key={i} className="h-[92px] animate-pulse rounded-2xl bg-surface-1" />)}
        {personas?.map((p, i) => (
          <motion.button
            key={p.resident}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduce ? 0 : i * 0.04, duration: 0.35, ease: EASE }}
            onClick={() => claim(p)}
            disabled={busy !== null}
            className="flex w-full items-start gap-3 rounded-2xl border border-line bg-surface-1 p-3.5 text-left transition-[border,background] duration-150 hover:border-line-strong hover:bg-surface-2 disabled:opacity-60"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-bg" style={{ background: AVATAR[i % AVATAR.length] }}>
              {busy === p.resident ? <Spinner /> : initials(p.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[15px] font-semibold text-text">{p.name}</span>
                <span className="shrink-0 text-[15px] font-semibold tabular text-teal">{centsShort(p.aidCents)}</span>
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-[17px] text-text-3">{p.blurb}</span>
              <span className="mt-2 flex flex-wrap gap-1.5">
                {p.landed ? <Pill tone="teal">Aid landed</Pill> : <Pill tone="storm">{simNow !== null ? `Aid in ${until(p.aidDueAt - simNow)}` : "Aid on the way"}</Pill>}
                {p.claimed && <Pill>In use on another phone</Pill>}
              </span>
            </span>
          </motion.button>
        ))}
        {error && <p className="rounded-xl bg-red-soft px-3 py-2 text-[13px] text-red">{error}</p>}
      </div>
    </div>
  );
}

// ---------- Grok allowance ----------

function AllowanceOffer({ session, persona }: { session: Session; persona: Persona }) {
  const { signIn } = useAid();
  const [busy, setBusy] = useState(false);
  const [sig, setSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { reduce } = useMotion();

  async function allow() {
    setBusy(true);
    setError(null);
    try {
      const w = await setAllowance(session, 15_000);
      setSig(w?.agent.signature ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const done = sig !== null;
  return (
    <div className="flex min-h-full flex-col px-5 pb-8 pt-8">
      <div className="flex items-center gap-2 text-sm text-text-2">
        <IconCheck size={16} className="text-teal" /> You&apos;re {persona.name}, {persona.county}
      </div>
      <div className="mt-8 grid place-items-center">
        <motion.div
          className="relative grid size-20 place-items-center rounded-3xl bg-teal-soft text-teal ring-1 ring-teal/25"
          animate={reduce || done ? undefined : { boxShadow: ["0 0 0 0 rgb(45 212 191 / 0.25)", "0 0 0 16px rgb(45 212 191 / 0)"] }}
          transition={{ duration: 1.8, repeat: Infinity }}
        >
          <IconSpark size={36} />
        </motion.div>
      </div>
      <h2 className="mt-6 text-center text-[24px] font-semibold leading-8 tracking-tight">{done ? "Grok can shop for you" : "Let Grok shop for you?"}</h2>
      <p className="mx-auto mt-2 max-w-[300px] text-center text-[14px] leading-5 text-text-3">
        {done
          ? "The allowance is on-chain. Grok proposes, you confirm, and it can never spend past what you allowed."
          : "Grok can spend up to $150 of your relief dollars, only at verified stores, inside the $200 per order and $300 a day limits. Revoke it any time."}
      </p>
      <Card className="mt-6 divide-y divide-line">
        {[
          ["Allowance", "$150.00"],
          ["Enforced by", "Solana token delegate"],
          ["You confirm", "Every order"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between px-4 py-3 text-[13px]">
            <span className="text-text-3">{k}</span>
            <span className="font-medium text-text">{v}</span>
          </div>
        ))}
      </Card>
      <AnimatePresence>
        {done && (
          <motion.div initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-4 flex items-center justify-center gap-2 text-2xs text-teal">
            <IconCheck size={14} /> Approved on-chain · <ExplorerLink signature={sig} label="View transaction" className="text-teal/80" />
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p className="mt-4 rounded-xl bg-red-soft px-3 py-2 text-[13px] text-red">{error}</p>}
      <div className="mt-auto space-y-1 pt-8">
        {done ? (
          <BigButton onClick={() => signIn(session)}>
            Open {persona.name.split(" ")[0]}&apos;s wallet <IconArrow size={18} />
          </BigButton>
        ) : (
          <>
            <BigButton onClick={allow} busy={busy}>
              Allow up to $150
            </BigButton>
            <BigButton tone="ghost" onClick={() => signIn(session)} disabled={busy}>
              Not now
            </BigButton>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- "I live here" ----------

type HereStep = "where" | "who" | "verify";

function LiveHere({ onBack }: { onBack: () => void }) {
  const { run, signIn } = useAid();
  const [step, setStep] = useState<HereStep>("where");
  const [spot, setSpot] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const [el, setEl] = useState<Eligibility | null>(null);
  const [towns, setTowns] = useState<{ lat: number; lon: number; label: string }[]>([]);
  const [locating, setLocating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { fadeUp } = useMotion();

  useEffect(() => {
    api("GET /api/market/personas")
      .then((ps) => {
        const seen = new Set<string>();
        setTowns(ps.filter((p) => !seen.has(p.county) && seen.add(p.county)).map((p) => ({ lat: p.lat, lon: p.lon, label: p.county })));
      })
      .catch(() => {});
  }, []);

  async function check(lat: number, lon: number, label: string) {
    setChecking(true);
    setError(null);
    setSpot({ lat, lon, label });
    try {
      setEl(await api("GET /api/market/eligibility", { query: { lat, lon } }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  function locate() {
    if (!navigator.geolocation) {
      setError("This browser can't share its location. Pick a spot instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        void check(pos.coords.latitude, pos.coords.longitude, "Your location");
      },
      () => {
        setLocating(false);
        setError("Couldn't get your location. Pick a spot instead.");
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );
  }

  return (
    <div className="flex min-h-full flex-col pb-8">
      <Header
        onBack={step === "where" ? onBack : () => setStep(step === "verify" ? "who" : "where")}
        title={step === "where" ? "Where do you live?" : step === "who" ? "Who's registering?" : "Setting up your wallet"}
        sub={
          step === "where"
            ? "Aid goes to homes in the declared disaster area."
            : step === "who"
              ? "A quick ID check stops duplicate registrations."
              : "Your key is created on this phone and never leaves it."
        }
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={step} {...fadeUp} className="flex flex-1 flex-col px-5 pt-5">
          {step === "where" && (
            <>
              <BigButton tone="outline" onClick={locate} busy={locating}>
                <IconPin size={18} /> Use my location
              </BigButton>
              <div className="mb-2 mt-6 eyebrow">Or pick a town in the storm zone</div>
              <div className="flex flex-wrap gap-2">
                {towns.map((t) => (
                  <button
                    key={t.label}
                    onClick={() => check(t.lat, t.lon, t.label)}
                    className={cx(
                      "h-10 rounded-full border px-3.5 text-[13px] font-medium transition-colors",
                      spot?.label === t.label ? "border-teal/40 bg-teal-soft text-teal" : "border-line bg-surface-1 text-text-2 hover:border-line-strong hover:text-text",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="mt-5 min-h-[120px]">
                {checking && (
                  <div className="flex items-center gap-2 text-[13px] text-text-3">
                    <Spinner /> Checking the declared area…
                  </div>
                )}
                {!checking && el && spot && (
                  <motion.div {...fadeUp}>
                    {el.eligible ? (
                      <Card tone="teal" className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-2xs text-text-3">{spot.label === "Your location" ? "Your location" : "Home"} · {el.county}</div>
                            <div className="mt-1 text-[22px] font-semibold tabular text-teal">{centsShort(el.aidCents)}</div>
                          </div>
                          <Pill tone="teal">Eligible</Pill>
                        </div>
                        <p className="mt-2 text-[13px] leading-5 text-text-3">
                          {el.aidDueAt !== null ? "Lands in your wallet the moment the storm reaches this spot." : "Lands in your wallet right after you register."}
                        </p>
                      </Card>
                    ) : (
                      <Card tone="amber" className="p-4">
                        <div className="text-[14px] font-medium text-amber">Not in the declared area</div>
                        <p className="mt-1 text-[13px] leading-5 text-text-3">{el.reason}</p>
                        {el.suggestion && (
                          <BigButton tone="outline" className="mt-3" onClick={() => check(el.suggestion!.lat, el.suggestion!.lon, el.suggestion!.county)}>
                            Use {el.suggestion.county} instead
                          </BigButton>
                        )}
                      </Card>
                    )}
                  </motion.div>
                )}
              </div>
              {error && <p className="mt-3 rounded-xl bg-red-soft px-3 py-2 text-[13px] text-red">{error}</p>}
              <div className="mt-auto pt-6">
                <BigButton disabled={!el?.eligible} onClick={() => setStep("who")}>
                  Continue
                </BigButton>
              </div>
            </>
          )}
          {step === "who" && (
            <>
              <label className="block">
                <span className="text-xs text-text-3">Your name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 40))}
                  placeholder="First name and initial"
                  autoFocus
                  className="mt-1.5 h-12 w-full rounded-xl border border-line bg-surface-1 px-4 text-[16px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-teal/50"
                />
              </label>
              <label className="mt-4 block">
                <span className="text-xs text-text-3">Phone (optional)</span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.slice(0, 24))}
                  inputMode="tel"
                  placeholder="(555) 555-0100"
                  className="mt-1.5 h-12 w-full rounded-xl border border-line bg-surface-1 px-4 text-[16px] text-text outline-none transition-colors placeholder:text-text-3 focus:border-teal/50"
                />
              </label>
              <p className="mt-4 flex items-start gap-2 text-2xs leading-4 text-text-3">
                <IconLock size={14} className="mt-0.5 shrink-0" />
                Demo ID check: we match this device, phone and address against other registrations so one household can&apos;t claim aid twice.
              </p>
              <div className="mt-auto pt-6">
                <BigButton disabled={!name.trim()} onClick={() => setStep("verify")}>
                  Verify &amp; register
                </BigButton>
              </div>
            </>
          )}
          {step === "verify" && spot && el && (
            <Register
              name={name.trim()}
              phone={phone.trim()}
              spot={spot}
              onDone={(s) => signIn(s)}
              onError={(msg) => {
                setError(msg);
                setStep("where");
              }}
              runId={run?.id ?? ""}
            />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

const CHECKS = ["Device checked", "No duplicate registration", "Home in the declared area", "Wallet key created on this phone", "Registered on-chain"];

function Register({
  name,
  phone,
  spot,
  onDone,
  onError,
}: {
  name: string;
  phone: string;
  spot: { lat: number; lon: number };
  runId: string;
  onDone: (s: Session) => void;
  onError: (msg: string) => void;
}) {
  const [done, setDone] = useState(0);
  const [custody, setCustody] = useState<"device" | "server" | null>(null);
  const { reduce } = useMotion();

  useEffect(() => {
    let stop = false;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
    (async () => {
      for (let i = 1; i <= 3; i++) {
        await wait(420);
        if (stop) return;
        setDone(i);
      }
      const key = await createDeviceKey();
      if (stop) return;
      setCustody(key ? "device" : "server");
      setDone(4);
      try {
        const s = await api("POST /api/market/join", {
          body: { lat: spot.lat, lon: spot.lon, name, pubkey: key?.pubkey ?? null, identity: { deviceId: deviceId(), ...(phone ? { phone } : {}) } },
        });
        if (key) await saveDeviceKey(keyId(s.runId, s.resident), key.keys);
        if (stop) return;
        setDone(5);
        await wait(500);
        if (!stop) onDone(s);
      } catch (err) {
        if (!stop) onError(err instanceof ApiRequestError ? err.message : "Registration failed");
      }
    })();
    return () => {
      stop = true;
    };
    // Runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pt-2">
      <ul className="space-y-3">
        {CHECKS.map((c, i) => {
          const ok = done > i;
          const active = done === i;
          return (
            <li key={c} className="flex items-center gap-3">
              <span className={cx("grid size-7 place-items-center rounded-full transition-colors duration-300", ok ? "bg-teal text-bg" : "bg-surface-2 text-text-3")}>
                {ok ? <IconCheck size={15} strokeWidth={2.5} /> : active ? <Spinner className="size-3.5" /> : <span className="size-1.5 rounded-full bg-text-3" />}
              </span>
              <span className={cx("text-[14px] transition-colors", ok ? "text-text" : "text-text-3")}>
                {i === 3 && custody === "server" ? "This browser can't hold a key; Rescu holds it for you" : c}
              </span>
            </li>
          );
        })}
      </ul>
      {custody === "device" && (
        <p className="mt-6 flex items-start gap-2 rounded-xl border border-teal/20 bg-teal-soft/40 px-3 py-2.5 text-2xs leading-4 text-text-2">
          <IconLock size={14} className="mt-0.5 shrink-0 text-teal" />
          Ed25519 key generated with WebCrypto, non-extractable. Rescu relays your signed payments and pays the fees; it can&apos;t spend for you.
        </p>
      )}
    </div>
  );
}

// ---------- waiting for the storm, then the aid moment ----------

export function WaitingForAid() {
  const { wallet, run, timeZone } = useAid();
  const { reduce } = useMotion();
  if (!wallet) return null;
  const due = wallet.aid.dueAt - wallet.simNow;
  const storm = run?.stormName.replace(/\s\d{4}$/, "") ?? "the storm";
  const declared = run?.phase === "live";
  return (
    <div className="flex h-full flex-col items-center px-6 pb-10 pt-10 text-center">
      <div className="relative grid size-44 place-items-center">
        {!reduce &&
          [0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="absolute inset-0 rounded-full border border-storm/25"
              initial={{ scale: 0.35, opacity: 0.9 }}
              animate={{ scale: 1, opacity: 0 }}
              transition={{ duration: 3, repeat: Infinity, delay: i, ease: "easeOut" }}
            />
          ))}
        <motion.span
          className="grid size-16 place-items-center rounded-full bg-storm-soft text-storm ring-1 ring-storm/20"
          animate={reduce ? undefined : { rotate: -360 }}
          transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
        >
          <IconStorm size={30} />
        </motion.span>
      </div>
      <div className="mt-6 eyebrow">{declared ? "Registered on-chain" : "Registered · waiting for the declaration"}</div>
      <h2 className="mt-2 text-[24px] font-semibold leading-8 tracking-tight">
        {centsShort(wallet.aid.cents)} lands when {storm} reaches you
      </h2>
      <p className="mt-2 max-w-[290px] text-[14px] leading-5 text-text-3">
        {declared
          ? due > 0
            ? `The storm reaches ${wallet.home.county} in about ${until(due)} (storm time). Keep this open.`
            : "The storm is at your door. Your aid is on its way to your wallet now."
          : "An official hasn't declared the disaster yet. Aid flows the moment they do and the storm reaches you."}
      </p>
      <Card className="mt-8 w-full divide-y divide-line text-left">
        <Row k="Wallet" v={<ExplorerLink address={wallet.owner} />} />
        <Row k="Home" v={wallet.home.county} />
        <Row k="Key" v={wallet.custody === "device" ? "On this phone" : "Held by Rescu (demo)"} />
        <Row k="Storm time" v={new Date(wallet.simNow * 1000).toLocaleString("en-US", { timeZone, weekday: "short", hour: "numeric", minute: "2-digit" })} />
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
      <span className="text-text-3">{k}</span>
      <span className="truncate font-medium text-text">{v}</span>
    </div>
  );
}

export function AidLanded({ onDone }: { onDone: () => void }) {
  const { wallet } = useAid();
  const { reduce } = useMotion();
  if (!wallet) return null;
  return (
    <div className="relative flex h-full flex-col items-center overflow-hidden px-6 pb-10 pt-14 text-center">
      <motion.div
        className="pointer-events-none absolute left-1/2 top-24 size-[520px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgb(45_212_191/0.28),transparent_62%)]"
        initial={reduce ? false : { scale: 0.2, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 1.2, ease: EASE }}
      />
      <SuccessMark size={64} />
      <div className="relative mt-6 eyebrow text-teal/80">Aid landed</div>
      <div className="relative mt-2 text-[52px] font-semibold leading-none tracking-tight text-text">
        <NumberTicker value={wallet.balanceCents / 100} duration={1.6} format={(x) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
      </div>
      <p className="relative mt-3 text-[15px] text-text-2">relief dollars, in your wallet</p>
      {wallet.aid.timeToAidMs !== null && (
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: reduce ? 0 : 0.8 }}
          className="relative mt-6 inline-flex items-center gap-2 rounded-full border border-teal/25 bg-teal-soft px-3.5 py-1.5 text-[13px] text-teal"
        >
          {seconds(wallet.aid.timeToAidMs)} after the storm reached your home
        </motion.div>
      )}
      <p className="relative mt-4 max-w-[280px] text-[13px] leading-5 text-text-3">Traditional disaster food aid (D-SNAP) usually takes weeks. Spend this at any verified relief store.</p>
      <div className="relative mt-3">
        <ExplorerLink signature={wallet.aid.signature} label="See it on Solana" />
      </div>
      <div className="relative mt-auto w-full pt-8">
        <BigButton onClick={onDone}>
          Open my wallet <IconArrow size={18} />
        </BigButton>
      </div>
    </div>
  );
}
