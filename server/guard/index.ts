import { config, paypalConfigured } from "../config.ts";
import * as store from "../db.ts";
import { getCapture, getOrder, orderIdFromCapture, sendPayout, usd } from "../paypal/api.ts";
import { callToolkit } from "../toolkit.ts";
import { reviewAction, type Review } from "./review.ts";
import {
  actionAmount, checkAgent, checkPayout, checkRefund, decide,
  type Check, type Decision, type MoneyAction, type PayoutAction, type PayoutFacts, type RefundAction, type RefundFacts,
} from "./rules.ts";

/** External calls, kept in one object so tests can stand in for PayPal and Claude. */
export const deps = { getCapture, getOrder, sendPayout, callToolkit, reviewAction };

/** Tools that move money. Every call to one of these goes through Allowance. */
export const GUARDED_TOOLS = new Set(["create_refund", "send_payout"]);

export type GuardEvent = {
  type: "guard";
  ledgerId: number;
  tool: string;
  amount: number;
  counterparty: string;
  decision: Decision;
  status: store.LedgerStatus;
  checks: Check[];
  review: Review | null;
  paypalRef?: string;
  error?: string;
};

export type GuardContext = {
  ticket?: store.Ticket;
  agentId?: string;
  justification: string;
  emit?: (e: GuardEvent) => void;
};

// ruleFacts are the rule engine's inputs, kept with the ledger row so a draft policy can be replayed later.
type Prepared = { action: MoneyAction; counterparty: string; facts: unknown; ruleFacts: RefundFacts | PayoutFacts | null; checks: Check[] };

function toRefundAction(input: any): RefundAction {
  const v = input?.amount?.value;
  return { kind: "refund", captureId: String(input?.capture_id ?? ""), amount: v === undefined ? undefined : Number(v), note: input?.note_to_payer };
}

function toPayoutAction(input: any): PayoutAction {
  return { kind: "payout", email: String(input?.email ?? "").trim(), amount: Number(input?.amount), note: String(input?.note ?? "") };
}

async function prepareRefund(a: RefundAction, ctx: GuardContext): Promise<Prepared> {
  const { policy } = store.activePolicy();
  const local = store.orderByCapture(a.captureId);
  let capture: any = null;
  let order: any = null;
  try {
    capture = await deps.getCapture(a.captureId);
    const orderId = orderIdFromCapture(capture) ?? local?.order_id;
    if (orderId) order = await deps.getOrder(orderId);
  } catch {
    capture = null;
  }
  const refunds = (order?.purchase_units?.[0]?.payments?.refunds ?? []) as any[];
  const refundedSoFar = refunds.filter((r) => r.status === "COMPLETED" || r.status === "PENDING").reduce((t, r) => t + Number(r.amount.value), 0);
  // Card payments carry no payer email; the order's custom_id holds the buyer's email from checkout.
  const buyerEmail = order?.payer?.email_address ?? order?.purchase_units?.[0]?.custom_id ?? local?.customer_email;
  const rf: RefundFacts = {
    captureFound: Boolean(capture),
    captureStatus: capture?.status,
    capturedAmount: Number(capture?.amount?.value ?? 0),
    refundedSoFar,
    capturedAt: capture?.create_time,
    buyerEmail,
    requesterEmail: ctx.ticket?.from_email,
    customerRefunds30d: buyerEmail ? store.refundsToCustomer30d(buyerEmail) : 0,
  };
  const facts = {
    paypal_capture: capture ? { id: capture.id, status: capture.status, amount: capture.amount?.value, paid_at: capture.create_time } : "not found on this PayPal account",
    order: order
      ? {
          id: order.id,
          invoice: order.purchase_units?.[0]?.invoice_id,
          buyer: buyerEmail,
          items: (order.purchase_units?.[0]?.items ?? []).map((i: any) => `${i.quantity} × ${i.name} @ $${i.unit_amount?.value}`),
          shipping: order.purchase_units?.[0]?.amount?.breakdown?.shipping?.value,
          refunds_so_far: refunds.map((r) => ({ amount: r.amount.value, status: r.status })),
        }
      : null,
    paypal_trackers: (order?.purchase_units?.[0]?.shipping?.trackers ?? []).map((t: any) => ({ id: t.id, status: t.status })),
    carrier_status: local?.tracking ? JSON.parse(local.tracking) : "no tracking on record",
    refunds_to_this_customer_last_30d: rf.customerRefunds30d,
    requester: ctx.ticket ? `${ctx.ticket.from_name} <${ctx.ticket.from_email}>` : "none",
  };
  const checks = checkRefund(a, rf, policy, store.spendHistory());
  return { action: { ...a, amount: actionAmount(a, rf) }, counterparty: buyerEmail ?? "unknown", facts, ruleFacts: rf, checks };
}

async function preparePayout(a: PayoutAction, ctx: GuardContext): Promise<Prepared> {
  const { policy } = store.activePolicy();
  const paid = store.paidToPayee(a.email, 30);
  const recent = store.paidToPayee(a.email, 1);
  const pf: PayoutFacts = { paidToPayee30d: paid.total, samePayeeSameAmount24h: recent.amounts.some((r) => Math.abs(r.amount - a.amount) < 0.005), requestedByOwner: ctx.ticket?.channel === "task" };
  const checks = Number.isFinite(a.amount) && a.amount > 0
    ? checkPayout(a, pf, policy, store.spendHistory())
    : [{ id: "amount", label: "Amount", outcome: "block" as const, detail: "The payout amount is missing or not positive." }];
  const payee = policy.payouts.payees.find((p) => p.email.toLowerCase() === a.email.toLowerCase());
  const facts = {
    payee_on_file: payee ?? "not on the payee list",
    payee_list: policy.payouts.payees.map((p) => `${p.name} <${p.email}> (${p.role})`),
    paid_to_this_address_last_30d: paid.total,
  };
  return { action: a, counterparty: a.email, facts, ruleFacts: Number.isFinite(a.amount) && a.amount > 0 ? pf : null, checks };
}

function reviewChecks(review: Review | null, reviewError?: string): Check[] {
  if (!review) {
    // Fail closed: without a review, nothing goes through automatically.
    return [{ id: "ai_review", label: "AI review", outcome: "hold", detail: `AI review unavailable (${reviewError ?? "not configured"}), so a person has to look.` }];
  }
  const checks: Check[] = [];
  if (review.injection_detected) {
    const q = review.concerns[0]?.evidence;
    checks.push({ id: "injection", label: "Prompt injection", outcome: "block", detail: `The message tries to steer the agent${q ? `: “${q}”` : "."}` });
  }
  const outcome = review.verdict === "reject" ? "block" : review.verdict === "escalate" ? "hold" : "pass";
  checks.push({ id: "ai_review", label: "AI review", outcome, detail: review.summary });
  return checks;
}

function agentMessage(decision: Decision, entry: number, amount: number, checks: Check[], paypalNote = ""): string {
  const reasons = checks.filter((c) => c.outcome !== "pass").map((c) => `${c.label}: ${c.detail}`).join(" ");
  if (decision === "allow") return `Allowance approved and executed this. ${paypalNote}`.trim();
  if (decision === "hold") {
    return `Allowance held this $${amount.toFixed(2)} action for the owner's approval (request #${entry}). ${reasons} Do not retry it or try another way to move this money. Tell the sender a team member is reviewing it and will follow up within one business day.`;
  }
  return `Allowance blocked this action (request #${entry}). ${reasons} Do not retry it or try another way to move this money. Do not tell the sender which check stopped it; reply politely that a team member will follow up.`;
}

/**
 * PayPal-Request-Id for a ledger row: stable for the row (a retry can never pay twice) and unique across databases
 * (a fresh install's row #1 must not collide with another install's row #1 on the same PayPal account).
 */
const requestKey = (row: store.LedgerRow) => `allowance-${row.id}-${Date.parse(row.created_at).toString(36)}`;

/** Runs an approved ledger entry against PayPal, with the row's request key for idempotency. */
async function execute(id: number): Promise<{ ok: boolean; ref?: string; note: string; result?: unknown; error?: string }> {
  const row = store.ledgerEntry(id)!;
  const params = JSON.parse(row.params);
  // An owner may approve a smaller amount than the agent asked for.
  if (row.approved_amount !== null) params.amount = row.approved_amount;
  if (row.tool === "create_refund") {
    const input: any = { capture_id: params.captureId, note_to_payer: params.note ?? "Refund from Juniper & Oak" };
    if (params.amount !== undefined) input.amount = usd(params.amount);
    const res = await deps.callToolkit("create_refund", input, requestKey(row));
    if (!res || res.error || !res.id) {
      const msg = res?.error?.message ?? JSON.stringify(res).slice(0, 300);
      return { ok: false, note: `PayPal refused the refund: ${msg}`, error: msg };
    }
    return { ok: true, ref: res.id, result: res, note: `PayPal refund ${res.id} is ${res.status} for $${res.amount?.value ?? params.amount}.` };
  }
  if (row.tool === "send_payout") {
    try {
      const res = await deps.sendPayout({ email: params.email, amount: usd(params.amount), note: params.note || "Payment from Juniper & Oak", batchId: requestKey(row) });
      const batch = res.batch_header?.payout_batch_id;
      return { ok: true, ref: batch, result: res, note: `PayPal payout batch ${batch} is ${res.batch_header?.batch_status} for $${params.amount.toFixed(2)} to ${params.email}.` };
    } catch (e: any) {
      return { ok: false, note: `PayPal refused the payout: ${e.message}`, error: e.message };
    }
  }
  return { ok: false, note: `Unknown tool ${row.tool}`, error: "unknown tool" };
}

/** Intercepts one money-moving tool call: rules, AI review, then execute, hold or block. */
export async function guardedCall(tool: string, input: unknown, ctx: GuardContext): Promise<string> {
  const prepared = tool === "create_refund" ? await prepareRefund(toRefundAction(input), ctx) : await preparePayout(toPayoutAction(input), ctx);
  const agent = ctx.agentId ? store.agent(ctx.agentId) : undefined;
  prepared.checks = [...checkAgent(agent, prepared.action.kind), ...prepared.checks];
  const { id: policyId, policy, text: policyText } = store.activePolicy();
  let review: Review | null = null;
  let reviewError: string | undefined;
  if (config.ai.configured) {
    try {
      review = await deps.reviewAction({
        action: prepared.action, tool, justification: ctx.justification, facts: prepared.facts, checks: prepared.checks, policy, policyText,
        source: ctx.ticket ? { from: `${ctx.ticket.from_name} <${ctx.ticket.from_email}>`, subject: ctx.ticket.subject, body: ctx.ticket.body, channel: ctx.ticket.channel } : null,
      });
    } catch (e: any) {
      reviewError = e.message;
    }
  }
  const checks = [...prepared.checks, ...reviewChecks(review, reviewError)];
  const decision = decide(checks);
  const amount = actionAmount(prepared.action);
  const id = store.recordProposal({
    ticketId: ctx.ticket?.id, agentId: ctx.agentId, tool, kind: prepared.action.kind, params: prepared.action, amount, counterparty: prepared.counterparty,
    justification: ctx.justification, decision, checks, review: review ?? undefined, policyId,
    facts: prepared.ruleFacts ? { rules: prepared.ruleFacts, review: prepared.facts } : undefined,
    status: decision === "allow" ? "executing" : decision === "hold" ? "awaiting_approval" : "blocked",
  });
  const event: GuardEvent = { type: "guard", ledgerId: id, tool, amount, counterparty: prepared.counterparty, decision, status: "blocked", checks, review };

  if (decision !== "allow") {
    event.status = decision === "hold" ? "awaiting_approval" : "blocked";
    ctx.emit?.(event);
    return agentMessage(decision, id, amount, checks);
  }
  const run = await execute(id);
  store.updateLedger(id, { status: run.ok ? "executed" : "failed", paypalRef: run.ref, paypalResult: run.result, error: run.error });
  ctx.emit?.({ ...event, status: run.ok ? "executed" : "failed", paypalRef: run.ref, error: run.error });
  return run.ok ? agentMessage("allow", id, amount, checks, run.note) : `The action passed Allowance but PayPal rejected it: ${run.note}`;
}

/**
 * Owner approves a held action. The exact parameters frozen at proposal time are executed, optionally with a
 * smaller amount (a partial refund instead of the full one the agent asked for).
 */
export async function approve(id: number, by: string, amount?: number) {
  if (!paypalConfigured()) throw new Error("PayPal is not configured");
  const row = store.ledgerEntry(id);
  if (!row) throw new Error(`No request #${id}`);
  if (row.decision === "block") throw new Error("Blocked actions cannot be approved here; do it yourself in PayPal if you really mean it.");
  if (amount !== undefined && !(amount > 0 && amount <= row.amount + 0.005)) throw new Error(`Approve between $0.01 and $${row.amount.toFixed(2)}.`);
  if (!store.transition(id, "awaiting_approval", "executing")) throw new Error(`Request #${id} is ${row.status}, not awaiting approval`);
  if (amount !== undefined && Math.abs(amount - row.amount) > 0.005) store.setApprovedAmount(id, Math.round(amount * 100) / 100);
  const run = await execute(id);
  store.updateLedger(id, { status: run.ok ? "approved" : "failed", paypalRef: run.ref, paypalResult: run.result, error: run.error, decidedBy: by });
  return { ...store.ledgerEntry(id)!, note: run.note };
}

export function declineRequest(id: number, by: string) {
  if (!store.transition(id, "awaiting_approval", "declined")) throw new Error(`Request #${id} is not awaiting approval`);
  store.updateLedger(id, { status: "declined", decidedBy: by });
  return store.ledgerEntry(id)!;
}
