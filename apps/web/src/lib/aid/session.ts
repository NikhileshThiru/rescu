"use client";

import type { ChatMessage, Order, Session } from "@rescu/live";

/** Local persistence for the resident app: the session, a device id for the mock ID check, the chat. */

const SESSION = "rescu.aid.session";
const DEVICE = "rescu.aid.device";
const chatKey = (token: string) => `rescu.aid.chat.${token.slice(0, 16)}`;

export interface StoredSession extends Session {
  /** Which sim server issued it (dev override or prod). */
  server: string;
}

export function loadSession(server: string): StoredSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION) ?? "null") as StoredSession | null;
    return s && s.server === server ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession | null) {
  try {
    if (s) localStorage.setItem(SESSION, JSON.stringify(s));
    else localStorage.removeItem(SESSION);
  } catch {
    // Private mode: the session lives for this page only.
  }
}

export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE);
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      id = `dev_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      localStorage.setItem(DEVICE, id);
    }
    return id;
  } catch {
    return `dev_${Math.random().toString(16).slice(2, 14)}`;
  }
}

/** A chat turn as the Ask tab shows it (the orders ride along so the cards survive a reload). */
export interface ChatEntry extends ChatMessage {
  id: string;
  tools?: { name: string; summary: string }[];
  fallback?: boolean;
  /** Orders proposed in this message, as last seen. */
  cards?: Order[];
  error?: boolean;
}

export function loadChat(token: string): ChatEntry[] {
  try {
    return JSON.parse(localStorage.getItem(chatKey(token)) ?? "[]") as ChatEntry[];
  } catch {
    return [];
  }
}

export function saveChat(token: string, chat: ChatEntry[]) {
  try {
    localStorage.setItem(chatKey(token), JSON.stringify(chat.slice(-30)));
  } catch {
    // Quota or private mode: fine.
  }
}
