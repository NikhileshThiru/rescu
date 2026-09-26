"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Minimal typing for the Web Speech API (not in lib.dom for every browser). */
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

function ctor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Speech to text with the browser's own recognizer. `onFinal` gets the whole utterance when the
 * person stops talking; `interim` is what's been heard so far.
 */
export function useSpeech(onFinal: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const text = useRef("");
  const final = useRef(onFinal);
  final.current = onFinal;

  useEffect(() => setSupported(!!ctor()), []);

  const stop = useCallback(() => rec.current?.stop(), []);

  const start = useCallback(() => {
    const C = ctor();
    if (!C) return;
    rec.current?.abort();
    const r = new C();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    text.current = "";
    setInterim("");
    setError(null);
    r.onresult = (e) => {
      let s = "";
      for (let i = 0; i < e.results.length; i++) s += e.results[i]![0].transcript;
      text.current = s;
      setInterim(s);
    };
    r.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") setError(e.error === "not-allowed" ? "Microphone access was blocked" : "Couldn't hear that");
    };
    r.onend = () => {
      setListening(false);
      const said = text.current.trim();
      setInterim("");
      if (said) final.current(said);
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, []);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported, listening, interim, error, start, stop };
}
