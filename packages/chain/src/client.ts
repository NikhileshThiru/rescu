import { AnchorProvider, Program } from "@anchor-lang/core";
import BN from "bn.js";
import {
  createApproveCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  type Connection,
  type Keypair,
  PublicKey,
  type Transaction,
  TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { DECIMALS, DEFAULT_RULES, MERCHANT_CATEGORY, type MerchantCategory, usd } from "./constants.js";
import { paymentInstruction } from "./hook.js";
import type { Rescu } from "./idl/rescu.js";
import idl from "./idl/rescu.json" with { type: "json" };
import {
  authorityPda,
  declarationAddresses,
  declarationPda,
  merchantPda,
  mintPda,
  reliefAta,
  walletPda,
} from "./pda.js";
import { type SendOptions, sendTx } from "./tx.js";

export type MerchantStatusName = "pending" | "approved" | "suspended";

export interface DeclarationInput {
  id: bigint;
  name: string;
  oracle: PublicKey;
  budget: bigint;
  /** Sim seconds per real second (1440 = one sim day per real minute). */
  timeScale: number;
  /** Sim unix timestamp at declaration time. */
  simStart: number;
  perOrderCap?: bigint;
  dailyCap?: bigint;
  aidDurationSecs?: number;
}

export interface RulesInput {
  perOrderCap?: bigint;
  dailyCap?: bigint;
  expiresAt?: number;
  active?: boolean;
  oracle?: PublicKey;
  budget?: bigint;
}

const bn = (v: bigint | number) => new BN(v.toString());
const opt = <T, R>(v: T | undefined, f: (v: T) => R) => (v === undefined ? null : f(v));

/** Signs nothing: instructions are built here and signed in `sendTx`. */
const readOnlyWallet = (publicKey: PublicKey) => ({
  publicKey,
  signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
});

/**
 * Everything the app does on-chain. `relayer` pays every fee and rent, so residents and
 * merchants never need SOL.
 */
export class RescuClient {
  readonly program: Program<Rescu>;
  private readonly enrollTemplates = new Map<string, { ix: TransactionInstruction; owner: PublicKey; tokenAccount: PublicKey; wallet: PublicKey }>();

  constructor(
    readonly connection: Connection,
    readonly relayer: Keypair,
  ) {
    const provider = new AnchorProvider(connection, readOnlyWallet(relayer.publicKey), {
      commitment: "confirmed",
    });
    this.program = new Program<Rescu>(idl as Rescu, provider);
  }

  send(ixs: TransactionInstruction[], signers: Keypair[] = [], opts?: SendOptions) {
    return sendTx(this.connection, ixs, this.relayer, signers, opts);
  }

  // ---------- declaration ----------

  async createDeclaration(admin: Keypair, input: DeclarationInput, opts?: SendOptions) {
    const addrs = declarationAddresses(input.id);
    const ix = await this.program.methods
      .initDeclaration({
        id: bn(input.id),
        name: input.name,
        oracle: input.oracle,
        perOrderCap: bn(input.perOrderCap ?? usd(DEFAULT_RULES.perOrderCapUsd)),
        dailyCap: bn(input.dailyCap ?? usd(DEFAULT_RULES.dailyCapUsd)),
        budget: bn(input.budget),
        timeScale: input.timeScale,
        simStart: bn(input.simStart),
        aidDuration: bn(input.aidDurationSecs ?? DEFAULT_RULES.aidDurationSecs),
      })
      .accountsPartial({
        admin: admin.publicKey,
        authority: addrs.authority,
        mint: addrs.mint,
        declaration: addrs.declaration,
        extraAccountMetaList: addrs.extraAccountMetas,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
    const signature = await this.send([ix], [admin], opts);
    return { signature, ...addrs };
  }

  setClockInstruction(admin: PublicKey, mint: PublicKey, timeScale: number, simNow: number) {
    return this.program.methods
      .setClock(timeScale, bn(simNow))
      .accountsPartial({ admin, declaration: declarationPda(mint) })
      .instruction();
  }

  async setClock(admin: Keypair, mint: PublicKey, timeScale: number, simNow: number, opts?: SendOptions) {
    return this.send([await this.setClockInstruction(admin.publicKey, mint, timeScale, simNow)], [admin], opts);
  }

  updateRulesInstruction(admin: PublicKey, mint: PublicKey, rules: RulesInput) {
    return this.program.methods
      .updateRules({
        perOrderCap: opt(rules.perOrderCap, bn),
        dailyCap: opt(rules.dailyCap, bn),
        expiresAt: opt(rules.expiresAt, bn),
        active: rules.active ?? null,
        oracle: rules.oracle ?? null,
        budget: opt(rules.budget, bn),
      })
      .accountsPartial({ admin, declaration: declarationPda(mint) })
      .instruction();
  }

  async updateRules(admin: Keypair, mint: PublicKey, rules: RulesInput) {
    return this.send([await this.updateRulesInstruction(admin.publicKey, mint, rules)], [admin]);
  }

  // ---------- merchants ----------

  /** Create-ATA + register for one merchant; several fit in one transaction. */
  async registerMerchantInstructions(
    admin: PublicKey,
    mint: PublicKey,
    owner: PublicKey,
    opts: { category?: MerchantCategory; h3Cell?: bigint; approved?: boolean } = {},
  ) {
    const createAta = createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey,
      reliefAta(owner, mint),
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    );
    const register = await this.program.methods
      .registerMerchant(MERCHANT_CATEGORY[opts.category ?? "general"], bn(opts.h3Cell ?? 0n), opts.approved ?? true)
      .accountsPartial({
        payer: this.relayer.publicKey,
        admin,
        declaration: declarationPda(mint),
        owner,
        merchant: merchantPda(owner),
      })
      .instruction();
    return [createAta, register];
  }

  async registerMerchant(
    admin: Keypair,
    mint: PublicKey,
    owner: PublicKey,
    opts: { category?: MerchantCategory; h3Cell?: bigint; approved?: boolean } = {},
  ) {
    return this.send(await this.registerMerchantInstructions(admin.publicKey, mint, owner, opts), [admin]);
  }

  async setMerchantStatus(signer: Keypair, mint: PublicKey, owner: PublicKey, status: MerchantStatusName) {
    const ix = await this.program.methods
      .setMerchantStatus({ [status]: {} } as never)
      .accountsPartial({
        authority: signer.publicKey,
        declaration: declarationPda(mint),
        merchant: merchantPda(owner),
      })
      .instruction();
    return this.send([ix], [signer]);
  }

  /** A relief-dollar account for any owner (e.g. a store that never registered). */
  createAtaInstruction(owner: PublicKey, mint: PublicKey) {
    return createAssociatedTokenAccountIdempotentInstruction(
      this.relayer.publicKey,
      reliefAta(owner, mint),
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    );
  }

  // ---------- residents ----------

  /**
   * Create-ATA + enroll for one resident; several fit in one transaction. `payer` covers the rent
   * (default: the relayer); spreading it over several payers lets the validator run enrollments in parallel.
   */
  async enrollInstructions(admin: PublicKey, mint: PublicKey, owner: PublicKey, householdId: bigint, payer: PublicKey = this.relayer.publicKey) {
    const tokenAccount = reliefAta(owner, mint);
    const wallet = walletPda(tokenAccount);
    const createAta = createAssociatedTokenAccountIdempotentInstruction(
      payer,
      tokenAccount,
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    );
    // Anchor's builder costs ~2.5 ms per call, so build it once per (admin, mint, payer) and
    // swap in each resident's accounts and id (20k registrations would otherwise be CPU-bound).
    const key = `${admin.toBase58()}:${mint.toBase58()}:${payer.toBase58()}`;
    let tpl = this.enrollTemplates.get(key);
    if (!tpl) {
      const ix = await this.program.methods
        .enrollResident(bn(householdId))
        .accountsPartial({
          payer,
          admin,
          declaration: declarationPda(mint),
          mint,
          owner,
          tokenAccount,
          wallet,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .instruction();
      tpl = { ix, owner, tokenAccount, wallet };
      this.enrollTemplates.set(key, tpl);
    }
    const swap = new Map([
      [tpl.owner.toBase58(), owner],
      [tpl.tokenAccount.toBase58(), tokenAccount],
      [tpl.wallet.toBase58(), wallet],
    ]);
    const data = Buffer.from(tpl.ix.data);
    data.writeBigUInt64LE(householdId, 8);
    const enroll = new TransactionInstruction({
      programId: tpl.ix.programId,
      keys: tpl.ix.keys.map((k) => ({ ...k, pubkey: swap.get(k.pubkey.toBase58()) ?? k.pubkey })),
      data,
    });
    return [createAta, enroll];
  }

  async enrollResidents(admin: Keypair, mint: PublicKey, residents: { owner: PublicKey; householdId: bigint }[]) {
    const ixs = (
      await Promise.all(residents.map((r) => this.enrollInstructions(admin.publicKey, mint, r.owner, r.householdId)))
    ).flat();
    return this.send(ixs, [admin]);
  }

  async disburseInstruction(admin: PublicKey, mint: PublicKey, grants: { owner: PublicKey; amount: bigint }[]) {
    return this.program.methods
      .disburse(grants.map((g) => bn(g.amount)))
      .accountsPartial({
        admin,
        declaration: declarationPda(mint),
        mint,
        authority: authorityPda(),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(
        grants.flatMap((g) => {
          const tokenAccount = reliefAta(g.owner, mint);
          return [
            { pubkey: walletPda(tokenAccount), isSigner: false, isWritable: false },
            { pubkey: tokenAccount, isSigner: false, isWritable: true },
          ];
        }),
      )
      .instruction();
  }

  async disburse(admin: Keypair, mint: PublicKey, grants: { owner: PublicKey; amount: bigint }[]) {
    return this.send([await this.disburseInstruction(admin.publicKey, mint, grants)], [admin]);
  }

  // ---------- payments ----------

  /**
   * Pays a merchant. `signer` is the resident, or the agent when it spends its delegated
   * allowance. `destination` overrides the merchant ATA (used to attempt resale in tests).
   */
  async pay(p: {
    mint: PublicKey;
    resident: PublicKey;
    signer: Keypair;
    merchant: PublicKey;
    amount: bigint;
    destination?: PublicKey;
    skipPreflight?: boolean;
  }) {
    const ix = paymentInstruction({
      mint: p.mint,
      source: reliefAta(p.resident, p.mint),
      destinationOwner: p.merchant,
      destination: p.destination,
      authority: p.signer.publicKey,
      amount: p.amount,
    });
    return this.send([ix], [p.signer], { skipPreflight: p.skipPreflight });
  }

  /** Resident grants the agent key an on-chain spending allowance (SPL delegate). */
  async approveAgent(resident: Keypair, mint: PublicKey, agent: PublicKey, allowance: bigint) {
    const ix = createApproveCheckedInstruction(
      reliefAta(resident.publicKey, mint),
      mint,
      agent,
      resident.publicKey,
      allowance,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    return this.send([ix], [resident]);
  }

  // ---------- oracle + close-out ----------

  async setWalletFrozen(signer: Keypair, mint: PublicKey, owner: PublicKey, frozen: boolean) {
    const ix = await this.program.methods
      .setWalletFrozen(frozen)
      .accountsPartial({
        signer: signer.publicKey,
        declaration: declarationPda(mint),
        mint,
        authority: authorityPda(),
        tokenAccount: reliefAta(owner, mint),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
    return this.send([ix], [signer]);
  }

  async clawbackInstruction(mint: PublicKey, owner: PublicKey) {
    const tokenAccount = reliefAta(owner, mint);
    return this.program.methods
      .clawback()
      .accountsPartial({
        caller: this.relayer.publicKey,
        declaration: declarationPda(mint),
        mint,
        authority: authorityPda(),
        tokenAccount,
        wallet: walletPda(tokenAccount),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  async clawback(mint: PublicKey, owners: PublicKey[]) {
    const ixs = await Promise.all(owners.map((o) => this.clawbackInstruction(mint, o)));
    return this.send(ixs);
  }

  // ---------- reads ----------

  fetchDeclaration(mint: PublicKey) {
    return this.program.account.declaration.fetch(declarationPda(mint));
  }

  fetchWallet(owner: PublicKey, mint: PublicKey) {
    return this.program.account.walletState.fetch(walletPda(reliefAta(owner, mint)));
  }

  fetchMerchant(owner: PublicKey) {
    return this.program.account.merchant.fetch(merchantPda(owner));
  }

  async balance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    const account = await getAccount(this.connection, reliefAta(owner, mint), "confirmed", TOKEN_2022_PROGRAM_ID);
    return account.amount;
  }

  static mintFor(id: bigint) {
    return mintPda(id);
  }
}
