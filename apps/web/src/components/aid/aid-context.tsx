"use client";

import type { RunInfo, WalletView } from "@rescu/live";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError, apiBase } from "@/lib/api";
import { loadSession, type StoredSession, saveSession } from "@/lib/aid/session";

interface AidState {
  server: string;
  run: RunInfo | null;
  /** Can't reach the sim server. */
  offline: boolean;
  session: StoredSession | null;
  wallet: WalletView | null;
  timeZone: string;
  signIn: (s: Omit<StoredSession, "server">) => void;
  signOut: () => void;
  /** Re-reads the wallet now (after a payment). */
  refresh: () => Promise<void>;
  setWallet: (w: WalletView) => void;
}

const Ctx = createContext<AidState | null>(null);

export function useAid(): AidState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAid outside AidProvider");
  return v;
}

/** Signed-in helpers: the session is guaranteed inside the app screens. */
export function useSession() {
  const a = useAid();
  if (!a.session) throw new Error("no session");
  return a.session;
}

/**
 * The resident app's state: the run, the session (persisted), and the wallet, polled every 1.5 s
 * (0.5 s while the phone is waiting for its aid to land).
 */
export function AidProvider({ children }: { children: ReactNode }) {
  const [server, setServer] = useState("");
  const [run, setRun] = useState<RunInfo | null>(null);
  const [offline, setOffline] = useState(false);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [ready, setReady] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Run info (and the server) on mount, then every 5 s: a new run ends the session.
  useEffect(() => {
    const base = apiBase();
    setServer(base);
    const stored = loadSession(base);
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${base}/run`);
        const info = (await res.json()) as RunInfo | null;
        if (stop) return;
        setOffline(false);
        setRun(info);
        const s = sessionRef.current;
        if (s && info && info.id !== s.runId) {
          saveSession(null);
          setSession(null);
          setWallet(null);
        }
      } catch {
        if (!stop) setOffline(true);
      } finally {
        if (!stop) setReady(true);
      }
    };
    if (stored) setSession(stored);
    void tick();
    const id = setInterval(tick, 5_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const signOut = useCallback(() => {
    saveSession(null);
    setSession(null);
    setWallet(null);
  }, []);

  const signIn = useCallback(
    (s: Omit<StoredSession, "server">) => {
      const full = { ...s, server: server || apiBase() };
      saveSession(full);
      setWallet(null);
      setSession(full);
    },
    [server],
  );

  const refresh = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const w = await api("GET /api/market/wallet", { token: s.token });
      if (sessionRef.current?.token === s.token) setWallet(w);
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 401 || err.code === "no_run")) signOut();
    }
  }, [signOut]);

  const landed = wallet?.aid.landed ?? false;
  useEffect(() => {
    if (!session) return;
    void refresh();
    const id = setInterval(refresh, landed ? 1_500 : 500);
    return () => clearInterval(id);
  }, [session, landed, refresh]);

  const timeZone = run?.slug.startsWith("katrina") ? "America/Chicago" : "America/New_York";
  const value = useMemo<AidState>(
    () => ({ server, run, offline, session, wallet, timeZone, signIn, signOut, refresh, setWallet }),
    [server, run, offline, session, wallet, timeZone, signIn, signOut, refresh],
  );
  if (!ready) return <Ctx.Provider value={value}>{null}</Ctx.Provider>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
