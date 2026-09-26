import type { MarketToolName, Offer, Order, ProposeOrderInput, SearchItemsInput, WalletView } from "@rescu/live";
import { proposeOrder, runTool, searchItems, simDate } from "../market/tools.js";
import type { AppResident } from "../network/residents.js";
import type { Run } from "../run.js";

/**
 * Everything the agent (Grok or the scripted planner) can see and do for one resident. The
 * server builds it from the live run; tests pass a fake.
 */
export interface AgentEnv {
  resident: { idx: number; name: string; county: string; size: number; kids: boolean; pet: boolean };
  stormName: string;
  /** "Fri, Sep 27, 2:10 AM" in the storm's time zone. */
  today(): string;
  wallet(): Promise<WalletView>;
  search(input: SearchItemsInput): Offer[];
  propose(input: ProposeOrderInput): Promise<Order>;
  /** One Relief Market tool, compact JSON result (same handlers as MCP). */
  tool(name: MarketToolName, args: unknown): Promise<{ result: unknown; summary: string; order?: Order }>;
  order(id: string): Order | undefined;
}

export function runEnv(run: Run, r: AppResident): AgentEnv {
  return {
    resident: { idx: r.idx, name: r.name, county: r.county, size: r.size, kids: r.kids, pet: r.pet },
    stormName: run.info().stormName,
    today: () => simDate(run),
    wallet: () => run.people.wallet(r),
    search: (input) => searchItems(run, r, input),
    propose: (input) => proposeOrder(run, r, input, "agent"),
    tool: (name, args) => runTool(run, r, name, args, "agent"),
    order: (id) => run.orders.get(id),
  };
}
