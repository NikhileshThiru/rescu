/**
 * "Try to break it": each button fires a real attack at the program on our validator, in a small
 * sandbox declaration (its own mint, stores and residents) so the live run's numbers stay clean.
 * Every rejection lands on-chain with the rule in its logs; the panel links the transaction.
 */

export type BreakCaseId =
  | "control"
  | "unregistered"
  | "out_of_zone"
  | "resale"
  | "over_order_cap"
  | "over_daily_cap"
  | "pending"
  | "suspended"
  | "frozen"
  | "expired"
  | "agent_over_allowance"
  | "hook_direct"
  | "not_oracle";

export type BreakGroup = "rules" | "oracle" | "ai" | "attacks";

export interface BreakCase {
  id: BreakCaseId;
  group: BreakGroup;
  /** "Pay a store that isn't registered". */
  title: string;
  /** What the attacker is trying, one sentence. */
  attack: string;
  /** The on-chain rule we expect to stop it (null for the control, which should land). */
  expect: string | null;
}

export const BREAK_CASES: BreakCase[] = [
  { id: "control", group: "rules", title: "Buy water at an approved store", attack: "A resident pays $12.99 at a registered, approved store in the zone. This one should land.", expect: null },
  { id: "unregistered", group: "rules", title: "Pay a store that isn't registered", attack: "Send relief dollars to a shop that never enrolled as a relief merchant.", expect: "NotRegisteredMerchant" },
  { id: "out_of_zone", group: "rules", title: "Spend outside the disaster zone", attack: "Pay a registered merchant from a different disaster declaration.", expect: "OutOfZone" },
  { id: "resale", group: "rules", title: "Sell aid to another resident", attack: "Transfer relief dollars straight to another resident's wallet.", expect: "ResaleBlocked" },
  { id: "over_order_cap", group: "rules", title: "Buy a $499 generator", attack: "One order over the $200 per-order cap.", expect: "OverOrderCap" },
  { id: "over_daily_cap", group: "rules", title: "Go on a spending spree", attack: "Three orders in a row that add up past $300 in 24 hours.", expect: "OverDailyCap" },
  { id: "pending", group: "oracle", title: "Pay a store still under review", attack: "Pay a registered merchant that hasn't been approved yet.", expect: "MerchantNotApproved" },
  { id: "suspended", group: "oracle", title: "Pay a suspended gouger", attack: "Pay a store the oracle suspended for price gouging.", expect: "MerchantSuspended" },
  { id: "frozen", group: "oracle", title: "Spend from a frozen wallet", attack: "A wallet the oracle froze for duplicate registrations tries to buy food.", expect: "AccountFrozen" },
  { id: "expired", group: "rules", title: "Spend after Day 30", attack: "Pay a store after the aid expired (the sandbox's clock is past expiry).", expect: "AidExpired" },
  { id: "agent_over_allowance", group: "ai", title: "Jailbreak the AI shopper", attack: "The agent key tries to spend more than the allowance the resident granted it.", expect: "InsufficientFunds" },
  { id: "hook_direct", group: "attacks", title: "Call the rule program directly", attack: "Invoke the transfer hook outside a real transfer to fake an approval.", expect: "NotTransferring" },
  { id: "not_oracle", group: "attacks", title: "Suspend a rival store", attack: "A key that isn't the oracle tries to suspend a competitor.", expect: "Unauthorized" },
];

export interface BreakitState {
  /** The sandbox is staged on-chain and every case can run. */
  ready: boolean;
  /** What's being set up, or why it can't run. */
  status: string;
  cases: BreakCase[];
  /** The latest result per case this session (server memory). */
  results: BreakResult[];
  explorerCluster: string;
}

export interface BreakResult {
  id: BreakCaseId;
  /** True when the transaction LANDED (only the control should). */
  landed: boolean;
  /** The rule that stopped it, decoded from the chain ("OverDailyCap"), null if it landed. */
  rule: string | null;
  /** Plain-English copy for the rule (REJECTION_COPY). */
  message: string;
  /** Matches `expect` (rejected by the expected rule, or the control landed). */
  asExpected: boolean;
  signature: string | null;
  latencyMs: number;
  /** A few of the transaction's log lines, the rule's line included. */
  logs: string[];
  /** Wall ms. */
  at: number;
}
