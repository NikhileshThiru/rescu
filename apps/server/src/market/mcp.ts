import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MARKET_TOOLS, MCP_PATH, type MarketToolName } from "@rescu/live";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ApiFail } from "../network/errors.js";
import { residentOf, type Services } from "../services.js";
import { runTool, toolError } from "./tools.js";

/**
 * The Relief Market as an MCP server (Streamable HTTP, stateless): any outside agent with a
 * resident's session token can search, propose and pay, through the agent's on-chain allowance
 * and inside the same caps. A fresh server + transport per request, bound to that resident.
 */
export function registerMcp(app: FastifyInstance, s: Services) {
  app.post(MCP_PATH, async (req, reply) => {
    let who: ReturnType<typeof residentOf>;
    try {
      who = residentOf(s, req);
    } catch (err) {
      const e = err instanceof ApiFail ? err : new ApiFail(500, "server_error", (err as Error).message);
      return jsonRpcError(reply, e.status, e.status === 401 ? -32001 : -32000, e.message, requestId(req.body));
    }
    const { run, resident } = who;
    const server = new McpServer(
      { name: "rescu-relief-market", version: "0.1.0" },
      {
        instructions: `Relief Market for ${resident.name} (${resident.county}), a resident of the ${run.info().stormName} relief network. Relief dollars can only be spent at verified relief stores. Search before proposing; one store per order; confirm_order pays from the resident's wallet through the agent allowance they granted, and the chain enforces the $200 per-order and $300 per-24h caps.`,
      },
    );
    for (const name of Object.keys(MARKET_TOOLS) as MarketToolName[]) {
      const tool = MARKET_TOOLS[name];
      server.registerTool(name, { description: tool.description, inputSchema: tool.input.shape }, async (args: unknown) => {
        try {
          const out = await runTool(run, resident, name, args, "mcp");
          return { content: [{ type: "text" as const, text: JSON.stringify(out.result) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify(toolError(err)) }], isError: true };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    // Keep the CORS headers @fastify/cors set on the reply.
    for (const [k, v] of Object.entries(reply.getHeaders())) if (v !== undefined) reply.raw.setHeader(k, v as string);
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      console.error("mcp:", err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  const notAllowed = async (_req: unknown, reply: FastifyReply) =>
    reply.status(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null });
  app.get(MCP_PATH, notAllowed);
  app.delete(MCP_PATH, notAllowed);
}

function requestId(body: unknown): string | number | null {
  const b = body as { id?: unknown } | null;
  return typeof b?.id === "string" || typeof b?.id === "number" ? b.id : null;
}

function jsonRpcError(reply: FastifyReply, status: number, code: number, message: string, id: string | number | null) {
  return reply.status(status).send({ jsonrpc: "2.0", error: { code, message }, id });
}
