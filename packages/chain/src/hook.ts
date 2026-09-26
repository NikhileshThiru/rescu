import { createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DECIMALS, PROGRAM_ID } from "./constants.js";
import { declarationPda, extraAccountMetasPda, merchantPda, reliefAta, walletPda } from "./pda.js";

export interface PaymentAccounts {
  mint: PublicKey;
  /** Resident token account paying. */
  source: PublicKey;
  /** Merchant wallet (owner of the destination token account). */
  destinationOwner: PublicKey;
  /** Defaults to the merchant's relief ATA. */
  destination?: PublicKey;
}

/**
 * The accounts Token-2022 needs to run our hook, in the order spl-token's resolver produces
 * (extras from the on-chain list, then hook program, then the list itself). Computing them
 * locally avoids two RPC reads per payment.
 */
export function hookRemainingAccounts(p: PaymentAccounts): AccountMeta[] {
  const destination = p.destination ?? reliefAta(p.destinationOwner, p.mint);
  return [
    { pubkey: declarationPda(p.mint), isSigner: false, isWritable: false },
    { pubkey: walletPda(p.source), isSigner: false, isWritable: true },
    { pubkey: merchantPda(p.destinationOwner), isSigner: false, isWritable: false },
    { pubkey: walletPda(destination), isSigner: false, isWritable: false },
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetasPda(p.mint), isSigner: false, isWritable: false },
  ];
}

/**
 * A relief-dollar payment: Token-2022 transfer_checked plus hook accounts.
 * `authority` is the resident, or the agent key when it pays as SPL delegate.
 */
export function paymentInstruction(
  p: PaymentAccounts & { authority: PublicKey; amount: bigint },
): TransactionInstruction {
  const destination = p.destination ?? reliefAta(p.destinationOwner, p.mint);
  const ix = createTransferCheckedInstruction(
    p.source,
    p.mint,
    destination,
    p.authority,
    p.amount,
    DECIMALS,
    [],
    TOKEN_2022_PROGRAM_ID,
  );
  ix.keys.push(...hookRemainingAccounts({ ...p, destination }));
  return ix;
}
