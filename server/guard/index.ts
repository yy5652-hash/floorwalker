import { currencyCheck, recordedCurrency, formatMoney } from "../paypal/currency.ts";
import { observeShadow } from "./observe.ts";
import { agentView, blockExplanations } from "../explanations.ts";
import { audit } from "../audit.ts";
import { config, paypalConfigured } from "../config.ts";
import { ctx as current } from "../context.ts";
import * as store from "../db.ts";
import { publish, type EventType } from "../events.ts";
import { getCapture, getOrder, orderIdFromCapture, sendPayout, usd } from "../paypal/api.ts";
import { callToolkit } from "../toolkit.ts";
import { reviewAction, ReviewSchema, type Review } from "./review.ts";
import {
  actionAmount, checkAgent, checkPayout, checkRefund, decide, PERIOD_DAYS,
  type Check, type Decision, type MoneyAction, type PayoutAction, type PayoutFacts, type RefundAction, type RefundFacts,
} from "./rules.ts";

/** External calls, kept in one object so tests can stand in for PayPal and Claude. */
export const deps = { getCapture, getOrder, sendPayout, callToolkit, reviewAction };

/** Tools that move money. Every call to one of these goes through Floorwalker. */
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
  /** Agents calling the API send one per action; a retry with the same key returns the first outcome. */
  idempotencyKey?: string;
  source?: "inbox" | "api" | "mcp";
};

// ruleFacts are the rule engine's inputs, kept with the ledger row so a draft policy can be replayed later.
type Prepared = { action: MoneyAction; currency: string; currencyChecks: Check[]; counterparty: string; facts: unknown; ruleFacts: RefundFacts | PayoutFacts | null; checks: Check[] };

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
  const currency = capture?.amount?.currency_code ?? "USD";
  const currencyChecks = currencyCheck("refund", currency, policy.currency);
  const checks = checkRefund(a, rf, policy, store.spendHistory());
  return { currency, currencyChecks, action: { ...a, amount: actionAmount(a, rf) }, counterparty: buyerEmail ?? "unknown", facts, ruleFacts: rf, checks };
}

/** Temporary allowances ("allow this payee for 7 days") join the payee list until they expire. */
function withGrants(policy: ReturnType<typeof store.activePolicy>["policy"]) {
  const grants = store.activeGrants();
  if (!grants.length) return policy;
  const p = structuredClone(policy);
  for (const g of grants) {
    if (p.payouts.payees.some((x) => x.email.toLowerCase() === g.counterparty)) continue;
    p.payouts.payees.push({
      name: g.counterparty, email: g.counterparty, role: `temporarily allowed by ${g.created_by} until ${g.expires_at.slice(0, 10)}, up to $${g.max_amount.toFixed(2)} more`,
      monthly_limit: g.base_paid + g.max_amount,
    });
  }
  return p;
}

async function preparePayout(a: PayoutAction, ctx: GuardContext, currency: string): Promise<Prepared> {
  const policy = withGrants(store.activePolicy().policy);
  const paid = store.paidToPayee(a.email, 30);
  const recent = store.paidToPayee(a.email, 1);
  const pf: PayoutFacts = { paidToPayee30d: paid.total, samePayeeSameAmount24h: recent.amounts.some((r) => Math.abs(r.amount - a.amount) < 0.005), requestedByOwner: ctx.ticket?.channel === "task" };
  const currencyChecks = currencyCheck("payout", currency, policy.currency);
  const checks: Check[] = Number.isFinite(a.amount) && a.amount > 0
    ? checkPayout(a, pf, policy, store.spendHistory())
    : [{ id: "amount", label: "Amount", outcome: "block" as const, detail: "The payout amount is missing or not positive." }];
  const payee = policy.payouts.payees.find((p) => p.email.toLowerCase() === a.email.toLowerCase());
  const facts = {
    payee_on_file: payee ?? "not on the payee list",
    payee_list: policy.payouts.payees.map((p) => `${p.name} <${p.email}> (${p.role})`),
    paid_to_this_address_last_30d: paid.total,
  };
  return { currency, currencyChecks, action: a, counterparty: a.email, facts, ruleFacts: Number.isFinite(a.amount) && a.amount > 0 ? pf : null, checks };
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

function agentMessage(decision: Decision, entry: number, amount: number, checks: Check[], paypalNote = "", currency = "USD"): string {
  const reasons = checks.filter((c) => c.outcome !== "pass").map((c) => `${c.label}: ${c.detail}`).join(" ");
  if (decision === "allow") return `Floorwalker approved and executed this. ${paypalNote}`.trim();
  if (decision === "hold") {
    return `Floorwalker held this ${formatMoney(amount, currency)} action for the owner's approval (request #${entry}). ${reasons} Do not retry it or try another way to move this money. Tell the sender a team member is reviewing it and will follow up within one business day.`;
  }
  return `Floorwalker blocked this action (request #${entry}). ${reasons} Do not retry it or try another way to move this money. Do not tell the sender which check stopped it; reply politely that a team member will follow up.`;
}

/**
 * PayPal-Request-Id for a ledger row: stable for the row (a retry can never pay twice) and unique across databases
 * (a fresh install's row #1 must not collide with another install's row #1 on the same PayPal account).
 */
// Keep the original PayPal idempotency namespace so retries of existing actions cannot pay twice.
const requestKey = (row: store.LedgerRow) => `allowance-${row.id}-${Date.parse(row.created_at).toString(36)}`;

/** Runs an approved ledger entry against PayPal, with the row's request key for idempotency. */
async function execute(id: number): Promise<{ ok: boolean; ref?: string; note: string; result?: unknown; error?: string }> {
  const row = store.ledgerEntry(id)!;
  store.db().prepare("UPDATE ledger SET execution_started_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  const params = JSON.parse(row.params);
  // An owner may approve a smaller amount than the agent asked for.
  if (row.approved_amount !== null) params.amount = row.approved_amount;
  if (row.tool === "create_refund") {
    const input: any = { capture_id: params.captureId, note_to_payer: params.note ?? `Refund from ${current().ws.name}` };
    if (params.amount !== undefined) input.amount = usd(params.amount, recordedCurrency(row));
    try {
      const res = await deps.callToolkit("create_refund", input, requestKey(row));
      if (!res || res.error || !res.id) {
        const msg = res?.error?.message ?? String(JSON.stringify(res)).slice(0, 300);
        return { ok: false, note: `PayPal refused the refund: ${msg}`, error: msg };
      }
      return { ok: true, ref: res.id, result: res, note: `PayPal refund ${res.id} is ${res.status} for ${formatMoney(Number(res.amount?.value ?? params.amount), recordedCurrency(row))}.` };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, note: `PayPal refused the refund: ${message}`, error: message };
    }
  }
  if (row.tool === "send_payout") {
    try {
      const res = await deps.sendPayout({ email: params.email, amount: usd(params.amount, recordedCurrency(row)), note: params.note || `Payment from ${current().ws.name}`, batchId: requestKey(row) });
      const batch = res.batch_header?.payout_batch_id;
      return { ok: true, ref: batch, result: res, note: `PayPal payout batch ${batch} is ${res.batch_header?.batch_status} for ${formatMoney(params.amount, recordedCurrency(row))} to ${params.email}.` };
    } catch (e: any) {
      return { ok: false, note: `PayPal refused the payout: ${e.message}`, error: e.message };
    }
  }
  return { ok: false, note: `Unknown tool ${row.tool}`, error: "unknown tool" };
}

/** The public shape of a ledger row (API responses, webhooks). */
export function actionView(row: store.LedgerRow) {
  const review = row.review ? JSON.parse(row.review) : null;
  return {
    id: `act_${row.id}`,
    object: "action",
    type: row.kind,
    status: row.status,
    decision: row.decision,
    amount: row.amount,
    approved_amount: row.approved_amount,
    currency: recordedCurrency(row),
    counterparty: row.counterparty,
    agent_id: row.agent_id,
    reason: row.justification,
    checks: JSON.parse(row.checks),
    review: review && { verdict: review.verdict, summary: review.summary, cited_rule: review.cited_rule ?? "", injection_detected: review.injection_detected },
    paypal_ref: row.paypal_ref,
    decline_reason: row.decline_reason,
    block_explanations: blockExplanations(row),
    source: row.source,
    created_at: row.created_at,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
    expires_at: row.expires_at,
  };
}

const EVENT_FOR: Partial<Record<store.LedgerStatus, EventType>> = {
  executed: "action.executed", awaiting_approval: "action.held", blocked: "action.blocked", approved: "action.approved", declined: "action.declined", failed: "action.failed",
};

function announce(id: number, type?: EventType) {
  const row = store.ledgerEntry(id)!;
  const t = type ?? EVENT_FOR[row.status];
  if (t) publish(t, actionView(row));
}

/** How long a held request waits for an answer before it is declined on its own. */
export const approvalTtlHours = () => store.setting<number>("approval_ttl_hours", 72);

export type GuardOutcome = { text: string; row: store.LedgerRow };

/** Intercepts one money-moving tool call: rules, AI review, then execute, hold or block. */
export async function guardedCall(tool: string, input: unknown, ctx: GuardContext): Promise<string> {
  return (await guard(tool, input, ctx)).text;
}

export async function guard(tool: string, input: unknown, ctx: GuardContext): Promise<GuardOutcome> {
  if (ctx.idempotencyKey && ctx.agentId) {
    const seen = store.ledgerByIdempotencyKey(ctx.agentId, ctx.idempotencyKey);
    if (seen) return { text: `Already handled as request #${seen.id} (${seen.status}).`, row: seen };
  }
  const prepared = tool === "create_refund" ? await prepareRefund(toRefundAction(input), ctx) : await preparePayout(toPayoutAction(input), ctx, (input as any)?.currency ?? store.activePolicy().policy.currency ?? "USD");
  const agent = ctx.agentId ? store.agent(ctx.agentId) : undefined;
  const amount = actionAmount(prepared.action);
  const spent = agent?.budget != null ? store.agentSpent(agent.id, new Date(Date.now() - PERIOD_DAYS[agent.budget_period ?? "week"] * 86_400_000).toISOString()) : 0;
  prepared.checks = [...checkAgent(agent, prepared.action, amount, spent), ...prepared.checks];
  const { id: policyId, policy, text: policyText } = store.activePolicy();
  let review: Review | null = null;
  let reviewError: string | undefined;
  if (config.ai.configured) {
    try {
      review = ReviewSchema.parse(await deps.reviewAction({
        action: prepared.action, tool, justification: ctx.justification, facts: prepared.facts, checks: prepared.checks, policy, policyText,
        source: ctx.ticket ? { from: `${ctx.ticket.from_name} <${ctx.ticket.from_email}>`, subject: ctx.ticket.subject, body: ctx.ticket.body, channel: ctx.ticket.channel } : null,
      }));
    } catch (e: any) {
      reviewError = e.message;
    }
  }
  const checks = [...prepared.currencyChecks, ...prepared.checks, ...reviewChecks(review, reviewError)];
  const decision = decide(checks);
  const id = store.recordProposal({
    ticketId: ctx.ticket?.id, agentId: ctx.agentId, tool, kind: prepared.action.kind, params: prepared.action, currency: prepared.currency, amount, counterparty: prepared.counterparty,
    justification: ctx.justification, decision, checks, review: review ?? undefined, policyId,
    facts: prepared.ruleFacts ? { rules: prepared.ruleFacts, review: prepared.facts, ...(agent?.status === "frozen" ? { freeze: agentView(agent).freeze_explanation } : {}) } : undefined,
    status: decision === "allow" ? "executing" : decision === "hold" ? "awaiting_approval" : "blocked",
    expiresAt: decision === "hold" ? new Date(Date.now() + approvalTtlHours() * 3_600_000).toISOString() : undefined,
    idempotencyKey: ctx.idempotencyKey, source: ctx.source ?? "inbox",
  });
  observeShadow(id, prepared.action, prepared.ruleFacts, prepared.checks.filter(c => c.id.startsWith("agent")));
  const as = agent ? { kind: "agent" as const, id: agent.id, name: agent.name } : undefined;
  audit(`action.${decision === "allow" ? "allowed" : decision === "hold" ? "held" : "blocked"}`, `act_${id}`, { tool, amount, counterparty: prepared.counterparty }, as);
  const event: GuardEvent = { type: "guard", ledgerId: id, tool, amount, counterparty: prepared.counterparty, decision, status: "blocked", checks, review };

  if (decision !== "allow") {
    event.status = decision === "hold" ? "awaiting_approval" : "blocked";
    ctx.emit?.(event);
    announce(id);
    return { text: agentMessage(decision, id, amount, checks, "", prepared.currency), row: store.ledgerEntry(id)! };
  }
  const run = await execute(id);
  store.updateLedger(id, { status: run.ok ? "executed" : "failed", paypalRef: run.ref, paypalResult: run.result, error: run.error });
  audit(run.ok ? "action.executed" : "action.failed", `act_${id}`, { paypal_ref: run.ref, error: run.error }, as);
  ctx.emit?.({ ...event, status: run.ok ? "executed" : "failed", paypalRef: run.ref, error: run.error });
  announce(id);
  return { text: run.ok ? agentMessage("allow", id, amount, checks, run.note) : `The action passed Floorwalker but PayPal rejected it: ${run.note}`, row: store.ledgerEntry(id)! };
}

export type ApproveOptions = {
  amount?: number;
  /** Also let the agent pay this payee on its own for this many days (payouts only), up to the approved amount each time. */
  allowPayeeDays?: number;
  note?: string;
};

/**
 * Owner approves a held action. The exact parameters frozen at proposal time are executed, optionally with a
 * smaller amount (a partial refund instead of the full one the agent asked for).
 */
export async function approve(id: number, by: string, opts: ApproveOptions | number = {}) {
  const { amount, allowPayeeDays, note } = typeof opts === "number" ? { amount: opts } as ApproveOptions : opts;
  const row = store.ledgerEntry(id);
  if (!row) throw new Error(`No request #${id}`);
  if (row.status === "awaiting_approval" && row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    expireRequest(row.id);
    throw new Error(`Request #${id} expired and was declined automatically.`);
  }
  if (row.status === "awaiting_approval" && row.agent_id && store.agent(row.agent_id)?.status === "frozen") {
    throw Object.assign(new Error("This agent is frozen; unfreeze it first."), { status: 409, code: "agent_frozen" });
  }
  if (row.decision === "block") throw new Error("Blocked actions cannot be approved here; do it yourself in PayPal if you really mean it.");
  if (amount !== undefined && !(amount > 0 && amount <= row.amount + 0.005)) throw new Error(`Approve between $0.01 and $${row.amount.toFixed(2)}.`);
  if (allowPayeeDays !== undefined && (row.kind !== "payout" || !(allowPayeeDays >= 1 && allowPayeeDays <= 90))) throw new Error("A temporary allowance is for payouts, from 1 to 90 days.");
  if (!paypalConfigured()) throw new Error("PayPal is not configured");
  if (!store.transition(id, "awaiting_approval", "executing")) throw new Error(`Request #${id} is ${row.status}, not awaiting approval`);
  if (amount !== undefined && Math.abs(amount - row.amount) > 0.005) store.setApprovedAmount(id, Math.round(amount * 100) / 100);
  const run = await execute(id);
  store.updateLedger(id, { status: run.ok ? "approved" : "failed", paypalRef: run.ref, paypalResult: run.result, error: run.error, decidedBy: by });
  audit(run.ok ? "action.approved" : "action.failed", `act_${id}`, { amount: amount ?? row.amount, paypal_ref: run.ref, error: run.error, note });
  if (run.ok && allowPayeeDays && row.counterparty) {
    const grant = store.addGrant({ counterparty: row.counterparty, maxAmount: amount ?? row.amount, days: allowPayeeDays, createdBy: by, ledgerId: id });
    audit("grant.created", `grant_${grant}`, { counterparty: row.counterparty, max_amount: amount ?? row.amount, days: allowPayeeDays });
  }
  announce(id);
  return { ...store.ledgerEntry(id)!, note: run.note };
}

export function declineRequest(id: number, by: string, reason?: string) {
  if (!store.transition(id, "awaiting_approval", "declined")) throw new Error(`Request #${id} is not awaiting approval`);
  store.updateLedger(id, { status: "declined", decidedBy: by });
  if (reason?.trim()) store.setDeclineReason(id, reason.trim().slice(0, 500));
  audit("action.declined", `act_${id}`, reason?.trim() ? { reason: reason.trim().slice(0, 500) } : undefined);
  announce(id);
  return store.ledgerEntry(id)!;
}

/** Same expiry outcome whether noticed by an approver or the scheduled sweep. */
function expireRequest(id: number): boolean {
  if (!store.transition(id, "awaiting_approval", "declined")) return false;
  store.updateLedger(id, { status: "declined", decidedBy: "Floorwalker (expired)" });
  store.setDeclineReason(id, `No one answered within ${approvalTtlHours()} hours, so it was declined automatically.`);
  audit("action.expired", `act_${id}`);
  announce(id, "action.expired");
  return true;
}

/** Declines held requests nobody answered in time (fail closed: silence is a no). */
export function expireOverdue(): number {
  return store.overdueRequests().filter((r) => expireRequest(r.id)).length;
}
