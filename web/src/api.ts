export type Decision = "allow" | "hold" | "block";
export type Check = { id: string; label: string; outcome: "pass" | "hold" | "block"; detail: string };
export type Review = {
  verdict: "approve" | "escalate" | "reject";
  matches_request: boolean;
  injection_detected: boolean;
  concerns: { issue: string; evidence: string }[];
  summary: string;
  cited_rule: string;
};
export type Ticket = {
  id: string; channel: "email" | "task"; from_name: string; from_email: string;
  subject: string; body: string; received_at: string; status: "open" | "handled"; reply: string | null;
};
export type LedgerEntry = {
  id: number; ticket_id: string | null; agent_id: string | null;
  tool: "create_refund" | "send_payout"; kind: "refund" | "payout" | "invoice";
  params: Record<string, unknown>; amount: number; approved_amount: number | null;
  counterparty: string | null; justification: string | null; decision: Decision;
  checks: Check[]; review: Review | null;
  status: "executed" | "awaiting_approval" | "executing" | "approved" | "declined" | "blocked" | "failed";
  paypal_ref: string | null; paypal_result: unknown; error: string | null;
  created_at: string; decided_at: string | null; decided_by: string | null; policy_id: number | null;
};
export type Budget = { amount: number; period: "day" | "week" | "month" };
export type Policy = {
  refunds: { auto_approve_up_to: number; hard_limit: number; budget: Budget; max_order_age_days: number; max_refunds_per_customer_30d: number; requester_must_be_buyer: boolean };
  payouts: { auto_approve_up_to: number; hard_limit: number; budget: Budget; payees: { name: string; email: string; role: string; monthly_limit: number }[]; unknown_payee: "block" | "ask"; only_owner_requests: boolean };
  invoices: { auto_approve_up_to: number; max_discount_percent: number }; notes: string[];
};
export type Metrics = {
  moved: number; movedCount: number; waiting: number; waitingCount: number; stopped: number; stoppedCount: number;
  automationRate: number | null; medianApprovalMinutes: number | null;
  funnel: { auto: number; approved: number; declined: number; waiting: number; blocked: number };
};
export type Agent = {
  id: string; name: string; role: string; can_refund: boolean | number; can_payout: boolean | number;
  status: "active" | "frozen"; budget: Budget | null; spent: number; metrics: Metrics; last: string | null;
};
export type PolicyVersion = { id: number; text: string; policy: Policy; created_at: string };
export type State = {
  configured: { paypal: boolean; ai: boolean; provider: "anthropic" | "gemini" | null; agentModel: string; reviewModel: string };
  policy: { id: number; text: string; policy: Policy }; tickets: Ticket[]; orders: unknown[]; ledger: LedgerEntry[];
  metrics: Metrics; agents: Agent[];
};
export type Suggestion = { kind: "conflict" | "gap" | "unclear"; text: string };
export type Simulation = {
  rows: { id: number; tool: string; amount: number; counterparty: string | null; at: string; before: Decision; after: Decision; why: string }[];
  changed: number; counts: Record<"before" | "after", Record<Decision, number>>;
};
export type GuardEvent = {
  type: "guard"; ledgerId: number; tool: string; amount: number; counterparty: string;
  decision: Decision; status: LedgerEntry["status"]; checks: Check[]; review: Review | null; paypalRef?: string; error?: string;
};
export type AgentEvent =
  | { type: "start"; ticketId: string; agentId?: string }
  | { type: "note"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; guarded: boolean }
  | { type: "tool_result"; id: string; name: string; summary: string; isError: boolean }
  | GuardEvent | { type: "reply"; text: string } | { type: "error"; message: string } | { type: "done"; ticketId: string };

async function readJSON<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => { throw new Error("Couldn't read the server response. Please try again."); });
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data as T;
}
export const getState = (signal?: AbortSignal) => fetch("/api/state", { signal }).then(readJSON<State>);
export const getVersions = () => fetch("/api/policy/versions").then(readJSON<PolicyVersion[]>);
export async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  return readJSON<T>(await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
}
/** POST and read NDJSON, including a final event without a trailing newline. */
export async function streamEvents(path: string, onEvent: (e: AgentEvent) => void) {
  const r = await fetch(path, { method: "POST" });
  if (!r.ok) { await readJSON(r); return; }
  if (!r.body) throw new Error("The agent stream is unavailable. Please try again.");
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line) as AgentEvent);
      }
      if (done) { if (buffer.trim()) onEvent(JSON.parse(buffer) as AgentEvent); break; }
    }
  } finally { reader.releaseLock(); }
}
export const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
export const errorMessage = (e: unknown) => e instanceof Error ? e.message : "Something went wrong. Please try again.";
export const amountOf = (e: LedgerEntry) => e.approved_amount ?? e.amount;

// People are shown by name: payees from the rules, buyers from the shop's orders. Refreshed with every state load.
let directory = new Map<string, string>();
export function setDirectory(s: State) {
  directory = new Map([
    ...s.orders.map((o: any) => [String(o.customer_email).toLowerCase(), String(o.customer_name)] as [string, string]),
    ...s.policy.policy.payouts.payees.map(p => [p.email.toLowerCase(), p.name] as [string, string]),
  ]);
}
export const personName = (email: string | null) => (email ? directory.get(email.toLowerCase()) ?? email : "the buyer");
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export const agentName = (s: State, id: string | null) => s.agents.find(a => a.id === id)?.name ?? "Agent";
export const relativeTime = (at: string | null) => {
  if (!at) return "No activity yet";
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
};
export const why = (e: LedgerEntry) => (e.checks.find(c => c.outcome === "block") ?? e.checks.find(c => c.outcome === "hold"))?.detail ?? e.review?.summary ?? "All checks passed";
export const STATUS_LABEL: Record<LedgerEntry["status"], string> = {
  executed: "Done automatically", approved: "Approved by you", awaiting_approval: "Waiting for you", executing: "Processing in PayPal", declined: "Declined by you", blocked: "Blocked before PayPal", failed: "Payment failed",
};
export const statusTone = (status: LedgerEntry["status"]) => ["blocked", "declined", "failed"].includes(status) ? "block" : ["awaiting_approval", "executing"].includes(status) ? "hold" : "allow";
export const DECISION_LABEL = { allow: "Auto-approved", hold: "Waiting", block: "Blocked" } as const;
export type PageProps = { state: State; refresh: () => Promise<void>; notify: (message: string) => void };
