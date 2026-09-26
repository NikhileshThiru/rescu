import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import {
  type Commitment,
  type Connection,
  type Keypair,
  type TransactionError,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { type DecodedChainError, decodeTransactionError } from "./errors.js";

export interface SubmitResult {
  signature: string;
  ok: boolean;
  slot: number;
  err: TransactionError | null;
  /** The rule that rejected it, decoded from the status (no log fetch). */
  decoded: DecodedChainError | null;
  latencyMs: number;
}

export interface SenderOptions {
  commitment?: Commitment;
  /** How often pending signatures are checked (one RPC call per 256). */
  pollMs?: number;
  /** How long a fetched blockhash is reused. */
  blockhashTtlMs?: number;
  /** Re-send unconfirmed transactions this often until their blockhash expires. */
  rebroadcastMs?: number;
}

// Ed25519 PKCS#8 header; the 32-byte seed follows.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const keyObjects = new WeakMap<Keypair, KeyObject>();

/** Node's native ed25519 is an order of magnitude faster than web3.js's pure-JS signer. */
function nativeKey(kp: Keypair): KeyObject {
  let key = keyObjects.get(kp);
  if (!key) {
    key = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519, kp.secretKey.subarray(0, 32)]),
      format: "der",
      type: "pkcs8",
    });
    keyObjects.set(kp, key);
  }
  return key;
}

interface Pending {
  raw: Buffer;
  sentAt: number;
  lastSentAt: number;
  lastValidBlockHeight: number;
  resolve: (r: SubmitResult) => void;
  reject: (e: Error) => void;
}

/**
 * High-throughput sender for the simulation: one cached blockhash, fire-and-forget sends
 * (preflight skipped, so rejected payments land on-chain with their reason), and a single
 * poller that confirms everything in batches. `sendTx` is the simple one-off alternative.
 */
export class TxSender {
  private blockhash?: { blockhash: string; lastValidBlockHeight: number; at: number };
  private refreshing?: Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  private readonly pending = new Map<string, Pending>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly commitment: Commitment;
  private readonly pollMs: number;
  private readonly blockhashTtlMs: number;
  private readonly rebroadcastMs: number;

  constructor(
    readonly connection: Connection,
    readonly feePayer: Keypair,
    opts: SenderOptions = {},
  ) {
    this.commitment = opts.commitment ?? "confirmed";
    this.pollMs = opts.pollMs ?? 250;
    this.blockhashTtlMs = opts.blockhashTtlMs ?? 2_000;
    this.rebroadcastMs = opts.rebroadcastMs ?? 2_000;
  }

  get inFlight() {
    return this.pending.size;
  }

  private async latestBlockhash() {
    const cached = this.blockhash;
    if (cached && Date.now() - cached.at < this.blockhashTtlMs) return cached;
    this.refreshing ??= this.connection
      .getLatestBlockhash(this.commitment)
      .then((b) => {
        this.blockhash = { ...b, at: Date.now() };
        return b;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  async submit(instructions: TransactionInstruction[], signers: Keypair[] = []): Promise<SubmitResult> {
    const { blockhash, lastValidBlockHeight } = await this.latestBlockhash();
    const message = new TransactionMessage({
      payerKey: this.feePayer.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToLegacyMessage();
    const tx = new VersionedTransaction(message);
    const bytes = message.serialize();
    const unique = [this.feePayer, ...signers].filter(
      (s, i, all) => all.findIndex((o) => o.publicKey.equals(s.publicKey)) === i,
    );
    for (const s of unique) tx.addSignature(s.publicKey, sign(null, bytes, nativeKey(s)));
    const raw = Buffer.from(tx.serialize());
    const sentAt = Date.now();
    const signature = await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    return new Promise<SubmitResult>((resolve, reject) => {
      this.pending.set(signature, { raw, sentAt, lastSentAt: sentAt, lastValidBlockHeight, resolve, reject });
      this.schedule();
    });
  }

  private schedule() {
    if (this.timer || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.poll()
        .catch(() => {})
        .finally(() => this.schedule());
    }, this.pollMs);
  }

  private async poll() {
    const signatures = [...this.pending.keys()];
    for (let i = 0; i < signatures.length; i += 256) {
      const chunk = signatures.slice(i, i + 256);
      const { value } = await this.connection.getSignatureStatuses(chunk);
      value.forEach((status, j) => {
        const signature = chunk[j]!;
        const entry = this.pending.get(signature);
        if (!entry || !status) return;
        const done = status.err || status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
        if (!done) return;
        this.pending.delete(signature);
        entry.resolve({
          signature,
          ok: !status.err,
          slot: status.slot,
          err: status.err,
          decoded: decodeTransactionError(status.err),
          latencyMs: Date.now() - entry.sentAt,
        });
      });
    }
    if (this.pending.size === 0) return;

    const now = Date.now();
    const height = await this.connection.getBlockHeight(this.commitment);
    for (const [signature, entry] of this.pending) {
      if (height > entry.lastValidBlockHeight) {
        this.pending.delete(signature);
        entry.reject(new Error(`Transaction ${signature} expired before confirmation`));
      } else if (now - entry.lastSentAt > this.rebroadcastMs) {
        entry.lastSentAt = now;
        this.connection.sendRawTransaction(entry.raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      }
    }
  }
}
