import { PayPalAgentToolkit } from "@paypal/agent-toolkit/bedrock";
import { config } from "./config.ts";
import type { ToolDef } from "./llm.ts";

// The subset of PayPal Agent Toolkit tools the support agent gets.
// create_refund moves money, so Allowance intercepts it; the rest are reads.
const ACTIONS = {
  orders: { get: true },
  payments: { createRefund: true, getRefunds: true },
  shipment: { get: true },
};

export const TOOLKIT_TOOLS = ["get_order", "create_refund", "get_refund", "get_shipment_tracking"] as const;

/**
 * A fresh toolkit per call: the toolkit caches its OAuth token for the life of the
 * instance, and request_id becomes the PayPal-Request-Id header, which makes the
 * money-moving call idempotent per ledger entry.
 */
function toolkit(requestId?: string) {
  return new PayPalAgentToolkit({
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    configuration: { actions: ACTIONS, context: { sandbox: true, ...(requestId ? { request_id: requestId } : {}) } },
  });
}

let defs: ToolDef[] | null = null;

/** Toolkit tool definitions in the shape the model APIs take. */
export function toolkitToolDefs(): ToolDef[] {
  defs ??= toolkit()
    .getTools()
    .filter((t) => (TOOLKIT_TOOLS as readonly string[]).includes(t.toolSpec.name))
    .map((t) => ({ name: t.toolSpec.name, description: t.toolSpec.description, input_schema: t.toolSpec.inputSchema.json }));
  return defs;
}

/** Runs a toolkit tool and returns PayPal's parsed JSON (or an {error} object). */
export async function callToolkit(name: string, input: unknown, requestId?: string): Promise<any> {
  const res = await toolkit(requestId).handleToolCall({ toolUseId: requestId ?? name, name, input });
  let out: any = res.content[0]?.text ?? "null";
  // run() stringifies the PayPal response and handleToolCall stringifies it again.
  while (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      break;
    }
  }
  return out;
}
