export type Outcome = "pass" | "hold" | "block";
export type Check = { id: string; label: string; outcome: Outcome; detail: string };
export type Review = {
  verdict: "approve" | "escalate" | "reject";
  matches_request: boolean;
  injection_detected: boolean;
  concerns: { issue: string; evidence: string }[];
  summary: string;
};

export type Ticket = {
  id: string;
  channel: "email" | "task";
  from_name: string;
  from_email: string;
  subject: string;
  body: string;
  received_at: string;
  status: "open" | "handled";
  reply: string | null;
};

export type LedgerEntry = {
  id: number;
  ticket_id: string | null;
  tool: string;
  kind: "refund" | "payout" | "invoice";
  params: any;
  amount: number;
  counterparty: string | null;
  justification: string | null;
  decision: "allow" | "hold" | "block";
  checks: Check[];
  review: Review | null;
  status: "executed" | "awaiting_approval" | "executing" | "approved" | "declined" | "blocked" | "failed";
  paypal_ref: string | null;
  paypal_result: any;
  error: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type Policy = {
  refunds: { auto_approve_up_to: number; hard_limit: number; budget: { amount: number; period: string }; max_order_age_days: number; max_refunds_per_customer_30d: number; requester_must_be_buyer: boolean };
  payouts: { auto_approve_up_to: number; hard_limit: number; budget: { amount: number; period: string }; payees: { name: string; email: string; role: string; monthly_limit: number }[]; unknown_payee: "block" | "ask" };
  invoices: { auto_approve_up_to: number; max_discount_percent: number };
  notes: string[];
};

export type State = {
  configured: { paypal: boolean; ai: boolean; provider: "anthropic" | "gemini" | null; agentModel: string; reviewModel: string };
  policy: { id: number; text: string; policy: Policy };
  tickets: Ticket[];
  orders: any[];
  ledger: LedgerEntry[];
  stats: { moved: number; autoApproved: number; awaiting: number; blocked: number; stopped: number };
};

export type GuardEvent = {
  type: "guard";
  ledgerId: number;
  tool: string;
  amount: number;
  counterparty: string;
  decision: "allow" | "hold" | "block";
  status: LedgerEntry["status"];
  checks: Check[];
  review: Review | null;
  paypalRef?: string;
  error?: string;
};

export type AgentEvent =
  | { type: "start"; ticketId: string }
  | { type: "note"; text: string }
  | { type: "tool_call"; id: string; name: string; input: any; guarded: boolean }
  | { type: "tool_result"; id: string; name: string; summary: string; isError: boolean }
  | GuardEvent
  | { type: "reply"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; ticketId: string };

export async function getState(): Promise<State> {
  const r = await fetch("/api/state");
  return r.json();
}

export async function post<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data;
}

/** POSTs and reads newline-delimited JSON events until the stream ends. */
export async function streamEvents(path: string, onEvent: (e: AgentEvent) => void) {
  const r = await fetch(path, { method: "POST" });
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error ?? r.statusText);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

export const money = (n: number) => `$${n.toFixed(2)}`;

export const modelName = (c: State["configured"]) => (c.provider === "gemini" ? "Gemini" : "Claude");

export function describe(e: { tool: string; amount: number; counterparty: string | null; params?: any }): string {
  if (e.tool === "create_refund") return `Refund ${money(e.amount)} to ${e.counterparty}`;
  if (e.tool === "send_payout") return `Pay ${money(e.amount)} to ${e.counterparty}`;
  return `${e.tool} ${money(e.amount)}`;
}

export const DECISION_LABEL = { allow: "Approved", hold: "Needs you", block: "Blocked" } as const;
export const STATUS_LABEL: Record<LedgerEntry["status"], string> = {
  executed: "Done",
  awaiting_approval: "Waiting for you",
  executing: "Running",
  approved: "Approved by you",
  declined: "Declined by you",
  blocked: "Blocked",
  failed: "PayPal error",
};
