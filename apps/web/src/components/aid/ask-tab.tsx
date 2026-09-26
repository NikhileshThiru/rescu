"use client";

import type { ChatResult, Order } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "@/components/ui/primitives";
import { type ChatEntry, loadChat, saveChat } from "@/lib/aid/session";
import { useSpeech } from "@/lib/aid/speech";
import { api, ApiRequestError } from "@/lib/api";
import { useAid } from "./aid-context";
import { IconMic, IconSearch, IconSend, IconSpark } from "./icons";
import { OrderCard } from "./order-card";
import { EASE, useMotion } from "./ui";

const DEFAULT_PROMPTS = ["Storm hit, out of water and food, no power.", "Roof is leaking. Tarp and cleanup supplies, please.", "I need my prescription refilled and food for a few days."];
const THINKING = ["Checking stores near you", "Comparing prices and stock", "Fitting it to your limits", "Putting an order together"];

let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

export function AskTab({ active }: { active: boolean }) {
  const { session, wallet } = useAid();
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [prompts, setPrompts] = useState<string[]>(DEFAULT_PROMPTS);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const token = session?.token ?? "";

  useEffect(() => {
    if (!token) return;
    setChat(loadChat(token));
    api("GET /api/market/personas")
      .then((ps) => {
        const me = ps.find((p) => p.resident === session?.resident);
        if (me?.prompts.length) setPrompts(me.prompts);
      })
      .catch(() => {});
  }, [token, session?.resident]);

  const update = useCallback(
    (fn: (c: ChatEntry[]) => ChatEntry[]) =>
      setChat((c) => {
        const next = fn(c);
        if (token) saveChat(token, next);
        return next;
      }),
    [token],
  );

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [chat.length, thinking]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || thinking || !session) return;
      setInput("");
      const user: ChatEntry = { id: newId(), role: "user", content: t };
      const history = [...chatRef.current.filter((m) => !m.error), user];
      update((c) => [...c, user]);
      setThinking(true);
      try {
        const res: ChatResult = await api("POST /api/market/agent/chat", {
          body: { messages: history.slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 2000), ...(m.orders?.length ? { orders: m.orders } : {}) })) },
          token: session.token,
        });
        update((c) => [...c, { id: newId(), role: "assistant", content: res.reply, orders: res.orders.map((o) => o.id), cards: res.orders, tools: res.tools, fallback: res.fallback }]);
      } catch (err) {
        const msg = err instanceof ApiRequestError ? err.message : "Couldn't reach Grok. Try again.";
        update((c) => [...c, { id: newId(), role: "assistant", content: msg, error: true }]);
      } finally {
        setThinking(false);
      }
    },
    [thinking, session, update],
  );

  const speech = useSpeech((said) => void send(said));

  const setCard = (entry: string, o: Order) => update((c) => c.map((m) => (m.id === entry ? { ...m, cards: m.cards?.map((x) => (x.id === o.id ? o : x)) } : m)));

  const empty = chat.length === 0;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center justify-between px-5 pb-2 pt-2">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-full bg-[linear-gradient(135deg,#2dd4bf,#86a8e2)] text-bg">
            <IconSpark size={17} />
          </span>
          <div>
            <div className="text-[15px] font-semibold leading-5">Grok</div>
            <div className="text-2xs text-text-3">Relief shopper · you confirm every payment</div>
          </div>
        </div>
        {chat.length > 0 && (
          <button onClick={() => update(() => [])} className="h-9 rounded-full px-3 text-2xs font-medium text-text-3 hover:text-text-2">
            New chat
          </button>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
        {empty ? (
          <EmptyState prompts={prompts} onPick={(p) => void send(p)} name={wallet?.name.split(" ")[0] ?? ""} disabled={thinking} />
        ) : (
          <div className="space-y-4 pt-2">
            {chat.map((m) => (
              <Message key={m.id} entry={m} onCard={(o) => setCard(m.id, o)} />
            ))}
          </div>
        )}
        <AnimatePresence>{thinking && <Thinking key="thinking" />}</AnimatePresence>
      </div>

      <Composer
        value={speech.listening ? speech.interim : input}
        onChange={setInput}
        onSend={() => void send(input)}
        listening={speech.listening}
        micSupported={speech.supported}
        onMic={() => (speech.listening ? speech.stop() : speech.start())}
        disabled={thinking}
        error={speech.error}
        active={active}
      />
    </div>
  );
}

function EmptyState({ prompts, onPick, name, disabled }: { prompts: string[]; onPick: (p: string) => void; name: string; disabled: boolean }) {
  const { reduce } = useMotion();
  return (
    <div className="flex min-h-full flex-col justify-end pb-2 pt-6">
      <div className="px-1">
        <h2 className="text-[24px] font-semibold leading-8 tracking-tight">
          What do you need{name ? `, ${name}` : ""}?
        </h2>
        <p className="mt-1.5 text-[14px] leading-5 text-text-3">Tell Grok in your own words. It finds the nearest open store with stock and puts an order together for you to confirm.</p>
      </div>
      <div className="mt-5 space-y-2">
        {prompts.map((p, i) => (
          <motion.button
            key={p}
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduce ? 0 : 0.05 + i * 0.05, duration: 0.35, ease: EASE }}
            disabled={disabled}
            onClick={() => onPick(p)}
            className="block w-full rounded-2xl border border-line bg-surface-1 px-4 py-3 text-left text-[14px] leading-5 text-text-2 transition-colors hover:border-teal/30 hover:bg-surface-2 hover:text-text"
          >
            {p}
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function Message({ entry, onCard }: { entry: ChatEntry; onCard: (o: Order) => void }) {
  const { fadeUp } = useMotion();
  if (entry.role === "user") {
    return (
      <motion.div {...fadeUp} className="flex justify-end">
        <div className="max-w-[82%] rounded-[20px] rounded-br-md bg-teal px-4 py-2.5 text-[14.5px] leading-5 text-bg">{entry.content}</div>
      </motion.div>
    );
  }
  return (
    <motion.div {...fadeUp} className="space-y-2.5">
      {!!entry.tools?.length && (
        <div className="flex flex-wrap gap-1.5">
          {entry.tools.map((t, i) => (
            <span key={i} className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-line bg-surface-1 px-2.5 py-1 text-[11px] text-text-3">
              {t.name === "search_items" || t.name === "list_stores" ? <IconSearch size={11} /> : <IconSpark size={11} />}
              <span className="truncate">{t.summary}</span>
            </span>
          ))}
        </div>
      )}
      <div
        className={cx(
          "max-w-[92%] rounded-[20px] rounded-bl-md border px-4 py-2.5 text-[14.5px] leading-[21px]",
          entry.error ? "border-red/25 bg-red-soft text-red" : "border-line bg-surface-2 text-text",
        )}
      >
        {entry.content}
      </div>
      {entry.fallback && <div className="pl-1 text-[11px] text-text-3">Grok is offline right now; Rescu&apos;s built-in shopper answered.</div>}
      {entry.cards?.map((o) => (
        <OrderCard key={o.id} order={o} payer="agent" onChange={onCard} />
      ))}
    </motion.div>
  );
}

function Thinking() {
  const [i, setI] = useState(0);
  const { reduce } = useMotion();
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % THINKING.length), 1_600);
    return () => clearInterval(id);
  }, []);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 flex items-center gap-2.5">
      <div className="flex h-9 items-center gap-1 rounded-[18px] rounded-bl-md border border-line bg-surface-2 px-3.5">
        {[0, 1, 2].map((d) => (
          <motion.span
            key={d}
            className="size-1.5 rounded-full bg-text-2"
            animate={reduce ? undefined : { opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
            transition={{ duration: 1, repeat: Infinity, delay: d * 0.15 }}
          />
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.span key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="text-[12px] text-text-3">
          {THINKING[i]}…
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  listening,
  micSupported,
  onMic,
  disabled,
  error,
  active,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  listening: boolean;
  micSupported: boolean;
  onMic: () => void;
  disabled: boolean;
  error: string | null;
  active: boolean;
}) {
  const { reduce } = useMotion();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active) ref.current?.blur();
  }, [active]);
  return (
    <div className="shrink-0 border-t border-line bg-bg/95 px-3 pb-3 pt-2.5">
      {error && <div className="mb-1.5 px-2 text-[11px] text-red">{error}</div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        className={cx("flex items-center gap-2 rounded-full border bg-surface-1 py-1 pl-4 pr-1 transition-colors", listening ? "border-teal/50" : "border-line focus-within:border-line-strong")}
      >
        {listening ? (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Waveform reduce={reduce} />
            <span className="truncate text-[14.5px] text-text-2">{value || "Listening…"}</span>
          </div>
        ) : (
          <input
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Ask for water, food, medicine…"
            className="h-10 min-w-0 flex-1 bg-transparent text-[16px] text-text outline-none placeholder:text-text-3"
            maxLength={600}
          />
        )}
        {micSupported && (
          <button
            type="button"
            onClick={onMic}
            disabled={disabled}
            aria-label={listening ? "Stop listening" : "Speak"}
            className={cx("relative grid size-11 shrink-0 place-items-center rounded-full transition-colors", listening ? "bg-teal text-bg" : "text-text-2 hover:bg-surface-3 hover:text-text")}
          >
            {listening && !reduce && <motion.span className="absolute inset-0 rounded-full bg-teal/40" animate={{ scale: [1, 1.35], opacity: [0.6, 0] }} transition={{ duration: 1.2, repeat: Infinity }} />}
            <IconMic size={20} className="relative" />
          </button>
        )}
        {!listening && (
          <button
            type="submit"
            disabled={disabled || !value.trim()}
            aria-label="Send"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-teal text-bg transition-opacity disabled:opacity-30"
          >
            <IconSend size={19} strokeWidth={2.2} />
          </button>
        )}
      </form>
    </div>
  );
}

function Waveform({ reduce }: { reduce: boolean }) {
  return (
    <span className="flex h-6 shrink-0 items-center gap-[3px]" aria-hidden>
      {[0.5, 0.9, 0.65, 1, 0.55, 0.8].map((h, i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-teal"
          style={{ height: 22 * h }}
          animate={reduce ? undefined : { scaleY: [0.35, 1, 0.5, 0.9, 0.35] }}
          transition={{ duration: 0.9 + i * 0.13, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}
