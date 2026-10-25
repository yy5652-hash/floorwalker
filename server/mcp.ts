// Allowance as an MCP server: any MCP client (Claude Desktop, Claude Code, your own agent)
// gets the PayPal tools with every money move checked against the owner's rules.
// Held actions show up in the web app's Approvals tab; both share the same ledger.
//   claude mcp add allowance -- npx tsx server/mcp.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentTools, runTool } from "./agent/tools.ts";
import type { Ticket } from "./db.ts";
import * as store from "./db.ts";
import { GUARDED_TOOLS } from "./guard/index.ts";

// MCP clients act as their own agent, with its own row on the Agents page (and its own freeze switch).
if (!store.agent("mcp")) store.upsertAgent({ id: "mcp", name: "External agent (MCP)", role: "Any MCP client, such as Claude Desktop", can_refund: 1, can_payout: 1 });

// Over MCP there is no inbox, so the client says who asked and passes their message along.
// Allowance treats both as claims: the reviewer weighs them against PayPal's own records.
const REQUESTER = {
  requester_email: { type: "string", description: "Email of the person who asked for this money move" },
  source_message: { type: "string", description: "The message that asked for it, verbatim" },
};

const server = new Server({ name: "allowance", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: agentTools(REQUESTER, ["requester_email", "source_message"]).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema as any })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: input = {} } = req.params as { name: string; arguments?: Record<string, any> };
  const ticket: Ticket | undefined = GUARDED_TOOLS.has(name)
    ? {
        id: `MCP-${Date.now().toString(36)}`, channel: "email", from_name: String(input.requester_email ?? "unknown"), from_email: String(input.requester_email ?? ""),
        subject: "Request relayed by an MCP client", body: String(input.source_message ?? ""), received_at: new Date().toISOString(), status: "open", reply: null,
      }
    : undefined;
  try {
    const r = await runTool(name, input, ticket, undefined, "mcp");
    return { content: [{ type: "text", text: r.text }], isError: r.isError };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
