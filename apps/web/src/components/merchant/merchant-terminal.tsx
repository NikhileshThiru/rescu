"use client";

import type { Listing, StoreActivity, StoreDetail, StoreSummary } from "@rescu/live";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useLive } from "@/lib/live";
import { NumberTicker } from "../ui/number-ticker";
import { Badge, Button, Dot, Panel } from "../ui/primitives";
import { ActivityFeed } from "./activity";
import { CATEGORY_LABEL, txHref } from "./money";
import { PageBar, PageShell, useLiveClient } from "./page-bar";
import { RingUp } from "./ring-up";
import { type SaveState, Shelf } from "./shelf";
import { StorePicker, storeTone } from "./store-picker";

const ACTIVITY_MS = 1_000;
const DETAIL_MS = 4_000;
const STORES_MS = 15_000;
const KEEP = 60;

function readStoreParam(): number | null {
  try {
    const v = new URLSearchParams(window.location.search).get("store");
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** The merchant terminal: any store's shelf, prices, live activity and counter QR charges. */
export function MerchantTerminal() {
  const live = useLiveClient();
  const run = useLive(live, (s) => s.run);
  const states = useLive(live, (s) => s.stores);
  const runId = run?.id ?? null;
  const cluster = run?.explorerCluster ?? null;

  const [stores, setStores] = useState<StoreSummary[] | null>(null);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(() => (typeof window === "undefined" ? null : readStoreParam()));
  const [detail, setDetail] = useState<StoreDetail | null>(null);
  const [events, setEvents] = useState<StoreActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [save, setSave] = useState<SaveState | null>(null);
  const [ringOpen, setRingOpen] = useState(false);
  const [lastApp, setLastApp] = useState<{ merchant: number; label: string; at: number } | null>(null);
  const seq = useRef(0);
  const detailBump = useRef<() => void>(() => {});
  const saveInFlight = useRef(false);

  // ---- the store list (all stores, incl. suspended) ----
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const load = async () => {
      try {
        const list = await api("GET /api/merchant/stores");
        if (stop) return;
        setStores(list);
        setStoresError(null);
        setSelected((cur) => (cur !== null && list.some((s) => s.idx === cur) ? cur : (pickDefault(list) ?? cur)));
      } catch (err) {
        if (!stop) setStoresError((err as Error).message);
      }
    };
    void load();
    const id = setInterval(load, STORES_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [runId]);

  // Keep ?store= in the URL (deep link) without a navigation.
  useEffect(() => {
    if (selected === null) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("store") === String(selected)) return;
    url.searchParams.set("store", String(selected));
    window.history.replaceState(null, "", url);
  }, [selected]);

  // ---- the selected store's detail ----
  useEffect(() => {
    if (selected === null || !runId) return;
    let stop = false;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const d = await api("GET /api/merchant/stores/:idx", { params: { idx: selected } });
        if (!stop) setDetail((cur) => (cur && cur.idx === d.idx && saveInFlight.current ? { ...d, listings: cur.listings } : d));
      } catch {
        // keep the last good one
      } finally {
        pending = false;
      }
    };
    setDetail((cur) => (cur?.idx === selected ? cur : null));
    void load();
    detailBump.current = () => void load();
    const id = setInterval(load, DETAIL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [selected, runId]);

  // ---- activity, polled every second with `since` ----
  useEffect(() => {
    if (selected === null || !runId) return;
    let stop = false;
    seq.current = 0;
    setEvents([]);
    setActivityLoading(true);
    const poll = async () => {
      try {
        const page = await api("GET /api/merchant/stores/:idx/activity", { params: { idx: selected }, query: { since: seq.current } });
        if (stop) return;
        setActivityLoading(false);
        if (page.events.length) {
          seq.current = Math.max(seq.current, page.events[0]!.seq);
          setEvents((cur) => [...page.events, ...cur.filter((e) => e.seq < page.events[page.events.length - 1]!.seq)].slice(0, KEEP));
          detailBump.current();
        } else if (!seq.current) seq.current = page.seq;
      } catch {
        if (!stop) setActivityLoading(false);
      }
    };
    void poll();
    const id = setInterval(poll, ACTIVITY_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [selected, runId]);

  // ---- the latest app/agent purchase anywhere (jump there) ----
  useEffect(() => {
    const off = live.onBatch((b) => {
      for (let i = b.spotlight.length - 1; i >= 0; i--) {
        const s = b.spotlight[i]!;
        if (s.kind === "order" && s.merchant !== null) {
          setLastApp({ merchant: s.merchant, label: s.label, at: Date.now() });
          return;
        }
      }
    });
    return () => {
      off();
    };
  }, [live]);

  // ---- price edits: optimistic, then the server's listing ----
  const editPrice = useCallback(
    async (itemId: number, cents: number) => {
      if (selected === null) return;
      const m = selected;
      let before: Listing | undefined;
      setDetail((d) => {
        if (!d || d.idx !== m) return d;
        before = d.listings.find((l) => l.itemId === itemId);
        return { ...d, listings: d.listings.map((l) => (l.itemId === itemId ? { ...l, priceCents: cents } : l)) };
      });
      saveInFlight.current = true;
      setSave({ itemId, phase: "saving" });
      try {
        const listing = await api("PATCH /api/merchant/stores/:idx/prices", { params: { idx: m }, body: { itemId, priceCents: cents } });
        setDetail((d) => (d && d.idx === m ? { ...d, listings: d.listings.map((l) => (l.itemId === itemId ? listing : l)) } : d));
        setSave({ itemId, phase: "saved" });
      } catch (err) {
        setDetail((d) => (d && d.idx === m && before ? { ...d, listings: d.listings.map((l) => (l.itemId === itemId ? before! : l)) } : d));
        setSave({ itemId, phase: "error", message: err instanceof ApiRequestError ? err.message : "Couldn't save" });
      } finally {
        saveInFlight.current = false;
        setTimeout(() => setSave((s) => (s?.itemId === itemId && s.phase !== "saving" ? null : s)), 1_600);
      }
    },
    [selected],
  );

  const summary = stores?.find((s) => s.idx === selected) ?? null;
  const store = detail && detail.idx === selected ? detail : null;
  const st = selected !== null ? states[selected] : undefined;
  const status = st?.status ?? store?.status ?? summary?.status ?? "approved";
  const flagged = st ? st.flagged : (store?.flagged ?? summary?.flagged ?? false);
  const caseId = st?.caseId ?? null;
  const statusEvent = events.find((e) => e.kind === "status");
  const noRun = !run || run.phase === "offline" || run.phase === "staging";

  return (
    <PageShell>
      <PageBar live={live} title="Merchant terminal" />
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_360px] gap-3 p-3">
        {/* Picker */}
        <Panel className="flex min-h-0 flex-col overflow-hidden">
          <AnimatePresence>
            {lastApp && lastApp.merchant !== selected && (
              <motion.button
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                onClick={() => setSelected(lastApp.merchant)}
                className="mx-3 mt-3 flex items-center gap-2 overflow-hidden rounded-lg border border-teal/25 bg-teal-soft/60 px-2.5 py-2 text-left"
              >
                <Dot tone="teal" pulse />
                <span className="min-w-0 flex-1">
                  <span className="block text-2xs text-teal">Latest app purchase</span>
                  <span className="block truncate text-xs text-text">{lastApp.label}</span>
                </span>
                <span className="text-xs text-teal">Open →</span>
              </motion.button>
            )}
          </AnimatePresence>
          <StorePicker stores={stores} states={states} selected={selected} onSelect={setSelected} />
        </Panel>

        {/* Store */}
        <Panel className="flex min-h-0 flex-col overflow-hidden">
          {noRun ? (
            <Empty title={run?.phase === "staging" ? "Preparing the relief network…" : "No relief network is running"} body="Start one from the Command Center; every store in it shows up here." />
          ) : storesError && !stores ? (
            <Empty title="Can't reach the Rescu server" body={storesError} />
          ) : !summary ? (
            <Empty title="Pick a store" body="Search on the left, or open a store from the Oracle." />
          ) : (
            <>
              <AnimatePresence initial={false}>
                {status === "suspended" && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
                    <div className="flex items-center gap-3 border-b border-red/25 bg-red-soft px-5 py-3">
                      <ShieldX />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-red">Suspended on-chain by the oracle</div>
                        <div className="text-xs text-red/80">Relief payments to this store are refused by the chain.</div>
                      </div>
                      {txHref(statusEvent?.signature, cluster) && (
                        <a href={txHref(statusEvent!.signature, cluster)!} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-red/90 hover:text-red">
                          Transaction ↗
                        </a>
                      )}
                    </div>
                  </motion.div>
                )}
                {status !== "suspended" && flagged && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
                    <div className="flex items-center gap-3 border-b border-amber/25 bg-amber-soft px-5 py-2.5">
                      <Dot tone="amber" pulse />
                      <div className="min-w-0 flex-1 text-xs text-amber">The oracle flagged this store. An official can suspend it on-chain.</div>
                      {caseId && (
                        <a href={`/oracle?case=${encodeURIComponent(caseId)}`} className="shrink-0 text-xs text-amber hover:underline">
                          Open the case →
                        </a>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <header className="flex items-start gap-6 px-5 pt-5 pb-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={status} flagged={flagged} />
                    <Badge tone={summary.open ? "neutral" : "storm"}>{summary.open ? "Open" : "Closed by the storm"}</Badge>
                  </div>
                  <motion.h1 key={summary.idx} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mt-2 truncate text-[26px] font-semibold leading-8 tracking-tight">
                    {summary.name}
                  </motion.h1>
                  <div className="mt-1 text-sm text-text-3">
                    {CATEGORY_LABEL[summary.category]} · {summary.county}
                    <span className="ml-2 font-mono text-2xs text-text-3/80">#{summary.idx}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-end gap-6">
                  <div className="text-right">
                    <div className="text-xs text-text-3">Relief takings</div>
                    <div className="text-[26px] font-semibold leading-8 tracking-tight text-teal">
                      <NumberTicker value={store ? store.salesCents / 100 : 0} format={(x) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
                    </div>
                    <div className="text-2xs tabular text-text-3">
                      {store ? `${store.payments.toLocaleString("en-US")} payments` : "…"}
                      {store && store.blocked > 0 && <span className="text-red"> · {store.blocked} refused</span>}
                    </div>
                  </div>
                  <Button variant="solid" disabled={!store || status !== "approved" || !summary.open || run?.phase !== "live"} onClick={() => setRingOpen(true)} title={status !== "approved" ? "Suspended stores can't take relief payments" : undefined}>
                    <QrGlyph /> Ring up a sale
                  </Button>
                </div>
              </header>

              <div className="flex items-center justify-between px-5 pb-2">
                <h3 className="eyebrow">Shelf</h3>
                <span className="text-2xs text-text-3">Click a price to change it. The oracle checks it against nearby stores' pre-storm prices.</span>
              </div>
              {store ? (
                <Shelf listings={store.listings} save={save} onEdit={editPrice} disabled={run?.phase === "ended"} />
              ) : (
                <div className="space-y-1.5 px-5 pt-2">
                  {Array.from({ length: 12 }, (_, i) => (
                    <div key={i} className="h-8 animate-pulse rounded-md bg-surface-2/50" style={{ animationDelay: `${i * 50}ms` }} />
                  ))}
                </div>
              )}
            </>
          )}
        </Panel>

        {/* Activity */}
        <Panel className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-4 pb-2.5">
            <h2 className="eyebrow">Live at this store</h2>
            <span className="flex items-center gap-1.5 text-2xs text-text-3">
              <Dot tone="teal" pulse={!noRun} /> {noRun ? "Idle" : "Live"}
            </span>
          </div>
          <ActivityFeed events={events} cluster={cluster} loading={activityLoading && selected !== null && !noRun} />
          <div className="border-t border-line px-4 py-2.5 text-2xs leading-4 text-text-3">
            <span className="text-teal">Teal</span> landed on-chain · <span className="text-red">red</span> refused by the chain's rules · every row links to its transaction
          </div>
        </Panel>
      </div>
      {store && summary && (
        <RingUp store={store.idx} storeName={summary.name} listings={store.listings.filter((l) => l.stock > 0)} open={ringOpen} onClose={() => setRingOpen(false)} latest={events} cluster={cluster} />
      )}
    </PageShell>
  );
}

/** A busy, approved, open store: good for the demo when nothing is picked. */
function pickDefault(list: StoreSummary[]): number | null {
  const s = list.find((x) => x.status === "approved" && x.open && x.category === "grocery") ?? list[0];
  return s ? s.idx : null;
}

function StatusBadge({ status, flagged }: { status: StoreSummary["status"]; flagged: boolean }) {
  const tone = storeTone(status, flagged);
  const label = status === "suspended" ? "Suspended" : status === "pending" ? "Pending approval" : flagged ? "Flagged" : "Approved";
  return (
    <motion.span key={label} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 500, damping: 30 }}>
      <Badge tone={tone === "neutral" ? "neutral" : tone}>
        <Dot tone={tone} pulse={tone === "amber"} />
        {label}
      </Badge>
    </motion.span>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-8 text-center">
      <div className="text-sm font-medium text-text">{title}</div>
      <div className="max-w-sm text-xs text-text-3">{body}</div>
    </div>
  );
}

function ShieldX() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden className="shrink-0 text-red">
      <path d="M10 2 3.5 4.5v5c0 4 2.8 7 6.5 8.5 3.7-1.5 6.5-4.5 6.5-8.5v-5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m7.5 7.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function QrGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="1.5" y="1.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="8.5" y="1.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="8.5" width="4" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8.5 8.5h1.6v1.6H8.5zM11 11h1.5v1.5H11z" fill="currentColor" />
    </svg>
  );
}

