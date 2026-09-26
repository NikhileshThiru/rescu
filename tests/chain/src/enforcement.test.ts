import { ChainTxError, usd } from "@rescu/chain";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import { addMerchant, addResidents, createWorld, DAY, expectRejected, T0, type World } from "./fixtures.js";

const payer = (w: World) => (from: Keypair, to: Keypair, dollars: number, signer: Keypair = from) =>
  w.client.pay({ mint: w.mint, resident: from.publicKey, signer, merchant: to.publicKey, amount: usd(dollars) });

describe("oracle enforcement", () => {
  let w: World;
  let dan: Keypair, erin: Keypair;
  let pharmacy: Keypair, hardware: Keypair;
  let pay: ReturnType<typeof payer>;

  beforeAll(async () => {
    w = await createWorld();
    pay = payer(w);
    [dan, erin] = (await addResidents(w, 2, 1_000)) as [Keypair, Keypair];
    pharmacy = await addMerchant(w, { category: "pharmacy" });
    hardware = await addMerchant(w, { category: "hardware", approved: false });
  });

  it("rejects a suspended merchant until the oracle reinstates it", async () => {
    await pay(dan, pharmacy, 20);
    await w.client.setMerchantStatus(w.oracle, w.mint, pharmacy.publicKey, "suspended");
    await expectRejected(pay(dan, pharmacy, 20), "MerchantSuspended");
    await w.client.setMerchantStatus(w.oracle, w.mint, pharmacy.publicKey, "approved");
    await pay(dan, pharmacy, 20);
  });

  it("rejects a registered merchant that hasn't been approved yet", async () => {
    await expectRejected(pay(dan, hardware, 20), "MerchantNotApproved");
    await w.client.setMerchantStatus(w.admin, w.mint, hardware.publicKey, "approved");
    await pay(dan, hardware, 20);
  });

  it("stops a frozen wallet from paying until it is thawed", async () => {
    await w.client.setWalletFrozen(w.oracle, w.mint, erin.publicKey, true);
    await expectRejected(pay(erin, pharmacy, 20), "AccountFrozen");
    await w.client.setWalletFrozen(w.oracle, w.mint, erin.publicKey, false);
    await pay(erin, pharmacy, 20);
  });
});

describe("agent allowance (Grok pays as an SPL delegate)", () => {
  let w: World;
  let fay: Keypair, grocer: Keypair;
  const agent = Keypair.generate();
  let pay: ReturnType<typeof payer>;

  beforeAll(async () => {
    w = await createWorld();
    pay = payer(w);
    [fay] = (await addResidents(w, 1, 1_000)) as [Keypair];
    grocer = await addMerchant(w, { category: "grocery" });
  });

  it("spends within its allowance and counts toward the resident's caps", async () => {
    await w.client.approveAgent(fay, w.mint, agent.publicKey, usd(120));
    await pay(fay, grocer, 100, agent);
    const wallet = await w.client.fetchWallet(fay.publicKey, w.mint);
    expect(BigInt(wallet.totalSpent.toString())).toBe(usd(100));

    // $20 of allowance left: Token-2022 refuses before our hook even runs.
    await expectRejected(pay(fay, grocer, 30, agent), "InsufficientFunds");

    await w.client.approveAgent(fay, w.mint, agent.publicKey, usd(500));
    await expectRejected(pay(fay, grocer, 250, agent), "OverOrderCap");
    await pay(fay, grocer, 150, agent); // $250 in the window
    await expectRejected(pay(fay, grocer, 60, agent), "OverDailyCap");
    await expectRejected(pay(fay, grocer, 60), "OverDailyCap"); // same cap when fay pays herself
  });
});

describe("spam orders", () => {
  it("can't beat the 24h cap by firing orders in parallel", async () => {
    const w = await createWorld();
    const [gil] = (await addResidents(w, 1, 1_000)) as [Keypair];
    const shop = await addMerchant(w);

    // 15 distinct orders of $25.00..$25.14: any 11 fit under $300, no 12 do.
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) =>
        w.client.pay({ mint: w.mint, resident: gil!.publicKey, signer: gil!, merchant: shop.publicKey, amount: usd(25 + i / 100) }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(11);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(ChainTxError);
      expect((f.reason as ChainTxError).decoded?.name).toBe("OverDailyCap");
    }
    const wallet = await w.client.fetchWallet(gil!.publicKey, w.mint);
    expect(BigInt(wallet.totalSpent.toString()) <= usd(300)).toBe(true);
  });
});

describe("expiry and clawback", () => {
  let w: World;
  let hana: Keypair, ivan: Keypair, shop: Keypair;
  let pay: ReturnType<typeof payer>;

  beforeAll(async () => {
    w = await createWorld({ aidDurationSecs: 30 * DAY });
    pay = payer(w);
    [hana, ivan] = (await addResidents(w, 2, 800)) as [Keypair, Keypair];
    shop = await addMerchant(w);
    await pay(hana, shop, 100);
  });

  it("won't claw back aid before it expires", async () => {
    await expectRejected(w.client.clawback(w.mint, [hana.publicKey]), "ClawbackTooEarly");
  });

  it("rejects spending once aid has expired", async () => {
    await w.client.setClock(w.admin, w.mint, 1, T0 + 30 * DAY + 60);
    await expectRejected(pay(hana, shop, 10), "AidExpired");
  });

  it("returns unspent aid to the treasury, even from a frozen wallet", async () => {
    await w.client.setWalletFrozen(w.oracle, w.mint, ivan.publicKey, true);
    const supplyBefore = (await getMint(w.client.connection, w.mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;

    await w.client.clawback(w.mint, [hana.publicKey, ivan.publicKey]);

    expect(await w.client.balance(hana.publicKey, w.mint)).toBe(0n);
    expect(await w.client.balance(ivan.publicKey, w.mint)).toBe(0n);
    const decl = await w.client.fetchDeclaration(w.mint);
    expect(BigInt(decl.returned.toString())).toBe(usd(700 + 800));
    const supplyAfter = (await getMint(w.client.connection, w.mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
    expect(supplyBefore - supplyAfter).toBe(usd(1_500));
    // The merchant keeps what it earned.
    expect(await w.client.balance(shop.publicKey, w.mint)).toBe(usd(100));
  });
});
