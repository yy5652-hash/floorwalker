import * as store from "../db.ts";
import { ctx } from "../context.ts";
import { tapsPer100, WINDOW_DAYS } from "./learn.ts";
import { validatePolicy, type Policy } from "./policy.ts";
import { checkRefund, checkPayout, decide, type Check, type Decision, type MoneyAction, type RefundFacts, type PayoutFacts, type Spend } from "./rules.ts";

export function trustPreview(agent: store.Agent, amount?: number) {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const rows = store.ledger().filter(r => r.agent_id === agent.id && Date.parse(r.created_at) >= since);
  const amounts = rows.filter(r => r.amount > 0).map(r => r.amount).sort((a, b) => a - b);
  const smallAmount = amount ?? agent.max_per_action ?? amounts[Math.floor(amounts.length / 2)] ?? 40;
  const measure = (cap: number | null) => {
    // Historical blocks and holds are never relaxed, including AI review and owner decisions.
    const decisions = rows.map(r => r.decision === "allow" && cap !== null && r.amount > cap + 0.005 ? "hold" : r.decision);
    return { moves: rows.length, taps: decisions.filter(d => d === "hold").length, tapsPer100: tapsPer100(decisions),
      autoUsd: Math.round(rows.reduce((sum, r, i) => sum + (decisions[i] === "allow" && r.status === "executed" ? r.amount : 0), 0) * 100) / 100 };
  };
  return { agentId: agent.id, days: WINDOW_DAYS, smallAmount, levels: { ask: measure(0), small: measure(smallAmount), rules: measure(null) } };
}

export type ShadowDraft = { policy: Policy; startedBy: string; startedAt: string; endsAt: string | null };
export function shadowDraft(): ShadowDraft | null {
  const row = store.db().prepare("SELECT * FROM shadow_policy WHERE id = 1").get() as any;
  return row ? { policy: JSON.parse(row.json), startedBy: row.started_by, startedAt: row.started_at, endsAt: row.ends_at } : null;
}

export function startShadow(raw: unknown, endsAt: string | null) {
  const policy = validatePolicy(raw);
  if (endsAt && Date.parse(endsAt) <= Date.now()) throw new Error("Shadow end date must be in the future.");
  const db = store.db();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT OR REPLACE INTO shadow_policy (id, json, started_by, started_at, ends_at) VALUES (1, ?, ?, ?, ?)").run(JSON.stringify(policy), ctx().actor.name, new Date().toISOString(), endsAt);
    db.exec("DELETE FROM shadow_results; COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return shadowView();
}

export function stopShadow() {
  store.db().exec("DELETE FROM shadow_policy; DELETE FROM shadow_results;");
  return { ok: true };
}

// Mutable only for dependency substitution in failure-isolation tests.
export const shadowDeps = { evaluate(action: MoneyAction, facts: RefundFacts | PayoutFacts, policy: Policy, history: Spend[], now: Date): Check[] {
  return action.kind === "refund" ? checkRefund(action, facts as RefundFacts, policy, history, now)
    : action.kind === "payout" ? checkPayout(action, facts as PayoutFacts, policy, history, now) : [];
} };

/** Best-effort, rules-only observation after the real decision is final; no network or AI calls. */
export function observeShadow(id: number, action: MoneyAction, facts: RefundFacts | PayoutFacts | null, agentChecks: Check[]) {
  try {
    const draft = shadowDraft();
    if (!draft || (draft.endsAt && Date.parse(draft.endsAt) <= Date.now())) return;
    const row = store.ledgerEntry(id)!;
    const checks = facts ? shadowDeps.evaluate(action, facts, draft.policy, store.spendHistory(), new Date(row.created_at))
      : (JSON.parse(row.checks) as Check[]).filter(c => c.id !== "ai_review" && c.id !== "injection");
    const decision = decide([...agentChecks, ...checks]);
    store.db().prepare("INSERT OR IGNORE INTO shadow_results (ledger_id, real_decision, shadow_decision) VALUES (?, ?, ?)").run(id, row.decision, decision);
  } catch (e) {
    // Do not log the draft, request, or exception message: they can contain private data.
    console.error("Shadow observation failed", { ledgerId: id, error: e instanceof Error ? e.name : "Error" });
  }
}

export function shadowView() {
  const draft = shadowDraft();
  const rows = store.db().prepare(`SELECT l.id, l.amount, l.counterparty, s.real_decision AS realDecision, s.shadow_decision AS shadowDecision
    FROM shadow_results s JOIN ledger l ON l.id = s.ledger_id ORDER BY l.id DESC`).all() as unknown as { id: number; amount: number; counterparty: string | null; realDecision: Decision; shadowDecision: Decision }[];
  return { draft, active: Boolean(draft && (!draft.endsAt || Date.parse(draft.endsAt) > Date.now())), rulesOnly: true as const,
    caveat: "Shadow decisions use deterministic rules only. AI review could still change them. Historical spend is used; this is not a simulated alternate balance.",
    report: { seen: rows.length, wouldAutoActuallyHeld: rows.filter(r => r.shadowDecision === "allow" && r.realDecision === "hold").length,
      wouldHoldActuallyAuto: rows.filter(r => r.shadowDecision === "hold" && r.realDecision === "allow").length,
      wouldBlockNotBlocked: rows.filter(r => r.shadowDecision === "block" && r.realDecision !== "block").length,
      tapsPer100: { before: tapsPer100(rows.map(r => r.realDecision)), after: tapsPer100(rows.map(r => r.shadowDecision)) },
      differences: rows.filter(r => r.realDecision !== r.shadowDecision) } };
}

function differences(before: unknown, after: unknown, path = ""): { field: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => differences(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [{ field: path, before: before ?? null, after: after ?? null }];
}

export function policyStatus() {
  // Read-only: unlike activePolicy(), this endpoint never initializes an empty workspace.
  const [active, previous] = store.policyVersions();
  if (!active) return { version: null, effectiveAt: null, changedBy: null, differences: [], waiting: 0, waitingChanged: 0, waitingUnknown: 0 };
  const waiting = store.ledger().filter(r => r.status === "awaiting_approval");
  const history = store.spendHistory();
  let waitingChanged = 0, waitingUnknown = 0;
  for (const row of waiting) {
    try {
      if (!row.facts || !JSON.parse(row.facts).rules) { waitingUnknown++; continue; }
      const original = JSON.parse(row.checks) as Check[];
      const checks = shadowDeps.evaluate(JSON.parse(row.params), JSON.parse(row.facts).rules, active.policy, history, new Date());
      const kept = original.filter(c => c.id.startsWith("agent") || c.id === "ai_review" || c.id === "injection");
      if (decide([...checks, ...kept]) !== row.decision) waitingChanged++;
    } catch { waitingUnknown++; }
  }
  return { version: active.id, effectiveAt: active.created_at, changedBy: active.created_by,
    differences: differences(previous?.policy ?? {}, active.policy), waiting: waiting.length, waitingChanged, waitingUnknown };
}
