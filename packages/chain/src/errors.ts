import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PROGRAM_ID } from "./constants.js";
import idl from "./idl/rescu.json" with { type: "json" };

export type ChainErrorSource = "rescu" | "token-2022" | "anchor" | "runtime";

export interface DecodedChainError {
  /** Stable machine name, e.g. "OverDailyCap" or "AccountFrozen". */
  name: string;
  code?: number;
  message: string;
  source: ChainErrorSource;
}

const RESCU_ERRORS = new Map(idl.errors.map((e) => [e.code, e]));

// Token-2022 TokenError, in declaration order (the index is the custom error code).
const TOKEN_2022_ERRORS = (
  "NotRentExempt InsufficientFunds InvalidMint MintMismatch OwnerMismatch FixedSupply AlreadyInUse " +
  "InvalidNumberOfProvidedSigners InvalidNumberOfRequiredSigners UninitializedState NativeNotSupported " +
  "NonNativeHasBalance InvalidInstruction InvalidState Overflow AuthorityTypeNotSupported MintCannotFreeze " +
  "AccountFrozen MintDecimalsMismatch NonNativeNotSupported ExtensionTypeMismatch ExtensionBaseMismatch " +
  "ExtensionAlreadyInitialized ConfidentialTransferAccountHasBalance ConfidentialTransferAccountNotApproved " +
  "ConfidentialTransferDepositsAndTransfersDisabled ConfidentialTransferElGamalPubkeyMismatch " +
  "ConfidentialTransferBalanceMismatch MintHasSupply NoAuthorityExists TransferFeeExceedsMaximum " +
  "MintRequiredForTransfer FeeMismatch FeeParametersMismatch ImmutableOwner"
).split(" ");

const TOKEN_2022_MESSAGES: Record<string, string> = {
  InsufficientFunds: "Insufficient funds (or over the agent's allowance)",
  AccountFrozen: "This wallet is frozen",
  OwnerMismatch: "Signer doesn't own this account",
  ImmutableOwner: "This account's owner can't be changed",
};

/** Copy for the "Try to break it" panel and receipts. */
export const REJECTION_COPY: Record<string, string> = {
  NotRegisteredMerchant: "Blocked: that store isn't a registered relief merchant.",
  MerchantSuspended: "Blocked: the oracle suspended this merchant.",
  MerchantNotApproved: "Blocked: this merchant hasn't been approved yet.",
  OutOfZone: "Blocked: that store is outside this disaster zone.",
  ResaleBlocked: "Blocked: aid can't be sent to another resident.",
  NotAResident: "Blocked: only enrolled residents can spend relief dollars.",
  OverOrderCap: "Blocked: over the $200 per-order limit.",
  OverDailyCap: "Blocked: over the $300 per-24-hours limit.",
  AidExpired: "Blocked: this aid has expired.",
  AccountFrozen: "Blocked: the oracle froze this wallet.",
  InsufficientFunds: "Blocked: not enough balance or agent allowance.",
  ImmutableOwner: "Blocked: a relief wallet can't be handed to someone else.",
  NotTransferring: "Blocked: the hook only runs inside a real transfer.",
  UnknownDeclaration: "Blocked: not a Rescu relief dollar.",
  Unauthorized: "Blocked: that key isn't allowed to do this.",
};

const ANCHOR_LOG = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/;
const FAILED_LOG = /^Program (\w+) failed: custom program error: 0x([0-9a-f]+)$/i;

function fromCode(programId: string, code: number): DecodedChainError | null {
  if (programId === PROGRAM_ID.toBase58()) {
    const e = RESCU_ERRORS.get(code);
    if (e) return { name: e.name, code, message: e.msg, source: "rescu" };
  }
  if (programId === TOKEN_2022_PROGRAM_ID.toBase58()) {
    const name = TOKEN_2022_ERRORS[code];
    if (name) return { name, code, message: TOKEN_2022_MESSAGES[name] ?? name, source: "token-2022" };
  }
  return null;
}

/** Decodes the innermost failure from transaction logs. */
export function decodeLogs(logs: readonly string[]): DecodedChainError | null {
  for (const line of logs) {
    const anchor = ANCHOR_LOG.exec(line);
    if (anchor) {
      const code = Number(anchor[2]);
      const name = anchor[1]!;
      const source: ChainErrorSource = RESCU_ERRORS.has(code) ? "rescu" : "anchor";
      return { name, code, message: anchor[3]!, source };
    }
  }
  // The innermost failing program logs its failure first.
  for (const line of logs) {
    const failed = FAILED_LOG.exec(line);
    if (failed) {
      const decoded = fromCode(failed[1]!, parseInt(failed[2]!, 16));
      if (decoded) return decoded;
    }
  }
  return null;
}

/**
 * Decodes a `TransactionError` from a signature status without fetching logs. Our transactions
 * only touch this program and Token-2022, so custom codes >= 6000 are ours (including hook
 * rejections bubbling up through Token-2022) and small codes are Token-2022's.
 */
export function decodeTransactionError(err: unknown): DecodedChainError | null {
  const ix = (err as { InstructionError?: [number, unknown] })?.InstructionError;
  const custom = (ix?.[1] as { Custom?: number } | undefined)?.Custom;
  if (typeof custom === "number") {
    return fromCode(custom >= 6000 ? PROGRAM_ID.toBase58() : TOKEN_2022_PROGRAM_ID.toBase58(), custom)
      ?? { name: `Custom${custom}`, code: custom, message: `Custom program error ${custom}`, source: custom >= 100 ? "anchor" : "runtime" };
  }
  if (err == null) return null;
  const name = typeof err === "string" ? err : typeof ix?.[1] === "string" ? (ix[1] as string) : JSON.stringify(err);
  return { name, message: name, source: "runtime" };
}

/** Best-effort decode of anything thrown while sending a transaction. */
export function decodeChainError(err: unknown): DecodedChainError | null {
  if (err instanceof ChainTxError) return err.decoded;
  const logs = (err as { logs?: string[]; transactionLogs?: string[] })?.logs
    ?? (err as { transactionLogs?: string[] })?.transactionLogs;
  if (Array.isArray(logs)) {
    const decoded = decodeLogs(logs);
    if (decoded) return decoded;
  }
  const text = String((err as Error)?.message ?? err);
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (hex) {
    const code = parseInt(hex[1]!, 16);
    return fromCode(code >= 6000 ? PROGRAM_ID.toBase58() : TOKEN_2022_PROGRAM_ID.toBase58(), code);
  }
  return null;
}

/** Thrown by `sendTx` when a transaction fails; carries the signature when it landed on-chain. */
export class ChainTxError extends Error {
  constructor(
    readonly decoded: DecodedChainError | null,
    readonly logs: string[],
    readonly signature?: string,
  ) {
    super(decoded ? `${decoded.name}: ${decoded.message}` : "Transaction failed");
    this.name = "ChainTxError";
  }
}
