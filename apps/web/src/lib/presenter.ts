"use client";

const KEY = "rescu.presenter";

/**
 * The presenter key, from a one-time `?key=` link (then remembered on this device and removed from
 * the address bar so it doesn't end up on screen or in a screenshot). Null = view only.
 */
export function presenterKey(): string | null {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("key");
    if (q) {
      localStorage.setItem(KEY, q);
      url.searchParams.delete("key");
      window.history.replaceState(null, "", url);
    }
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
