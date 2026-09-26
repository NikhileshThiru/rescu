import {
  type Commitment,
  type Connection,
  type Keypair,
  SendTransactionError,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { ChainTxError, decodeChainError, decodeLogs } from "./errors.js";

export interface SendOptions {
  /**
   * Skip simulation so a rejected payment still lands on-chain as a failed transaction
   * (with the rule that blocked it in its logs). Used by the "Try to break it" panel.
   */
  skipPreflight?: boolean;
  commitment?: Commitment;
}

/**
 * Signs with the fee payer (the relayer, so residents never need SOL) plus any extra signers,
 * sends, and confirms. Throws `ChainTxError` with the decoded rule on failure.
 */
export async function sendTx(
  connection: Connection,
  instructions: TransactionInstruction[],
  feePayer: Keypair,
  signers: Keypair[] = [],
  opts: SendOptions = {},
): Promise<string> {
  const commitment = opts.commitment ?? "confirmed";
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight }).add(
    ...instructions,
  );
  const unique = [feePayer, ...signers].filter(
    (s, i, all) => all.findIndex((o) => o.publicKey.equals(s.publicKey)) === i,
  );
  tx.sign(...unique);

  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: opts.skipPreflight ?? false,
      preflightCommitment: commitment,
    });
  } catch (err) {
    const logs = err instanceof SendTransactionError ? (err.logs ?? []) : [];
    throw new ChainTxError(decodeLogs(logs) ?? decodeChainError(err), logs);
  }

  const result = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    commitment,
  );
  if (result.value.err) {
    const info = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = info?.meta?.logMessages ?? [];
    throw new ChainTxError(decodeLogs(logs), logs, signature);
  }
  return signature;
}
