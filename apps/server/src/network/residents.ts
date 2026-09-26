import { randomBytes } from "node:crypto";
import { DEFAULT_RULES, type PreparedTx } from "@rescu/chain";
import {
  type AllowanceResult,
  base58Decode,
  base64ToBytes,
  bytesToBase64,
  type Custody,
  type Eligibility,
  type JoinInput,
  type Persona,
  type RelayResult,
  type Session,
  type SignRequest,
  type WalletView,
} from "@rescu/live";
import { type Keypair, PublicKey } from "@solana/web3.js";
import { latLngToCell } from "h3-js";
import { config } from "../config.js";
import type { Run } from "../run.js";
import { deriveKeypair } from "../wallets.js";
import { CATEGORIES, countyLabel, FRAUD, isOpen, NEAR_K, plantedStores } from "../world.js";
import { ApiFail } from "./errors.js";
import { haversineKm } from "./market.js";

const HOUR = 3_600;
const DAY = 86_400;
/** "I live here" must be this close to an eligible census tract. */
const JOIN_RADIUS_KM = 6;
const RELAY_TTL_MS = 60_000;
const ACCOUNT_CACHE_MS = 800;
export const PERSONAS = 6;
/** Phone registrations per run (each is an on-chain enrollment + aid; the public demo can't be flooded). */
const MAX_JOINS = 400;
/** A persona's open store must be this close (road trips after a storm are short). */
const PERSONA_SHOP_KM = 25;

/**
 * Someone driving a wallet from the resident app, Grok or MCP: a simulated household taken over
 * as a persona (`sim`, server custody, the sim stops shopping for it) or a person who registered
 * their own phone key ("I live here", index >= the sim's household count).
 */
export interface AppResident {
  idx: number;
  sim: boolean;
  custody: Custody;
  owner: PublicKey;
  /** Server custody only. */
  keypair: Keypair | null;
  name: string;
  lat: number;
  lon: number;
  h3: string;
  county: string;
  size: number;
  kids: boolean;
  pet: boolean;
  aidCents: number;
  /** Sim time the storm reaches their home. */
  aidDue: number;
  identity: { device: string; phone: string; address: string };
  /** Wall ms. */
  registeredAt: number;
  // Joined residents keep their own books (sim households use the run's arrays).
  enrolled: boolean;
  fundedAt: number;
  spentCents: number;
  window: { t: number; cents: number }[];
  /** Wall ms the aid was due (joined only, for time-to-aid). */
  dueWallMs: number;
  aidTries: number;
  agent: { approved: boolean; allowanceCents: number; signature: string | null };
}

interface PendingRelay {
  id: string;
  resident: number;
  purpose: SignRequest["purpose"];
  orderId: string | null;
  prepared: PreparedTx;
  expiresAt: number;
  complete: (signature: Uint8Array) => Promise<RelayResult>;
}

type Account = Awaited<ReturnType<Run["chain"]["tokenAccount"]>>;

/** The people side of a run: personas, sessions, "I live here", wallets and phone signatures. */
export class Residents {
  readonly joined: AppResident[] = [];
  readonly personaIdx: number[];
  private readonly byIdx = new Map<number, AppResident>();
  private readonly tokens = new Map<string, number>();
  private readonly relays = new Map<string, PendingRelay>();
  private readonly accounts = new Map<number, { at: number; value: Promise<Account>; landed: boolean }>();

  constructor(private readonly run: Run) {
    this.personaIdx = pickPersonas(run);
  }

  get(idx: number): AppResident | undefined {
    return this.byIdx.get(idx) ?? (idx >= 0 && idx < this.run.world.households.n ? this.fromSim(idx) : undefined);
  }

  /** The resident behind a session token (sessions die with the run). */
  fromToken(token: string | undefined | null): AppResident | undefined {
    if (!token) return undefined;
    const idx = this.tokens.get(token);
    return idx === undefined ? undefined : this.byIdx.get(idx);
  }

  /** A resident a person, agent or MCP client has driven this run (not just a sim household). */
  isApp(idx: number): boolean {
    return this.byIdx.has(idx);
  }

  /** Every resident a person, agent or MCP client has driven this run. */
  all(): AppResident[] {
    return [...this.byIdx.values()];
  }

  name(idx: number): string {
    return this.byIdx.get(idx)?.name ?? this.run.world.households.name[idx] ?? `Resident ${idx}`;
  }

  /** Home [lon, lat] of any household (sim or joined). */
  home(idx: number): [number, number] {
    const r = this.byIdx.get(idx);
    if (r) return [r.lon, r.lat];
    const H = this.run.world.households;
    return [H.lon[idx]!, H.lat[idx]!];
  }

  private session(r: AppResident): Session {
    const token = randomBytes(18).toString("base64url");
    this.tokens.set(token, r.idx);
    return { token, resident: r.idx, runId: this.run.key, custody: r.custody };
  }

  private fromSim(idx: number): AppResident {
    const W = this.run.world;
    const H = W.households;
    return {
      idx,
      sim: true,
      custody: "server",
      owner: this.run.residentKeys[idx]?.publicKey ?? PublicKey.default,
      keypair: this.run.residentKeys[idx] ?? null,
      name: H.name[idx]!,
      lat: H.lat[idx]!,
      lon: H.lon[idx]!,
      h3: H.h3[idx]!,
      county: countyLabel(W, H.county[idx]!),
      size: H.size[idx]!,
      kids: !!H.kids[idx],
      pet: !!H.pet[idx],
      aidCents: H.aidCents[idx]!,
      aidDue: H.aidDue[idx]!,
      identity: { device: H.device[idx]!, phone: H.phone[idx]!, address: H.address[idx]! },
      registeredAt: 0,
      enrolled: !!this.run.enrolled[idx],
      fundedAt: Number.NaN,
      spentCents: 0,
      window: [],
      dueWallMs: 0,
      aidTries: 0,
      agent: { approved: false, allowanceCents: 0, signature: null },
    };
  }

  // ---------- personas ----------

  personas(): Persona[] {
    const H = this.run.world.households;
    return this.personaIdx.map((idx) => {
      const r = this.fromSim(idx);
      return {
        resident: idx,
        name: r.name,
        blurb: blurb(r),
        county: r.county,
        lat: r.lat,
        lon: r.lon,
        size: r.size,
        kids: r.kids,
        pet: r.pet,
        aidCents: r.aidCents,
        aidDueAt: r.aidDue,
        landed: !Number.isNaN(this.run.hh.fundedAt[idx]!),
        claimed: this.byIdx.has(idx),
        prompts: prompts(r, H.svi[idx]!),
      };
    });
  }

  /** Takes over a simulated household: the sim stops shopping for it; this session drives it. */
  claim(idx: number): Session {
    const H = this.run.world.households;
    if (!Number.isInteger(idx) || idx < 0 || idx >= H.n) throw new ApiFail(404, "not_found", `No household ${idx} in this run`);
    if (!this.run.enrolled[idx]) throw new ApiFail(409, "not_enrolled", "That household isn't registered on-chain");
    let r = this.byIdx.get(idx);
    if (!r) {
      r = this.fromSim(idx);
      this.byIdx.set(idx, r);
    }
    this.run.hh.done[idx] = 1;
    this.run.hh.nextTrip[idx] = Infinity;
    return this.session(r);
  }

  // ---------- "I live here" ----------

  eligibility(lat: number, lon: number): Eligibility {
    const W = this.run.world;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < W.tracts.length; i++) {
      const t = W.tracts[i]!;
      if (t.cents <= 0) continue;
      const d = haversineKm(lat, lon, t.lat, t.lon);
      if (d < bestD) [best, bestD] = [i, d];
    }
    if (best < 0) return { eligible: false, reason: "No aid has been declared for this storm", county: null, h3: null, aidCents: 0, aidDueAt: null, suggestion: null };
    const t = W.tracts[best]!;
    const county = countyLabel(W, t.county);
    if (bestD > JOIN_RADIUS_KM) {
      return {
        eligible: false,
        reason: `Outside the declared disaster area (nearest eligible neighborhood is ${Math.round(bestD)} km away, in ${county})`,
        county: null,
        h3: null,
        aidCents: 0,
        aidDueAt: null,
        suggestion: { lat: t.lat, lon: t.lon, county },
      };
    }
    const h3 = latLngToCell(lat, lon, 5);
    return { eligible: true, reason: null, county, h3, aidCents: t.cents, aidDueAt: W.aidDueAt(h3), suggestion: null };
  }

  /** Registers a phone's key (or a server-held key when the phone can't make one) and schedules its aid. */
  async join(input: JoinInput): Promise<Session> {
    const run = this.run;
    if (run.phase !== "ready" && run.phase !== "live") throw new ApiFail(409, "no_run", `The relief network is ${run.phase}; registration opens once it's staged`);
    if (this.joined.length >= MAX_JOINS) throw new ApiFail(429, "registration_full", "This demo run has all the phone registrations it can take. Pick a resident instead.");
    const el = this.eligibility(input.lat, input.lon);
    if (!el.eligible) throw new ApiFail(422, "not_eligible", el.reason ?? "Not eligible");
    const idx = run.world.households.n + this.joined.length;
    let owner: PublicKey;
    let keypair: Keypair | null = null;
    if (input.pubkey) {
      let bytes: Uint8Array;
      try {
        bytes = base58Decode(input.pubkey);
      } catch {
        throw new ApiFail(400, "bad_key", "pubkey isn't base58");
      }
      if (bytes.length !== 32) throw new ApiFail(400, "bad_key", "pubkey must be 32 bytes");
      owner = new PublicKey(bytes);
    } else {
      keypair = deriveKeypair(config.seed, `app-resident:${run.key}:${idx}`);
      owner = keypair.publicKey;
    }
    const r: AppResident = {
      idx,
      sim: false,
      custody: input.pubkey ? "device" : "server",
      owner,
      keypair,
      name: input.name,
      lat: input.lat,
      lon: input.lon,
      h3: el.h3!,
      county: el.county!,
      size: 3,
      kids: false,
      pet: false,
      aidCents: el.aidCents,
      aidDue: el.aidDueAt!,
      identity: { device: input.identity.deviceId, phone: input.identity.phone ?? "", address: input.identity.address ?? "" },
      registeredAt: Date.now(),
      enrolled: false,
      fundedAt: Number.NaN,
      spentCents: 0,
      window: [],
      dueWallMs: 0,
      aidTries: 0,
      agent: { approved: false, allowanceCents: 0, signature: null },
    };
    this.joined.push(r);
    this.byIdx.set(idx, r);
    await run.enrollApp(r);
    return this.session(r);
  }

  // ---------- wallets ----------

  /**
   * The chain's view of a resident's relief account, cached briefly (phones poll this). A read
   * taken before the aid landed is never reused after it, or the wallet shows "landed, $0".
   */
  account(r: AppResident, fresh = false): Promise<Account> {
    const landed = !Number.isNaN(this.fundedAt(r));
    const hit = this.accounts.get(r.idx);
    if (!fresh && hit && hit.landed === landed && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.value;
    const value = this.run.chain.tokenAccount(r.owner, this.run.mint);
    this.accounts.set(r.idx, { at: Date.now(), value, landed });
    return value;
  }

  /** Aid landed (sim time), NaN if not yet. */
  fundedAt(r: AppResident): number {
    return r.sim ? this.run.hh.fundedAt[r.idx]! : r.fundedAt;
  }

  spent(r: AppResident): number {
    return r.sim ? this.run.hh.spent[r.idx]! : r.spentCents;
  }

  /** Landed spending in the rolling 24 h window ending at sim time t. */
  windowSpent(r: AppResident, t: number): number {
    if (r.sim) return this.run.hh.spentSince(r.idx, t - DAY);
    return r.window.filter((w) => w.t > t - DAY).reduce((a, w) => a + w.cents, 0);
  }

  /** Books a landed app payment into the resident's own ledger. */
  booked(r: AppResident, t: number, cents: number) {
    if (r.sim) {
      this.run.hh.spent[r.idx]! += cents;
      this.run.hh.record(r.idx, t, cents);
    } else {
      r.spentCents += cents;
      r.window.push({ t, cents });
      if (r.window.length > 64) r.window.splice(0, r.window.length - 64);
    }
    this.accounts.delete(r.idx);
  }

  async wallet(r: AppResident): Promise<WalletView> {
    const run = this.run;
    const t = run.clock.now();
    const acct = await this.account(r);
    const landedAt = this.fundedAt(r);
    const aid = run.aidLog.get(r.idx);
    const cap = DEFAULT_RULES.dailyCapUsd * 100;
    const inWindow = this.windowSpent(r, t);
    const agentKey = run.chain.keys.agent.publicKey;
    const delegated = acct && acct.delegate?.equals(agentKey) ? Number(acct.delegatedAmount / 10_000n) : 0;
    return {
      runId: run.key,
      resident: r.idx,
      owner: r.owner.toBase58(),
      name: r.name,
      custody: r.custody,
      home: { lat: r.lat, lon: r.lon, county: r.county, h3: r.h3 },
      household: { size: r.size, kids: r.kids, pet: r.pet },
      aid: {
        cents: r.aidCents,
        landed: !Number.isNaN(landedAt),
        dueAt: r.aidDue,
        landedAt: Number.isNaN(landedAt) ? null : landedAt,
        signature: aid?.signature ?? null,
        timeToAidMs: aid?.timeToAidMs ?? null,
      },
      balanceCents: acct ? Number(acct.amount / 10_000n) : 0,
      spentCents: this.spent(r),
      window: { spentCents: inWindow, capCents: cap, remainingCents: Math.max(0, cap - inWindow), perOrderCapCents: DEFAULT_RULES.perOrderCapUsd * 100 },
      agent: { approved: delegated > 0, allowanceCents: delegated, signature: r.agent.signature },
      frozen: acct?.isFrozen ?? run.frozen.has(r.idx),
      flagged: run.residentCase.has(r.idx),
      expiresAt: run.world.domain.end,
      simNow: t,
    };
  }

  /** Grants (or revokes, with 0) the agent's allowance. Device custody gets a SignRequest to finish on the phone. */
  async setAllowance(r: AppResident, cents: number): Promise<AllowanceResult> {
    const run = this.run;
    if (r.custody === "server") {
      const res = await run.chain.approveAgent(run.mint, r.keypair!, cents);
      if (!res.ok) throw new ApiFail(502, res.decoded?.name ?? "chain_error", res.decoded?.message ?? "Approve failed");
      r.agent = { approved: cents > 0, allowanceCents: cents, signature: res.signature };
      this.accounts.delete(r.idx);
      return { wallet: await this.wallet(r), sign: null };
    }
    const prepared = await run.chain.prepareApprove(run.mint, r.owner, cents);
    const sign = this.relayRequest(r, "approve_agent", prepared, null, async (sig) => {
      const res = await run.chain.submitPrepared(prepared, { [r.owner.toBase58()]: sig });
      if (res.ok) r.agent = { approved: cents > 0, allowanceCents: cents, signature: res.signature };
      this.accounts.delete(r.idx);
      return { ok: res.ok, signature: res.signature, rule: res.ok ? null : (res.decoded?.name ?? null), message: res.ok ? null : (res.decoded?.message ?? null), order: null, wallet: await this.wallet(r) };
    });
    return { wallet: null, sign };
  }

  // ---------- phone signatures ----------

  /** Parks a prepared transaction until the phone signs it. */
  relayRequest(r: AppResident, purpose: SignRequest["purpose"], prepared: PreparedTx, orderId: string | null, complete: PendingRelay["complete"]): SignRequest {
    const id = randomBytes(12).toString("base64url");
    const expiresAt = Date.now() + RELAY_TTL_MS;
    this.relays.set(id, { id, resident: r.idx, purpose, orderId, prepared, expiresAt, complete });
    for (const [k, v] of this.relays) if (v.expiresAt < Date.now()) this.relays.delete(k);
    return { id, purpose, messageB64: bytesToBase64(prepared.message), signer: r.owner.toBase58(), orderId, expiresAt };
  }

  async relay(r: AppResident, id: string, signatureB64: string): Promise<RelayResult> {
    const p = this.relays.get(id);
    if (!p || p.resident !== r.idx) throw new ApiFail(404, "not_found", "Nothing waiting for that signature");
    this.relays.delete(id);
    if (p.expiresAt < Date.now()) throw new ApiFail(410, "expired", "That request expired; try again");
    const sig = base64ToBytes(signatureB64);
    if (sig.length !== 64) throw new ApiFail(400, "bad_signature", "Signature must be 64 bytes");
    return p.complete(sig);
  }
}

// ---------- persona picking and copy ----------

/**
 * Six honest households the storm reaches around landfall, in six different counties, favouring
 * the biggest payouts and a mix of household types. Each has a grocery or general store within
 * reach that is open from the hour their aid lands, so asking Grok right away finds food and water.
 */
function pickPersonas(run: Run): number[] {
  const W = run.world;
  const H = W.households;
  const M = W.merchants;
  const lf = W.domain.landfall;
  const cands: number[] = [];
  // Keep the demo clean: no persona lives next to a planted gouger or colluding store.
  const bad = plantedStores(W);
  const per = CATEGORIES.length * NEAR_K;
  const nearBad = (h: number) => {
    for (let k = h * per; k < (h + 1) * per; k++) if (bad.has(H.near[k]!)) return true;
    return false;
  };
  const food = [CATEGORIES.indexOf("grocery"), CATEGORIES.indexOf("general")];
  const shopsOpen = (h: number, due: number) => {
    for (const c of food)
      for (let k = 0; k < NEAR_K; k++) {
        const m = H.near[h * per + c * NEAR_K + k]!;
        if (m < 0 || haversineKm(H.lat[h]!, H.lon[h]!, M.lat[m]!, M.lon[m]!) > PERSONA_SHOP_KM) continue;
        if (isOpen(W, m, due + HOUR) && isOpen(W, m, due + 12 * HOUR) && isOpen(W, m, due + 36 * HOUR)) return true;
      }
    return false;
  };
  for (let h = 0; h < H.n; h++) {
    if (H.rogue[h] || H.fraud[h] !== FRAUD.none || nearBad(h)) continue;
    const due = H.aidDue[h]!;
    if (due < lf - 8 * HOUR || due > lf + 20 * HOUR) continue;
    if (!shopsOpen(h, due)) continue;
    cands.push(h);
  }
  cands.sort((a, b) => H.aidCents[b]! - H.aidCents[a]! || a - b);
  const want: ((h: number) => boolean)[] = [
    (h) => !!H.kids[h] && H.size[h]! >= 4,
    (h) => H.size[h] === 1,
    (h) => !!H.pet[h] && !H.kids[h],
    (h) => H.size[h]! >= 5,
    (h) => H.size[h] === 2,
    () => true,
  ];
  const picked: number[] = [];
  const counties = new Set<string>();
  // Six different first names, so the presenter can say "Priya" and everyone knows who.
  const firsts = new Set<string>();
  const first = (h: number) => H.name[h]!.split(" ")[0]!;
  const free = (c: number) => !picked.includes(c) && !firsts.has(first(c));
  for (const test of want) {
    const h = cands.find((c) => free(c) && !counties.has(H.county[c]!) && test(c)) ?? cands.find((c) => free(c) && test(c));
    if (h === undefined) continue;
    picked.push(h);
    counties.add(H.county[h]!);
    firsts.add(first(h));
  }
  for (const c of cands) {
    if (picked.length >= PERSONAS) break;
    if (free(c)) {
      picked.push(c);
      firsts.add(first(c));
    }
  }
  return picked.slice(0, PERSONAS);
}

function blurb(r: AppResident): string {
  const place = r.county;
  const who = r.size === 1 ? "Lives alone" : r.size === 2 ? "A couple" : `Family of ${r.size}`;
  const extra = [r.kids ? "young kids at home" : null, r.pet ? "a dog" : null].filter(Boolean).join(" and ");
  return `${who} in ${place}${extra ? `, with ${extra}` : ""}.`;
}

function prompts(r: AppResident, svi: number): string[] {
  const out: string[] = [];
  if (r.kids) out.push(`We're ${r.size} people with a baby. Out of formula, diapers and water.`);
  if (r.size === 1 || svi > 0.7) out.push("I need my prescription refilled and food for a few days.");
  out.push(`Storm hit, we're ${r.size} ${r.size === 1 ? "person" : "people"}, out of water and food, no power.`);
  if (r.pet) out.push("Need water, batteries and dog food.");
  out.push("Roof is leaking. Tarp and cleanup supplies, please.");
  return out.slice(0, 3);
}
