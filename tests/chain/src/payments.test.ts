import { paymentInstruction, reliefAta, TxSender, usd } from "@rescu/chain";
import {
  createTransferCheckedWithTransferHookInstruction,
  getTokenMetadata,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addMerchant,
  addResidents,
  connection,
  createAta,
  createWorld,
  DAY,
  errorCode,
  expectRejected,
  HOUR,
  T0,
  type World,
} from "./fixtures.js";

describe("payments at relief merchants", () => {
  let w: World;
  let alice: Keypair, bob: Keypair, carol: Keypair;
  let grocer: Keypair, stranger: Keypair, ianShop: Keypair;

  beforeAll(async () => {
    w = await createWorld({ name: "Helene 2024" });
    [alice, bob, carol] = (await addResidents(w, 3, 1_000)) as [Keypair, Keypair, Keypair];
    grocer = await addMerchant(w, { category: "grocery" });

    // Has a relief-dollar account but was never registered as a merchant.
    stranger = Keypair.generate();
    await createAta(w, stranger.publicKey);

    // Approved merchant, but for a different disaster (Ian), holding a Helene account.
    const ian = await createWorld({ name: "Ian 2022" });
    ianShop = Keypair.generate();
    await ian.client.registerMerchant(ian.admin, ian.mint, ianShop.publicKey);
    await createAta(w, ianShop.publicKey);
  });

  const pay = (from: Keypair, to: Keypair, dollars: number, extra: { destination?: ReturnType<typeof reliefAta>; skipPreflight?: boolean } = {}) =>
    w.client.pay({ mint: w.mint, resident: from.publicKey, signer: from, merchant: to.publicKey, amount: usd(dollars), ...extra });

  it("mints a named relief dollar that explorers can display", async () => {
    const meta = await getTokenMetadata(connection, w.mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(meta?.name).toBe("Relief Dollar · Helene 2024");
    expect(meta?.symbol).toBe("rUSD");
    expect(meta?.uri).toBe(`https://rescu.tech/api/token/${w.id}.json`);
  });

  it("pays an approved in-zone merchant, and the resident needs no SOL", async () => {
    await pay(alice, grocer, 50);
    expect(await w.client.balance(alice.publicKey, w.mint)).toBe(usd(950));
    expect(await w.client.balance(grocer.publicKey, w.mint)).toBe(usd(50));
    expect(await connection.getBalance(alice.publicKey)).toBe(0);
    const wallet = await w.client.fetchWallet(alice.publicKey, w.mint);
    expect(BigInt(wallet.totalSpent.toString())).toBe(usd(50));
  });

  it("matches the standard spl-token hook resolver, so any wallet can pay", async () => {
    const source = reliefAta(alice.publicKey, w.mint);
    const destination = reliefAta(grocer.publicKey, w.mint);
    const resolved = await createTransferCheckedWithTransferHookInstruction(
      connection, source, w.mint, destination, alice.publicKey, usd(1), 6, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const ours = paymentInstruction({
      mint: w.mint, source, destinationOwner: grocer.publicKey, authority: alice.publicKey, amount: usd(1),
    });
    const shape = (keys: typeof ours.keys) => keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]);
    expect(shape(resolved.keys)).toEqual(shape(ours.keys));
    await w.client.send([resolved], [alice]);
  });

  it("rejects a store that isn't a registered merchant", async () => {
    await expectRejected(pay(alice, stranger, 10), "NotRegisteredMerchant");
  });

  it("rejects an approved merchant from a different disaster zone", async () => {
    await expectRejected(pay(alice, ianShop, 10), "OutOfZone");
  });

  it("blocks sending aid to another resident", async () => {
    await expectRejected(
      pay(alice, bob, 10, { destination: reliefAta(bob.publicKey, w.mint) }),
      "ResaleBlocked",
    );
  });

  it("enforces the $200 per-order cap to the cent", async () => {
    await pay(bob, grocer, 200);
    await expectRejected(pay(bob, grocer, 200.01), "OverOrderCap");
  });

  it("lands rejected payments on-chain with the rule in the logs", async () => {
    const err = await expectRejected(pay(bob, grocer, 250, { skipPreflight: true }), "OverOrderCap");
    expect(err.signature).toBeDefined();
    const tx = await connection.getTransaction(err.signature!, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(tx?.meta?.err).toEqual({ InstructionError: [0, { Custom: errorCode("OverOrderCap") }] });
    expect(tx?.meta?.logMessages?.join("\n")).toContain("OverOrderCap");
  });

  it("reports rejections from the batch sender without fetching logs", async () => {
    const sender = new TxSender(connection, w.relayer);
    const pay = (dollars: number) =>
      sender.submit(
        [paymentInstruction({ mint: w.mint, source: reliefAta(bob.publicKey, w.mint), destinationOwner: grocer.publicKey, authority: bob.publicKey, amount: usd(dollars) })],
        [bob],
      );
    const [ok, rejected] = await Promise.all([pay(12.34), pay(250)]); // $250: over the cap, under his balance
    expect(ok.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    expect(rejected.decoded?.name).toBe("OverOrderCap");
  });

  // Runs last in this file: it moves the declaration's sim clock.
  it("enforces a rolling 24h cap that doesn't reset at a boundary", async () => {
    await pay(carol, grocer, 150); // hour H
    await w.client.setClock(w.admin, w.mint, 1, T0 + 12 * HOUR);
    await pay(carol, grocer, 150); // hour H+12, trailing total $300
    await expectRejected(pay(carol, grocer, 1), "OverDailyCap");

    // 24h after the first spend it rolls out of the window; the H+12 spend is still inside.
    await w.client.setClock(w.admin, w.mint, 1, T0 + DAY + 60);
    await expectRejected(pay(carol, grocer, 151), "OverDailyCap");
    await pay(carol, grocer, 150);
    expect(await w.client.balance(carol.publicKey, w.mint)).toBe(usd(550));
  });
});
