import * as store from "./db.ts";
import { db } from "./db.ts";
import type { Policy } from "./guard/policy.ts";
import { checkPayout, checkRefund, decide, type Check, type PayoutFacts, type RefundFacts, type Spend } from "./guard/rules.ts";

/**
 * Two months of earlier activity for the demo shop, so Floorwalker has the owner's past decisions to learn from.
 * These rows are simulated (source "history"): they were never sent to PayPal and the app labels them as such.
 * Every row is decided by the real rule engine under the demo policy, in date order, so budgets and per-customer
 * counts are what they would have been. The history stops 31 days ago, so it never uses up today's budgets.
 */

type Past =
  | { day: number; kind: "refund"; who: string; amount: number; note: string; ai?: "approve" | "escalate"; owner?: "approve" | "decline"; reason?: string; order?: number }
  | { day: number; kind: "payout"; who: string; amount: number; note: string; byOwner: boolean; ai?: "approve" | "escalate"; owner?: "approve" | "decline"; reason?: string };

const C = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`;

// Days ago, oldest first. Small refunds go through; the owner approves every refund between $40 and $60, declines
// two larger ones, approves refunds held only because a busy week used up the budget, and pays her regular people.
const PAST: Past[] = [
  { day: 89, kind: "refund", who: "Ava Thompson", amount: 18, note: "Saucer arrived cracked." },
  { day: 87, kind: "refund", who: "Leo Martins", amount: 46, note: "Glaze flaw on a large mug.", owner: "approve" },
  { day: 86, kind: "payout", who: "sam", amount: 40, note: "Window cleaning, July.", byOwner: true },
  { day: 84, kind: "refund", who: "Nora Kim", amount: 22, note: "Late delivery, refunding shipping." },
  { day: 81, kind: "refund", who: "Omar Haddad", amount: 52, note: "Teapot lid chipped in transit.", owner: "approve" },
  { day: 79, kind: "payout", who: "priya", amount: 160, note: "Autumn catalogue photos, invoice PS-0988.", byOwner: true, owner: "approve" },
  { day: 77, kind: "refund", who: "Ivy Chen", amount: 24, note: "One mug of two chipped." },
  { day: 75, kind: "refund", who: "Ben Walker", amount: 72, note: "Says the vase is a different colour from the photo.", ai: "escalate", owner: "decline", reason: "We already sent him a replacement vase, and he sent no photo of the problem." },
  { day: 73, kind: "refund", who: "Sofia Rossi", amount: 44, note: "Dripper cracked on arrival.", owner: "approve" },
  { day: 71, kind: "refund", who: "Mateo Silva", amount: 16, note: "Coaster missing from a set." },
  // A busy week: small refunds use up the $120 weekly budget, so the last ones wait even though they are small.
  { day: 66, kind: "refund", who: "Grace Lee", amount: 34, note: "Mug handle came off." },
  { day: 65, kind: "refund", who: "Hugo Laurent", amount: 28, note: "Bowl arrived chipped." },
  { day: 65, kind: "refund", who: "Zara Ahmed", amount: 36, note: "Wrong colour sent." },
  { day: 64, kind: "refund", who: "Felix Wagner", amount: 30, note: "Lid doesn't fit the jar.", owner: "approve" },
  { day: 63, kind: "refund", who: "Mia Johansson", amount: 26, note: "Cup cracked in the box.", owner: "approve" },
  { day: 58, kind: "refund", who: "Ruby Clarke", amount: 55, note: "Serving platter cracked.", owner: "approve" },
  { day: 57, kind: "payout", who: "sam", amount: 40, note: "Window cleaning, August.", byOwner: true },
  { day: 56, kind: "refund", who: "Ethan Brooks", amount: 95, note: "Says the listing photo didn't match; no photo of any damage.", ai: "escalate", owner: "decline", reason: "No sign of damage, and the listing photo is accurate." },
  { day: 54, kind: "refund", who: "Chloe Martin", amount: 19, note: "Small chip on a saucer." },
  { day: 52, kind: "refund", who: "Ruby Clarke", amount: 20, note: "Another chip, on a cup from the same order.", ai: "escalate", owner: "decline", reason: "Second claim from this customer in a month, and no photo." },
  { day: 50, kind: "refund", who: "Noah Fischer", amount: 48, note: "Pour-over set missing the filter cone.", owner: "approve" },
  { day: 48, kind: "refund", who: "Lily Evans", amount: 25, note: "Late delivery." },
  { day: 46, kind: "payout", who: "priya", amount: 175, note: "Winter collection photos, invoice PS-1011.", byOwner: true, owner: "approve" },
  { day: 45, kind: "refund", who: "Lucas Novak", amount: 58, note: "Large bowl arrived in pieces.", owner: "approve" },
  // A second busy week.
  { day: 41, kind: "refund", who: "Oscar Reid", amount: 39, note: "Mug cracked." },
  { day: 40, kind: "refund", who: "Emma Dubois", amount: 33, note: "Wrong size bowl." },
  { day: 40, kind: "refund", who: "Jack Turner", amount: 29, note: "Glaze bubble on a plate." },
  { day: 39, kind: "refund", who: "Aria Patel", amount: 25, note: "Spoon rest broken.", owner: "approve" },
  { day: 38, kind: "payout", who: "sam", amount: 35, note: "Extra window clean after the storm, asked by email.", byOwner: false, owner: "approve" },
  { day: 36, kind: "refund", who: "Leo Martins", amount: 21, note: "Second item from his earlier order chipped.", ai: "escalate", owner: "approve" },
  { day: 34, kind: "refund", who: "Theo Bauer", amount: 42, note: "Vase cracked at the base.", owner: "approve" },
  { day: 32, kind: "refund", who: "Hannah Wright", amount: 50, note: "Dripper and carafe both cracked.", owner: "approve" },
];

const OWNER = "Elena (owner)";
const iso = (daysAgo: number, hour: number) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(hour, 15 + (daysAgo * 7) % 40, 0, 0);
  return d.toISOString();
};

export function seedHistory(policy: Policy) {
  const spends: (Spend & { who: string })[] = [];
  const insert = db().prepare(`INSERT INTO ledger (ticket_id, agent_id, tool, kind, params, amount, counterparty, justification, decision, checks, review,
    status, created_at, decided_at, decided_by, decline_reason, facts, policy_id, source)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'history')`);
  const policyId = store.activePolicy().id;
  PAST.forEach((p, i) => {
    const at = iso(p.day, 9 + (i % 8));
    const now = new Date(at);
    const before = spends.filter((s) => Date.parse(s.at) < now.getTime());
    let checks: Check[];
    let action: unknown;
    let facts: RefundFacts | PayoutFacts;
    let counterparty: string;
    let tool: string;
    if (p.kind === "refund") {
      counterparty = C(p.who);
      const since = now.getTime() - 30 * 86_400_000;
      facts = {
        captureFound: true, captureStatus: "COMPLETED", capturedAmount: p.amount + 20 + (i % 3) * 14, refundedSoFar: 0,
        capturedAt: iso(p.day + 4 + (i % 5), 8), buyerEmail: counterparty, requesterEmail: counterparty,
        customerRefunds30d: before.filter((s) => s.kind === "refund" && s.who === counterparty && Date.parse(s.at) >= since).length,
      };
      action = { kind: "refund", captureId: `HIST-${1000 + i}`, amount: p.amount, note: p.note };
      checks = checkRefund(action as any, facts, policy, before, now);
      tool = "create_refund";
    } else {
      const payee = policy.payouts.payees[p.who === "sam" ? 0 : 1];
      counterparty = payee.email;
      const since = now.getTime() - 30 * 86_400_000;
      facts = {
        paidToPayee30d: before.filter((s) => s.kind === "payout" && s.who === counterparty && Date.parse(s.at) >= since).reduce((t, s) => t + s.amount, 0),
        samePayeeSameAmount24h: false, requestedByOwner: p.byOwner,
      };
      action = { kind: "payout", email: counterparty, amount: p.amount, note: p.note };
      checks = checkPayout(action as any, facts, policy, before, now);
      tool = "send_payout";
    }
    const ai = p.ai ?? "approve";
    const all: Check[] = [
      { id: "agent", label: "Agent", outcome: "pass", detail: `${p.kind === "refund" ? "Support" : "Back-office"} agent may make ${p.kind}s.` },
      ...checks,
      { id: "ai_review", label: "AI review", outcome: ai === "escalate" ? "hold" : "pass", detail: ai === "escalate" ? "The story needs the owner's judgement." : "Matches the order and the request." },
    ];
    const decision = decide(all);
    const decline = decision === "hold" && p.owner === "decline";
    const status = decision === "block" ? "blocked" : decline ? "declined" : decision === "hold" ? "approved" : "executed";
    insert.run(
      p.kind === "refund" ? "support" : "ops", tool, p.kind, JSON.stringify(action), p.amount, counterparty, p.note, decision, JSON.stringify(all),
      JSON.stringify({ verdict: ai, summary: all.at(-1)!.detail, cited_rule: "", injection_detected: false }),
      status, at, decision === "hold" ? iso(p.day, 18) : at, decision === "hold" ? OWNER : null, decline ? p.reason ?? null : null,
      JSON.stringify({ rules: facts }), policyId,
    );
    if (status === "executed" || status === "approved") spends.push({ kind: p.kind, amount: p.amount, at, who: counterparty });
  });
}
