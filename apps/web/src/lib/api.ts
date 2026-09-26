"use client";

import type { ApiError, ApiRoutes } from "@rescu/live";

/**
 * Dev override: `?server=4200` (a port on this host) or `?server=http://host:4200` points every
 * page at another sim server; remembered for the tab (sessionStorage).
 */
export function serverOverride(): string | null {
  try {
    const q = new URLSearchParams(window.location.search).get("server");
    if (q) sessionStorage.setItem("rescu.server", q);
    const v = q ?? sessionStorage.getItem("rescu.server");
    if (!v) return null;
    return /^\d+$/.test(v) ? `${window.location.protocol}//${window.location.hostname}:${v}` : v.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** The sim server's HTTP base: the dev override, NEXT_PUBLIC_API_URL, else port 4000 on the page's host (works from a phone on the LAN). */
export function apiBase(): string {
  const override = serverOverride();
  if (override) return override;
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env) return env.replace(/\/$/, "");
  return `${window.location.protocol}//${window.location.hostname}:4000`;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type Opts<R extends keyof ApiRoutes> = {
  /** Values for `:name` segments in the route. */
  params?: Record<string, string | number>;
  query?: [ApiRoutes[R]["query"]] extends [never] ? never : ApiRoutes[R]["query"];
  body?: [ApiRoutes[R]["body"]] extends [never] ? never : ApiRoutes[R]["body"];
  /** Session token for resident routes. */
  token?: string | null;
  signal?: AbortSignal;
};

/**
 * Typed call to any route in @rescu/live's `ApiRoutes`:
 *   const wallet = await api("GET /api/market/wallet", { token })
 *   const order = await api("POST /api/market/orders/:id/confirm", { params: { id }, body: { payer: "agent" }, token })
 * Throws ApiRequestError with the server's message and code on a non-2xx response.
 */
export async function api<R extends keyof ApiRoutes>(route: R, opts: Opts<R> = {}): Promise<ApiRoutes[R]["res"]> {
  const space = route.indexOf(" ");
  const method = route.slice(0, space);
  let path = route.slice(space + 1).replace(/:([a-zA-Z]+)/g, (_, name: string) => {
    const v = opts.params?.[name];
    if (v === undefined) throw new Error(`api: missing :${name} for ${route}`);
    return encodeURIComponent(String(v));
  });
  if (opts.query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query as Record<string, unknown>)) if (v !== undefined && v !== null) q.set(k, String(v));
    const s = q.toString();
    if (s) path += `?${s}`;
  }
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiRequestError(0, "offline", "Can't reach the Rescu server");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(res.status, e.code ?? null, e.error ?? `Request failed (${res.status})`);
  }
  return data as ApiRoutes[R]["res"];
}
