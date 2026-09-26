import {
  BN,
  ChainTxError,
  declarationPda,
  extraAccountMetasPda,
  merchantPda,
  PROGRAM_ID,
  reliefAta,
  usd,
  walletPda,
} from "@rescu/chain";
import {
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedWithTransferHookInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMerchant, addResidents, connection, createAta, createWorld, expectRejected, funded, type World } from "./fixtures.js";

describe("security", () => {
  let w: World;
  let jo: Keypair, kim: Keypair, shop: Keypair, intruder: Keypair;

  beforeAll(async () => {
    w = await createWorld();
    [jo, kim] = (await addResidents(w, 2, 1_000)) as [Keypair, Keypair];
    shop = await addMerchant(w);
    intruder = await funded(2);
    await w.client.pay({ mint: w.mint, resident: jo.publicKey, signer: jo, merchant: shop.publicKey, amount: usd(40) });
  });

  it("refuses direct hook calls, so nobody can burn a resident's cap from outside a transfer", async () => {
    const source = reliefAta(jo.publicKey, w.mint);
    const destination = reliefAta(shop.publicKey, w.mint);
    const ix = await w.client.program.methods
      .transferHook(new BN(usd(100).toString()))
      .accountsStrict({
        source,
        mint: w.mint,
        destination,
        authority: jo.publicKey,
        extraAccountMetaList: extraAccountMetasPda(w.mint),
        declaration: declarationPda(w.mint),
        senderWallet: walletPda(source),
        merchant: merchantPda(shop.publicKey),
        receiverWallet: walletPda(destination),
      })
      .instruction();
    await expectRejected(w.client.send([ix]), "NotTransferring");
  });

  it("only lets the oracle or admin suspend merchants and freeze wallets", async () => {
    await expectRejected(w.client.setMerchantStatus(intruder, w.mint, shop.publicKey, "suspended"), "Unauthorized");
    await expectRejected(w.client.setWalletFrozen(intruder, w.mint, jo.publicKey, true), "Unauthorized");
  });

  it("only lets the admin disburse, move the clock, or change rules", async () => {
    await expectRejected(w.client.disburse(intruder, w.mint, [{ owner: jo.publicKey, amount: usd(1) }]), "Unauthorized");
    await expectRejected(w.client.setClock(intruder, w.mint, 1, 0), "Unauthorized");
    await expectRejected(w.client.updateRules(intruder, w.mint, { dailyCap: usd(1_000_000) }), "Unauthorized");
  });

  it("never disburses past the declared budget", async () => {
    const small = await createWorld({ budget: usd(1_000) });
    const [a, b] = (await addResidents(small, 2, 0)) as [Keypair, Keypair];
    await small.client.disburse(small.admin, small.mint, [{ owner: a.publicKey, amount: usd(600) }]);
    await expectRejected(
      small.client.disburse(small.admin, small.mint, [{ owner: b.publicKey, amount: usd(600) }]),
      "BudgetExceeded",
    );
  });

  it("can't mint aid to someone who isn't enrolled", async () => {
    await createAta(w, intruder.publicKey);
    await expectRejected(
      w.client.disburse(w.admin, w.mint, [{ owner: intruder.publicKey, amount: usd(500) }]),
      "NotAResident",
    );
  });

  it("stops merchants paying aid back out to residents (cash-back collusion)", async () => {
    await expectRejected(
      w.client.pay({
        mint: w.mint,
        resident: shop.publicKey,
        signer: shop,
        merchant: kim.publicKey,
        destination: reliefAta(kim.publicKey, w.mint),
        amount: usd(10),
      }),
      "NotAResident",
    );
  });

  it("won't let a resident sell their whole wallet by reassigning its owner", async () => {
    const ix = createSetAuthorityInstruction(
      reliefAta(kim.publicKey, w.mint),
      kim.publicKey,
      AuthorityType.AccountOwner,
      intruder.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    await expectRejected(w.client.send([ix], [kim]), "ImmutableOwner");
  });

  it("gives copycat mints that point at our hook nothing to work with", async () => {
    const fake = Keypair.generate();
    const space = getMintLen([ExtensionType.TransferHook]);
    const lamports = await connection.getMinimumBalanceForRentExemption(space);
    await w.client.send(
      [
        SystemProgram.createAccount({
          fromPubkey: w.relayer.publicKey,
          newAccountPubkey: fake.publicKey,
          space,
          lamports,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(fake.publicKey, intruder.publicKey, PROGRAM_ID, TOKEN_2022_PROGRAM_ID),
        createInitializeMintInstruction(fake.publicKey, 6, intruder.publicKey, null, TOKEN_2022_PROGRAM_ID),
      ],
      [fake],
    );
    const from = getAssociatedTokenAddressSync(fake.publicKey, intruder.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const to = getAssociatedTokenAddressSync(fake.publicKey, shop.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await w.client.send(
      [
        createAssociatedTokenAccountIdempotentInstruction(w.relayer.publicKey, from, intruder.publicKey, fake.publicKey, TOKEN_2022_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(w.relayer.publicKey, to, shop.publicKey, fake.publicKey, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(fake.publicKey, from, intruder.publicKey, 1_000_000n, [], TOKEN_2022_PROGRAM_ID),
      ],
      [intruder],
    );
    const transfer = await createTransferCheckedWithTransferHookInstruction(
      connection, from, fake.publicKey, to, intruder.publicKey, 1n, 6, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    await expect(w.client.send([transfer], [intruder])).rejects.toBeInstanceOf(ChainTxError);
  });
});
