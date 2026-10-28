import * as store from "../db.ts";
import { GUARDED_TOOLS, guardedCall, type GuardEvent } from "../guard/index.ts";
import type { ToolDef } from "../llm.ts";
import { callToolkit, toolkitToolDefs } from "../toolkit.ts";

const REASON = {
  type: "string",
  description: "Why this is the right action, citing the customer's message and the order facts. Floorwalker shows this to the owner.",
};

const OWN_TOOLS: ToolDef[] = [
  {
    name: "find_customer_orders",
    description: "List this shop's PayPal orders for a customer email: order id, capture id (needed for refunds), items, amount, date and shipment tracking.",
    input_schema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  },
  {
    name: "lookup_contact",
    description: "Find a person the shop works with (contractors, freelancers) by name. Returns their PayPal email and what they do.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "send_payout",
    description: "Pay a person (contractor, freelancer) from the shop's PayPal balance with PayPal Payouts. Use only for work the business asked to be paid for.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "PayPal email of the recipient" },
        amount: { type: "number", description: "USD amount" },
        note: { type: "string", description: "Note shown to the recipient" },
        reason: REASON,
      },
      required: ["email", "amount", "note", "reason"],
    },
  },
];

/**
 * The agent's tools: PayPal Agent Toolkit tools plus Floorwalker's own. Money-moving tools
 * get a required `reason`, and any `extra` properties (the MCP server adds the requester).
 */
export function agentTools(extra: Record<string, unknown> = {}, extraRequired: string[] = []): ToolDef[] {
  const addReason = (t: ToolDef): ToolDef => {
    if (!GUARDED_TOOLS.has(t.name)) return t;
    const schema = t.input_schema as any;
    return {
      ...t,
      input_schema: {
        ...schema,
        properties: { ...schema.properties, reason: REASON, ...extra },
        required: [...new Set([...(schema.required ?? []), "reason", ...extraRequired])],
      },
    };
  };
  return [...toolkitToolDefs(), ...OWN_TOOLS].map(addReason);
}

function summarize(name: string, out: any): string {
  if (out?.error) return `error: ${out.error.message ?? JSON.stringify(out.error)}`;
  if (name === "get_order") return `order ${out.id} ${out.status}, $${out.purchase_units?.[0]?.amount?.value}`;
  if (name === "find_customer_orders") return `${out.length} order${out.length === 1 ? "" : "s"}`;
  return JSON.stringify(out).slice(0, 160);
}

export type ToolOutcome = { text: string; isError: boolean; summary: string };

const REFUND_TOOLS = ["find_customer_orders", "get_order", "get_refund", "create_refund"];
const PAYOUT_TOOLS = ["lookup_contact", "send_payout"];

/** Least privilege: each agent only sees the tools its job needs. */
export const TOOLS_FOR: Record<string, string[] | undefined> = {
  support: REFUND_TOOLS,
  ops: PAYOUT_TOOLS,
};

/** The tools an agent's permissions cover (agents added by the owner, MCP clients). */
export function toolsForAgent(a: Pick<store.Agent, "can_refund" | "can_payout">): string[] {
  return [...(a.can_refund ? REFUND_TOOLS : []), ...(a.can_payout ? PAYOUT_TOOLS : [])];
}

export async function runTool(
  name: string, input: any, ticket: store.Ticket | undefined, emit?: (e: GuardEvent) => void, agentId?: string, source?: "inbox" | "api" | "mcp",
): Promise<ToolOutcome> {
  const { reason, requester_email, source_message, ...rest } = input ?? {};
  if (GUARDED_TOOLS.has(name)) {
    const text = await guardedCall(name, rest, { ticket, agentId, justification: String(reason ?? ""), emit, source });
    return { text, isError: false, summary: text.split(". ")[0] };
  }
  if (name === "find_customer_orders") {
    const rows = store.ordersFor(String(rest.email ?? "")).map((o) => ({
      order_id: o.order_id,
      capture_id: o.capture_id,
      invoice: o.invoice_id,
      paid_at: o.created_at,
      amount: o.amount,
      items: JSON.parse(o.items),
      tracking: o.tracking ? JSON.parse(o.tracking) : null,
    }));
    return { text: JSON.stringify(rows), isError: false, summary: summarize(name, rows) };
  }
  if (name === "lookup_contact") {
    const q = String(rest.name ?? "").toLowerCase();
    const found = store.activePolicy().policy.payouts.payees
      .filter((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.split(" ")[0].toLowerCase()))
      .map((p) => ({ name: p.name, paypal_email: p.email, role: p.role }));
    return { text: JSON.stringify(found), isError: false, summary: found.length ? found.map((f) => f.name).join(", ") : "no match" };
  }
  const out = await callToolkit(name, rest);
  return { text: JSON.stringify(out), isError: Boolean(out?.error), summary: summarize(name, out) };
}
