import type { Policy } from "./policy.ts";

export type Outcome = "pass" | "hold" | "block";
export type Decision = "allow" | "hold" | "block";
export type Check = { id: string; label: string; outcome: Outcome; detail: string };

export type RefundAction = { kind: "refund"; captureId: string; amount?: number; note?: string };
export type PayoutAction = { kind: "payout"; email: string; amount: number; note: string };
export type InvoiceAction = { kind: "invoice"; recipientEmail: string; total: number; discountPercent: number };
export type MoneyAction = RefundAction | PayoutAction | InvoiceAction;

/** Ground truth fetched by Allowance itself (from PayPal and its own ledger), never taken from the agent. */
export type RefundFacts = {
  captureFound: boolean;
  captureStatus?: string;
  capturedAmount: number;
  refundedSoFar: number;
  capturedAt?: string;
  buyerEmail?: string;
  requesterEmail?: string;
  customerRefunds30d: number;
};
export type PayoutFacts = { paidToPayee30d: number; samePayeeSameAmount24h: boolean; requestedByOwner: boolean };

/** Money the agent has already moved, from the ledger. */
export type Spend = { kind: MoneyAction["kind"]; amount: number; at: string };

export const PERIOD_DAYS = { day: 1, week: 7, month: 30 } as const;
const money = (n: number) => `$${n.toFixed(2)}`;

function spentInPeriod(history: Spend[], kind: Spend["kind"], days: number, now: Date): number {
  const since = now.getTime() - days * 86_400_000;
  return history.filter((s) => s.kind === kind && Date.parse(s.at) >= since).reduce((t, s) => t + s.amount, 0);
}

function limitChecks(
  kind: "refunds" | "payouts",
  amount: number,
  limits: Policy["refunds"] | Policy["payouts"],
  history: Spend[],
  now: Date,
): Check[] {
  const checks: Check[] = [];
  if (amount > limits.hard_limit) {
    checks.push({ id: "hard_limit", label: "Hard limit", outcome: "block", detail: `${money(amount)} is above the ${money(limits.hard_limit)} the agent may ever move in one ${kind === "refunds" ? "refund" : "payment"}.` });
  } else if (amount > limits.auto_approve_up_to) {
    checks.push({ id: "auto_limit", label: "Auto-approve limit", outcome: "hold", detail: `${money(amount)} is above the ${money(limits.auto_approve_up_to)} the agent may do on its own.` });
  } else {
    checks.push({ id: "auto_limit", label: "Auto-approve limit", outcome: "pass", detail: `${money(amount)} is within the ${money(limits.auto_approve_up_to)} auto-approve limit.` });
  }
  const spent = spentInPeriod(history, kind === "refunds" ? "refund" : "payout", PERIOD_DAYS[limits.budget.period], now);
  const left = Math.max(0, limits.budget.amount - spent);
  checks.push(
    amount > left
      ? { id: "budget", label: `${cap(limits.budget.period)}ly allowance`, outcome: "hold", detail: `Only ${money(left)} of the ${money(limits.budget.amount)} ${limits.budget.period}ly allowance is left.` }
      : { id: "budget", label: `${cap(limits.budget.period)}ly allowance`, outcome: "pass", detail: `${money(left - amount)} of the ${money(limits.budget.amount)} ${limits.budget.period}ly allowance left after this.` },
  );
  return checks;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function checkRefund(a: RefundAction, f: RefundFacts, policy: Policy, history: Spend[], now = new Date()): Check[] {
  const p = policy.refunds;
  if (!f.captureFound) {
    return [{ id: "capture", label: "Payment exists", outcome: "block", detail: `PayPal has no capture ${a.captureId} on this account.` }];
  }
  const checks: Check[] = [];
  const refundable = Math.max(0, f.capturedAmount - f.refundedSoFar);
  const amount = a.amount ?? refundable;
  const refundableStatus = f.captureStatus === "COMPLETED" || f.captureStatus === "PARTIALLY_REFUNDED";
  checks.push(
    !refundableStatus
      ? { id: "capture", label: "Payment exists", outcome: "block", detail: `Capture is ${f.captureStatus}, so there is nothing to refund.` }
      : amount > refundable + 0.005
        ? { id: "capture", label: "Refundable balance", outcome: "block", detail: `${money(amount)} is more than the ${money(refundable)} still refundable on this payment.` }
        : { id: "capture", label: "Refundable balance", outcome: "pass", detail: `${money(amount)} of ${money(refundable)} refundable (captured ${money(f.capturedAmount)}).` },
  );
  if (p.requester_must_be_buyer) {
    const same = f.buyerEmail && f.requesterEmail && f.buyerEmail.toLowerCase() === f.requesterEmail.toLowerCase();
    checks.push(
      same
        ? { id: "buyer", label: "Requester is the buyer", outcome: "pass", detail: `${f.requesterEmail} paid for this order.` }
        : { id: "buyer", label: "Requester is the buyer", outcome: "block", detail: `The request came from ${f.requesterEmail ?? "an unknown sender"}, but ${f.buyerEmail ?? "someone else"} paid for this order.` },
    );
  }
  if (f.capturedAt) {
    const age = Math.floor((now.getTime() - Date.parse(f.capturedAt)) / 86_400_000);
    checks.push(
      age > p.max_order_age_days
        ? { id: "age", label: "Order age", outcome: "hold", detail: `Paid ${age} days ago; refunds after ${p.max_order_age_days} days need approval.` }
        : { id: "age", label: "Order age", outcome: "pass", detail: `Paid ${age} day${age === 1 ? "" : "s"} ago.` },
    );
  }
  checks.push(
    f.customerRefunds30d >= p.max_refunds_per_customer_30d
      ? { id: "frequency", label: "Refunds per customer", outcome: "hold", detail: `This customer already had ${f.customerRefunds30d} refund${f.customerRefunds30d === 1 ? "" : "s"} in the last 30 days.` }
      : { id: "frequency", label: "Refunds per customer", outcome: "pass", detail: "No other refund to this customer in the last 30 days." },
  );
  checks.push(...limitChecks("refunds", amount, p, history, now));
  return checks;
}

export function checkPayout(a: PayoutAction, f: PayoutFacts, policy: Policy, history: Spend[], now = new Date()): Check[] {
  const p = policy.payouts;
  const checks: Check[] = [];
  const payee = p.payees.find((x) => x.email.toLowerCase() === a.email.toLowerCase());
  if (!payee) {
    checks.push({
      id: "payee",
      label: "Known payee",
      outcome: p.unknown_payee === "block" ? "block" : "hold",
      detail: `${a.email} is not on the payee list. ${p.unknown_payee === "block" ? "Payments to new addresses are blocked; add the payee yourself first." : "New payees need approval."}`,
    });
  } else {
    checks.push({ id: "payee", label: "Known payee", outcome: "pass", detail: `${payee.name} (${payee.role}) is on the payee list.` });
    const after = f.paidToPayee30d + a.amount;
    checks.push(
      after > payee.monthly_limit
        ? { id: "payee_limit", label: "Payee monthly limit", outcome: "hold", detail: `${payee.name} would get ${money(after)} in 30 days; the limit is ${money(payee.monthly_limit)}.` }
        : { id: "payee_limit", label: "Payee monthly limit", outcome: "pass", detail: `${money(after)} of ${payee.name}'s ${money(payee.monthly_limit)} monthly limit.` },
    );
  }
  if (p.only_owner_requests) {
    checks.push(
      f.requestedByOwner
        ? { id: "requested_by", label: "Requested by", outcome: "pass", detail: "The owner asked for this payment." }
        : { id: "requested_by", label: "Requested by", outcome: "hold", detail: "An incoming message asked for this payment, not the owner." },
    );
  }
  if (f.samePayeeSameAmount24h) {
    checks.push({ id: "duplicate", label: "Duplicate payment", outcome: "hold", detail: `${money(a.amount)} already went to ${a.email} in the last 24 hours.` });
  }
  checks.push(...limitChecks("payouts", a.amount, p, history, now));
  return checks;
}

export function checkInvoice(a: InvoiceAction, policy: Policy): Check[] {
  const p = policy.invoices;
  return [
    a.discountPercent > p.max_discount_percent
      ? { id: "discount", label: "Discount", outcome: "hold", detail: `${a.discountPercent}% discount is above the ${p.max_discount_percent}% the agent may give.` }
      : { id: "discount", label: "Discount", outcome: "pass", detail: `${a.discountPercent}% discount.` },
    a.total > p.auto_approve_up_to
      ? { id: "auto_limit", label: "Auto-approve limit", outcome: "hold", detail: `Invoice of ${money(a.total)} is above ${money(p.auto_approve_up_to)}.` }
      : { id: "auto_limit", label: "Auto-approve limit", outcome: "pass", detail: `Invoice of ${money(a.total)}.` },
  ];
}

export type AgentInfo = {
  name: string;
  status: "active" | "frozen";
  can_refund: number;
  can_payout: number;
  max_per_action?: number | null;
  budget?: number | null;
  budget_period?: "day" | "week" | "month" | null;
  payees?: string | null;
  expires_at?: string | null;
};

/**
 * The agent's own allowance, checked before the workspace rules: frozen or expired agents and actions outside
 * its job are blocked; its per-action cap and own budget send the action to the owner.
 * `spent` is what this agent moved in its budget period so far.
 */
export function checkAgent(agent: AgentInfo | undefined, action: MoneyAction, amount = 0, spent = 0, now = Date.now()): Check[] {
  if (!agent) return [];
  const kind = action.kind;
  const what = kind === "refund" ? "refund customers" : kind === "payout" ? "send payouts" : "send invoices";
  const block = (detail: string): Check[] => [{ id: "agent", label: "Agent", outcome: "block", detail }];
  if (agent.status === "frozen") return block(`${agent.name} is frozen. Unfreeze it on the Agents page to let it move money again.`);
  if (agent.expires_at && Date.parse(agent.expires_at) <= now) return block(`${agent.name}'s access ended on ${agent.expires_at.slice(0, 10)}.`);
  const allowed = kind === "refund" ? agent.can_refund : kind === "payout" ? agent.can_payout : 1;
  if (!allowed) return block(`${agent.name} isn't allowed to ${what}.`);
  if (kind === "payout" && agent.payees) {
    const list: string[] = JSON.parse(agent.payees);
    if (!list.some((e) => e.toLowerCase() === action.email.toLowerCase())) return block(`${action.email} isn't on ${agent.name}'s payee list.`);
  }
  const checks: Check[] = [{ id: "agent", label: "Agent", outcome: "pass", detail: `${agent.name} may ${what}.` }];
  if (agent.max_per_action != null && amount > agent.max_per_action + 0.005) {
    checks.push({ id: "agent_cap", label: "Agent cap", outcome: "hold", detail: `$${amount.toFixed(2)} is over ${agent.name}'s $${agent.max_per_action.toFixed(2)} limit per action.` });
  }
  if (agent.budget != null) {
    const period = agent.budget_period ?? "week";
    const over = spent + amount > agent.budget + 0.005;
    checks.push({
      id: "agent_budget",
      label: "Agent budget",
      outcome: over ? "hold" : "pass",
      detail: `${agent.name} has moved $${spent.toFixed(2)} of its $${agent.budget.toFixed(2)} per ${period}${over ? `; this would take it to $${(spent + amount).toFixed(2)}` : ""}.`,
    });
  }
  return checks;
}

export function decide(checks: Check[]): Decision {
  if (checks.some((c) => c.outcome === "block")) return "block";
  if (checks.some((c) => c.outcome === "hold")) return "hold";
  return "allow";
}

export function actionAmount(a: MoneyAction, facts?: RefundFacts): number {
  if (a.kind === "refund") return a.amount ?? Math.max(0, (facts?.capturedAmount ?? 0) - (facts?.refundedSoFar ?? 0));
  if (a.kind === "payout") return a.amount;
  return a.total;
}
