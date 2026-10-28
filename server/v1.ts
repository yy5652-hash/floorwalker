// The agent API: what an agent built anywhere calls instead of PayPal, with an agent key.
//   POST /v1/refunds, POST /v1/payouts   ask to move money; the answer says executed, held or blocked
//   GET  /v1/actions/:id                 follow a held request until the owner answers
//   POST /v1/mcp                         the same tools over MCP (Streamable HTTP)
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod/v4";
import { ctx, inWorkspace } from "./context.ts";
import * as store from "./db.ts";
import { actionView, guard } from "./guard/index.ts";
import { verifyKey, type ApiKey } from "./keys.ts";
import { createMcpServer } from "./mcp-server.ts";
import { assertActionQuota } from "./billing.ts";
import { buildOpenApi } from "./openapi.ts";
import { openWorkspace, workspaceRow } from "./workspaces.ts";

export const v1 = Router();

const fail = (res: Response, status: number, code: string, message: string) => void res.status(status).json({ error: { code, message } });


const Requester = {
  requester_email: z.email().optional().describe("Who asked for this money move"),
  source_message: z.string().max(20_000).optional().describe("Their message, verbatim"),
};
const RefundBody = z.object({
  capture_id: z.string().min(1).max(64),
  amount: z.number().positive().max(100_000).optional(),
  note: z.string().max(255).optional(),
  reason: z.string().min(1).max(2000),
  ...Requester,
  requester_email: z.email().describe("Who asked for this refund; Floorwalker checks it against the buyer on the PayPal order"),
});
const PayoutBody = z.object({
  email: z.email(),
  amount: z.number().positive().max(100_000),
  note: z.string().max(255).optional(),
  reason: z.string().min(1).max(2000),
  ...Requester,
});

let openapi: unknown;
v1.get("/openapi.json", (_req, res) => {
  openapi ??= buildOpenApi({ refund: z.toJSONSchema(RefundBody, { io: "input" }), payout: z.toJSONSchema(PayoutBody, { io: "input" }) });
  res.json(openapi);
});

// 120 calls a minute per key is far above what an agent needs and stops a runaway loop early.
const calls = new Map<string, number[]>();
function limited(key: ApiKey) {
  const since = Date.now() - 60_000;
  const recent = (calls.get(key.id) ?? []).filter((t) => t > since);
  recent.push(Date.now());
  calls.set(key.id, recent);
  return recent.length > 120;
}

const agentId = (res: Response) => (res.locals.key as ApiKey).agent_id;

v1.use((req: Request, res: Response, next: NextFunction) => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  const key = m ? verifyKey(m[1]) : undefined;
  if (!key || !workspaceRow(key.ws_id)) return fail(res, 401, "unauthorized", "Missing or invalid API key. Create one under Developers in Floorwalker.");
  if (limited(key)) return fail(res, 429, "rate_limited", "Too many calls; at most 120 a minute per key.");
  res.locals.key = key;
  const actor = { kind: "agent" as const, id: key.agent_id, name: key.agent_id, onBehalfOf: `key ${key.prefix}…`, ip: req.ip };
  inWorkspace(openWorkspace(key.ws_id), actor, () => {
    const agent = store.agent(key.agent_id);
    if (!agent) return fail(res, 403, "agent_removed", "The agent this key belongs to no longer exists.");
    actor.name = agent.name;
    next();
  });
});

v1.get("/agent", (_req, res) => {
  const a = store.agent(agentId(res))!;
  res.json({
    id: a.id, object: "agent", name: a.name, status: a.status, workspace: ctx().ws.name,
    can_refund: Boolean(a.can_refund), can_payout: Boolean(a.can_payout),
    controls: { max_per_action: a.max_per_action, budget: a.budget, budget_period: a.budget_period, payees: a.payees ? JSON.parse(a.payees) : null, expires_at: a.expires_at },
  });
});

function requestTicket(body: { requester_email?: string; source_message?: string }): store.Ticket | undefined {
  if (!body.requester_email && !body.source_message) return undefined;
  return {
    id: `API-${Date.now().toString(36)}`, channel: "relay", from_name: body.requester_email ?? "unknown", from_email: body.requester_email ?? "",
    subject: "Request relayed by an agent over the API", body: body.source_message ?? "", received_at: new Date().toISOString(), status: "open", reply: null,
  };
}

async function moveMoney(req: Request, res: Response, tool: "create_refund" | "send_payout") {
  const parsed = (tool === "create_refund" ? RefundBody : PayoutBody).safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "invalid_request", z.prettifyError(parsed.error));
  const idem = req.header("Idempotency-Key");
  if (idem !== undefined && !/^[\x21-\x7e]{1,255}$/.test(idem)) return fail(res, 400, "invalid_request", "Idempotency-Key must be 1-255 visible ASCII characters.");
  const b: any = parsed.data;
  try {
    assertActionQuota(ctx().ws.id, store.actionsThisMonth());
  } catch (e: any) {
    return fail(res, 402, e.code ?? "plan_limit", e.message);
  }
  const input = tool === "create_refund"
    ? { capture_id: b.capture_id, ...(b.amount ? { amount: { value: b.amount.toFixed(2), currency_code: "USD" } } : {}), note_to_payer: b.note }
    : { email: b.email, amount: b.amount, note: b.note ?? "" };
  try {
    const out = await guard(tool, input, { agentId: agentId(res), justification: b.reason, ticket: requestTicket(b), idempotencyKey: idem, source: "api" });
    res.json({ ...actionView(out.row), message: out.text });
  } catch (e: any) {
    fail(res, 502, "upstream_error", e.message);
  }
}

v1.post("/refunds", (req, res) => moveMoney(req, res, "create_refund"));
v1.post("/payouts", (req, res) => moveMoney(req, res, "send_payout"));

v1.get("/actions/:id", (req, res) => {
  const id = Number(String(req.params.id).replace(/^act_/, ""));
  const row = Number.isInteger(id) ? store.ledgerEntry(id) : undefined;
  if (!row || row.agent_id !== agentId(res)) return fail(res, 404, "not_found", "No such action for this agent.");
  res.json(actionView(row));
});

v1.get("/actions", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const rows = store.ledger().filter((r) => r.agent_id === agentId(res) && (!status || r.status === status)).slice(0, 100);
  res.json({ object: "list", data: rows.map(actionView) });
});

// Stateless Streamable HTTP: each POST carries a whole MCP exchange, authenticated by the same agent key.
v1.post("/mcp", async (req, res) => {
  const server = createMcpServer(agentId(res));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
v1.all("/mcp", (_req, res) => fail(res, 405, "method_not_allowed", "This MCP endpoint is stateless: POST only."));

v1.use((_req, res) => fail(res, 404, "not_found", "No such endpoint. See /v1/openapi.json."));
