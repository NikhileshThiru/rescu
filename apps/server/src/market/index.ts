import type { FastifyInstance } from "fastify";
import type { Services } from "../services.js";

/**
 * Relief Market routes (`/api/market/*` in @rescu/live's ApiRoutes), the MCP server at /mcp and
 * the Grok agent. Owner: step 5.
 */
export async function registerMarket(_app: FastifyInstance, _s: Services): Promise<void> {}
