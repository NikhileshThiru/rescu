import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { type Commitment, Connection } from "@solana/web3.js";

/**
 * web3.js caps its keep-alive pool at 25 sockets, which throttles the simulation long before
 * the validator does. Server-only (like the rest of this package).
 */
export function createConnection(
  url: string,
  opts: { commitment?: Commitment; maxSockets?: number; wsEndpoint?: string } = {},
): Connection {
  const maxSockets = opts.maxSockets ?? 256;
  const httpAgent = url.startsWith("https:")
    ? new HttpsAgent({ keepAlive: true, maxSockets })
    : new HttpAgent({ keepAlive: true, maxSockets });
  return new Connection(url, {
    commitment: opts.commitment ?? "confirmed",
    httpAgent,
    wsEndpoint: opts.wsEndpoint,
    disableRetryOnRateLimit: true,
  });
}
