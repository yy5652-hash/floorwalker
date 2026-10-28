// Floorwalker as a local MCP server: any MCP client (Claude Desktop, Claude Code, your own agent)
// gets the PayPal tools with every money move checked against the owner's rules.
// It works on the local workspace; the hosted app serves the same tools at /v1/mcp with an agent key.
//   claude mcp add floorwalker -- npx tsx server/mcp.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as store from "./db.ts";
import { createMcpServer } from "./mcp-server.ts";

// MCP clients act as their own agent, with its own row on the Agents page (and its own freeze switch).
if (!store.agent("mcp")) store.upsertAgent({ id: "mcp", name: "External agent (MCP)", role: "Any MCP client, such as Claude Desktop", can_refund: 1, can_payout: 1 });

await createMcpServer("mcp").connect(new StdioServerTransport());
