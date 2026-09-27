/** Live product origin. QRs must encode this, never localhost — a phone can't open the laptop. */
export const PUBLIC_SITE = "https://rescu.tech";

function loopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local");
}

/** Origin a phone can actually open. Localhost and empty NEXT_PUBLIC_SITE_URL fall back to rescu.tech. */
export function siteOrigin(): string {
  const env = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/$/, "");
  if (env) {
    try {
      if (!loopbackHost(new URL(env).hostname)) return env;
    } catch {
      /* ignore a bad env value */
    }
  }
  if (typeof window !== "undefined" && !loopbackHost(window.location.hostname)) {
    return window.location.origin;
  }
  return PUBLIC_SITE;
}

export function aidUrl(query?: Record<string, string>): string {
  const url = new URL("/aid", `${siteOrigin()}/`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.toString();
}
