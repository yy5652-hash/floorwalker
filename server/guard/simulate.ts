import * as store from "../db.ts";
import type { Policy } from "./policy.ts";
import { checkPayout, checkRefund, decide, type Check, type Decision, type PayoutFacts, type RefundFacts } from "./rules.ts";

export type SimRow = {
  id: number;
  tool: string;
  amount: number;
  counterparty: string | null;
  at: string;
  before: Decision;
  after: Decision;
  why: string;
};

/**
 * The AI reviewer sees the owner's limits, so it often escalates a sound request only because the request is over one.
 * That hold says nothing a limit change wouldn't answer, so learning and replay don't treat it as an objection of its own.
 */
export function onlyObjectsToLimit(reviewJson: string | null): boolean {
  if (!reviewJson) return false;
  const review = JSON.parse(reviewJson) as { verdict?: string; matches_request?: boolean; injection_detected?: boolean; concerns?: { issue: string; evidence?: string }[] };
  if (review.verdict !== "escalate" || review.matches_request !== true || review.injection_detected !== false || !review.concerns?.length) return false;
  return review.concerns.every((c) => /\b(limits?|budgets?|thresholds?|auto-?approv\w*)\b/i.test(c.issue));
}

/**
 * Replays every past money move under a draft policy: the rule engine runs again on the facts stored with each
 * ledger row (as of that moment), while the agent check and the AI review keep their original results, except an AI
 * hold that only objected to a limit. Nothing is sent to PayPal or to the model. A real request is reviewed again.
 */
export function simulate(draft: Policy): { rows: SimRow[]; changed: number; counts: Record<"before" | "after", Record<Decision, number>> } {
  const all = store.ledger().slice().reverse();
  const spent = all.filter((r) => r.status === "executed" || r.status === "approved").map((r) => ({ kind: r.kind as "refund" | "payout", amount: r.approved_amount ?? r.amount, at: r.decided_at ?? r.created_at }));
  const rows: SimRow[] = [];
  for (const r of all) {
    if (!r.facts) continue;
    const facts = JSON.parse(r.facts).rules;
    const action = JSON.parse(r.params);
    const original: Check[] = JSON.parse(r.checks);
    const now = new Date(r.created_at);
    const history = spent.filter((s) => Date.parse(s.at) < now.getTime());
    const rules = r.kind === "refund"
      ? checkRefund(action, facts as RefundFacts, draft, history, now)
      : checkPayout(action, facts as PayoutFacts, draft, history, now);
    const stillLimited = rules.some((c) => c.outcome !== "pass");
    const kept = original.filter((c) => c.id === "agent" || c.id === "injection" || c.id === "ai_review")
      .filter((c) => c.id !== "ai_review" || c.outcome !== "hold" || stillLimited || !onlyObjectsToLimit(r.review));
    const checks = [...kept.filter((c) => c.id === "agent"), ...rules, ...kept.filter((c) => c.id !== "agent")];
    const after = decide(checks);
    const hit = checks.find((c) => c.outcome === "block") ?? checks.find((c) => c.outcome === "hold");
    rows.push({
      id: r.id, tool: r.tool, amount: r.amount, counterparty: r.counterparty, at: r.created_at,
      before: r.decision as Decision, after, why: hit ? `${hit.label}: ${hit.detail}` : "All checks pass",
    });
  }
  const count = (k: "before" | "after") => ({ allow: rows.filter((x) => x[k] === "allow").length, hold: rows.filter((x) => x[k] === "hold").length, block: rows.filter((x) => x[k] === "block").length });
  return { rows, changed: rows.filter((x) => x.before !== x.after).length, counts: { before: count("before"), after: count("after") } };
}
