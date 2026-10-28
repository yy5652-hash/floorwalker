import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentTools, runTool, toolsForAgent } from "./agent/tools.ts";
import { assertActionQuota } from "./billing.ts";
import { ctx } from "./context.ts";
import * as store from "./db.ts";
import { GUARDED_TOOLS } from "./guard/index.ts";

// Over MCP there is no inbox, so the client says who asked and passes their message along.
// Floorwalker treats both as claims: the reviewer weighs them against PayPal's own records.
const REQUESTER = {
  requester_email: { type: "string", description: "Email of the person who asked for this money move" },
  source_message: { type: "string", description: "The message that asked for it, verbatim" },
};

/** An MCP server acting as one agent: it lists only the tools that agent may use, and every money move is checked. */
export function createMcpServer(agentId: string): Server {
  const server = new Server({ name: "floorwalker", version: "1.0.0" }, { capabilities: { tools: {} } });
  const allowed = () => {
    const a = store.agent(agentId);
    return new Set(a ? toolsForAgent(a) : []);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const names = allowed();
    return {
      tools: agentTools(REQUESTER, ["requester_email", "source_message"])
        .filter((t) => names.has(t.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema as any })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: input = {} } = req.params as { name: string; arguments?: Record<string, any> };
    if (!allowed().has(name)) return { content: [{ type: "text", text: `This agent can't use ${name}.` }], isError: true };
    if (GUARDED_TOOLS.has(name)) {
      try {
        assertActionQuota(ctx().ws.id, store.actionsThisMonth());
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    }
    const ticket: store.Ticket | undefined = GUARDED_TOOLS.has(name)
      ? {
          id: `MCP-${Date.now().toString(36)}`, channel: "relay", from_name: String(input.requester_email ?? "unknown"), from_email: String(input.requester_email ?? ""),
          subject: "Request relayed by an MCP client", body: String(input.source_message ?? ""), received_at: new Date().toISOString(), status: "open", reply: null,
        }
      : undefined;
    try {
      const r = await runTool(name, input, ticket, undefined, agentId, "mcp");
      return { content: [{ type: "text", text: r.text }], isError: r.isError };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });
  return server;
}
