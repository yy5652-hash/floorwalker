import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { config } from "../config.ts";
import * as store from "../db.ts";
import { structured } from "../llm.ts";
import { validatePolicy, type Policy } from "./policy.ts";
import { checkPayout, checkRefund, decide, PERIOD_DAYS, type Check, type Decision, type PayoutFacts, type RefundFacts, type Spend } from "./rules.ts";
import { simulate } from "./simulate.ts";

/**
 * Learns from the owner's own decisions. A request that waited for the owner and was approved every time is a tap the
 * rules could have saved; a request the owner declined marks a line the rules must keep. Every proposed change is a
 * draft policy, backtested on this workspace's history (nothing the owner declined may become automatic) and on the
 * benchmark's attacks (every attack must still be stopped) before the owner sees it. The model only rewords the
 * owner's rules to match a change and reads decline reasons; the numbers come from the ledger.
 */

export type LearnedChange = {
  id: string;
  title: string;
  evidence: string;
  /** Why the change stops where it does, when a declined request sets the line. */
  boundary?: string;
  rows: number[];
  draft: Policy;
  impact: {
    tapsSaved: number;
    moreAutoUsd: number;
    declinedLetThrough: number;
    tapsPer100: { before: number; after: number };
    /** Benchmark attacks stopped with the change, and how many the rules alone stop before and after (defense in depth). */
    bench: { attacks: number; stopped: number; rulesBefore: number; rulesAfter: number } | null;
  };
};

const MIN_APPROVALS = 3;
export const WINDOW_DAYS = 90;
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const ceilTo = (n: number, step: number) => Math.ceil(n / step) * step;
const keyOf = (kind: "refund" | "payout") => (kind === "refund" ? "refunds" : "payouts") as "refunds" | "payouts";

type Decided = { row: store.LedgerRow; holds: Check[]; approved: boolean; kind: "refund" | "payout" };

/** Requests that waited for the owner and that a person decided: approved (then executed) or declined. */
function decided(): Decided[] {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  return store.ledger()
    .filter((r) => r.decision === "hold" && r.decided_by && r.facts && Date.parse(r.created_at) >= since)
    .filter((r) => (r.kind === "refund" || r.kind === "payout") && ["executed", "approved", "declined"].includes(r.status))
    .map((r) => ({
      row: r,
      holds: (JSON.parse(r.checks) as Check[]).filter((c) => c.outcome === "hold"),
      approved: r.status !== "declined",
      kind: r.kind as "refund" | "payout",
    }));
}

const onlyHeldBy = (d: Decided, ids: string[]) => d.holds.length > 0 && d.holds.every((c) => ids.includes(c.id));

/** Raise an auto-approve limit to cover what the owner always approved, stopping below any amount they declined. */
function autoLimit(policy: Policy, kind: "refund" | "payout", all: Decided[]) {
  const limits = policy[keyOf(kind)];
  const current = limits.auto_approve_up_to;
  const declinedAbove = all.filter((d) => d.kind === kind && !d.approved && d.row.amount > current).map((d) => d.row.amount).sort((a, b) => a - b);
  const ceiling = Math.min(declinedAbove[0] ?? Infinity, limits.hard_limit + 0.01);
  const approved = all
    .filter((d) => d.kind === kind && d.approved && d.holds.some((c) => c.id === "auto_limit") && onlyHeldBy(d, ["auto_limit", "budget"]) && d.row.amount < ceiling)
    .sort((a, b) => a.row.amount - b.row.amount);
  if (approved.length < MIN_APPROVALS) return null;
  let to = ceilTo(approved.at(-1)!.row.amount, 5);
  if (to >= ceiling) to = Math.floor((ceiling - 0.01) * 100) / 100;
  if (to <= current) return null;
  const draft = structuredClone(policy);
  draft[keyOf(kind)].auto_approve_up_to = to;
  const boundary = declinedAbove.length ? `It stops there because you declined a ${money(declinedAbove[0])} ${kind}.` : undefined;
  return { draft, rows: approved.map((d) => d.row.id), from: current, to, boundary };
}

/** Raise a rolling budget the owner kept topping up by approving requests that waited only because it ran out. */
function budget(policy: Policy, kind: "refund" | "payout", all: Decided[]) {
  const limits = policy[keyOf(kind)];
  const held = all.filter((d) => d.kind === kind && onlyHeldBy(d, ["budget"]));
  if (held.length < MIN_APPROVALS || held.some((d) => !d.approved)) return null;
  const spends: Spend[] = store.ledger()
    .filter((r) => r.kind === kind && (r.status === "executed" || r.status === "approved"))
    .map((r) => ({ kind, amount: r.approved_amount ?? r.amount, at: r.decided_at ?? r.created_at }));
  const days = PERIOD_DAYS[limits.budget.period];
  const needed = Math.max(...held.map((d) => {
    const t = Date.parse(d.row.created_at);
    return spends.filter((s) => Date.parse(s.at) < t && Date.parse(s.at) >= t - days * 86_400_000).reduce((n, s) => n + s.amount, 0) + d.row.amount;
  }));
  const to = ceilTo(needed, 10);
  if (to <= limits.budget.amount) return null;
  const draft = structuredClone(policy);
  draft[keyOf(kind)].budget.amount = to;
  return { draft, rows: held.map((d) => d.row.id), from: limits.budget.amount, to };
}

/** Raise one payee's monthly limit when every payment over it was approved. */
function payeeLimits(policy: Policy, all: Decided[]) {
  const out = [];
  for (const p of policy.payouts.payees) {
    const held = all.filter((d) => d.kind === "payout" && d.row.counterparty?.toLowerCase() === p.email.toLowerCase() && onlyHeldBy(d, ["payee_limit", "auto_limit"]) && d.holds.some((c) => c.id === "payee_limit"));
    if (held.length < 2 || held.some((d) => !d.approved)) continue;
    const to = ceilTo(Math.max(...held.map((d) => (JSON.parse(d.row.facts!).rules as PayoutFacts).paidToPayee30d + d.row.amount)), 10);
    if (to <= p.monthly_limit) continue;
    const draft = structuredClone(policy);
    draft.payouts.payees.find((x) => x.email === p.email)!.monthly_limit = to;
    out.push({ draft, rows: held.map((d) => d.row.id), name: p.name, from: p.monthly_limit, to });
  }
  return out;
}

/** Benchmark cases with their PayPal facts and the AI reviewer's recorded verdict (written by `npm run bench`). */
type ReplayCase = { id: string; group: string; tool: string; action: any; facts: any; at: string; history: Spend[]; extra: Check[]; verdict: string; injection: boolean };
let replayCache: ReplayCase[] | null | undefined;
function replay(): ReplayCase[] | null {
  if (replayCache !== undefined) return replayCache;
  const file = join(import.meta.dirname, "../../bench/replay.json");
  replayCache = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReplayCase[]) : null;
  return replayCache;
}

/** Re-runs the rule engine with a draft policy on every benchmark attack, keeping the reviewer's recorded verdict. */
export function benchAttacks(draft: Policy): { attacks: number; stopped: number; rulesStopped: number } | null {
  const cases = replay()?.filter((c) => c.group === "attack");
  if (!cases?.length) return null;
  let stopped = 0, rulesStopped = 0;
  for (const c of cases) {
    // Re-run at the moment the case was recorded, so order ages and rolling budgets mean what they meant then.
    const now = new Date(c.at);
    const rules = c.tool === "create_refund" ? checkRefund(c.action, c.facts as RefundFacts, draft, c.history, now) : checkPayout(c.action, c.facts as PayoutFacts, draft, c.history, now);
    const review: Check[] = [];
    if (c.injection) review.push({ id: "injection", label: "Prompt injection", outcome: "block", detail: "" });
    review.push({ id: "ai_review", label: "AI review", outcome: c.verdict === "reject" ? "block" : c.verdict === "escalate" ? "hold" : "pass", detail: "" });
    if (decide([...c.extra, ...rules, ...review]) !== "allow") stopped++;
    if (decide([...c.extra, ...rules]) !== "allow") rulesStopped++;
  }
  return { attacks: cases.length, stopped, rulesStopped };
}

/** Of every 100 money moves, how many needed the owner. */
export function tapsPer100(decisions: (Decision | string)[]): number {
  return decisions.length ? Math.round((decisions.filter((d) => d === "hold").length / decisions.length) * 100) : 0;
}

/** Taps per 100 money moves over the learning window, with the counts behind it. */
export function tapsSummary(): { per100: number; moves: number; taps: number; days: number } {
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const rows = store.ledger().filter((r) => (r.kind === "refund" || r.kind === "payout") && Date.parse(r.created_at) >= since);
  return { per100: tapsPer100(rows.map((r) => r.decision)), moves: rows.length, taps: rows.filter((r) => r.decision === "hold").length, days: WINDOW_DAYS };
}

/** Taps per 100 money moves, week by week, for the last `weeks` weeks (oldest first). */
export function tapsByWeek(weeks = 12): { week: string; moves: number; taps: number; per100: number }[] {
  const rows = store.ledger().filter((r) => r.kind === "refund" || r.kind === "payout");
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() - (weeks - 1) * 7);
  return Array.from({ length: weeks }, (_, i) => {
    const from = start.getTime() + i * 7 * 86_400_000;
    const inWeek = rows.filter((r) => Date.parse(r.created_at) >= from && Date.parse(r.created_at) < from + 7 * 86_400_000);
    const taps = inWeek.filter((r) => r.decision === "hold").length;
    return { week: new Date(from).toISOString().slice(0, 10), moves: inWeek.length, taps, per100: tapsPer100(inWeek.map((r) => r.decision)) };
  });
}

function measure(policy: Policy, draft: Policy): LearnedChange["impact"] {
  const sim = simulate(draft);
  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const byId = new Map(store.ledger().map((r) => [r.id, r]));
  const recent = sim.rows.filter((s) => Date.parse(s.at) >= since);
  let tapsSaved = 0, declinedLetThrough = 0, moreAutoUsd = 0;
  for (const s of recent) {
    if (s.before !== "hold" || s.after !== "allow") continue;
    const r = byId.get(s.id)!;
    if (r.status === "declined") declinedLetThrough++;
    else if (r.decided_by) { tapsSaved++; moreAutoUsd += r.approved_amount ?? r.amount; }
  }
  return {
    tapsSaved, declinedLetThrough, moreAutoUsd: Math.round(moreAutoUsd * 100) / 100,
    tapsPer100: { before: tapsPer100(recent.map((r) => r.before)), after: tapsPer100(recent.map((r) => r.after)) },
    bench: bench(policy, draft),
  };
}

function bench(policy: Policy, draft: Policy): LearnedChange["impact"]["bench"] {
  const before = benchAttacks(policy), after = benchAttacks(draft);
  return before && after ? { attacks: after.attacks, stopped: after.stopped, rulesBefore: before.rulesStopped, rulesAfter: after.rulesStopped } : null;
}

/** Changes the owner's decisions support, each already backtested. Dismissed ones are left out. */
export function learnedChanges(policy: Policy): LearnedChange[] {
  const all = decided();
  const dismissed = new Set(store.setting<string[]>("learn.dismissed", []));
  const out: LearnedChange[] = [];
  const push = (c: Omit<LearnedChange, "impact">) => {
    if (dismissed.has(c.id)) return;
    validatePolicy(c.draft);
    const impact = measure(policy, c.draft);
    // Never offer a change that would have let through something the owner said no to, or that lets a known attack through.
    if (impact.tapsSaved === 0 || impact.declinedLetThrough > 0) return;
    if (impact.bench && impact.bench.stopped < impact.bench.attacks) return;
    out.push({ ...c, impact });
  };
  for (const kind of ["refund", "payout"] as const) {
    const key = keyOf(kind);
    const a = autoLimit(policy, kind, all);
    if (a) push({
      id: `${key}.auto_approve_up_to=${a.to}`,
      title: `Let ${kind}s up to ${money(a.to)} go through on their own`,
      evidence: `You approved all ${a.rows.length} ${kind}s between ${money(a.from)} and ${money(a.to)} that waited for you in the last ${WINDOW_DAYS} days. The limit is ${money(a.from)} now.`,
      boundary: a.boundary, rows: a.rows, draft: a.draft,
    });
    const b = budget(policy, kind, all);
    if (b) push({
      id: `${key}.budget=${b.to}`,
      title: `Raise the ${policy[key].budget.period}ly ${kind} budget to ${money(b.to)}`,
      evidence: `${b.rows.length} ${kind}s waited only because the ${policy[key].budget.period}ly budget of ${money(b.from)} had run out, and you approved every one.`,
      rows: b.rows, draft: b.draft,
    });
  }
  for (const p of payeeLimits(policy, all)) push({
    id: `payee:${p.name}=${p.to}`,
    title: `Raise ${p.name}'s monthly limit to ${money(p.to)}`,
    evidence: `Every payment to ${p.name} that went over the ${money(p.from)} monthly limit was approved by you (${p.rows.length} times).`,
    rows: p.rows, draft: p.draft,
  });
  return out.sort((x, y) => y.impact.tapsSaved - x.impact.tapsSaved);
}

const Reworded = z.object({ text: z.string().describe("The owner's rules with only the changed number or limit edited, everything else word for word") });

/** The owner's rules, reworded to match an accepted change; if the model is unavailable, the change is appended. */
export async function reword(text: string, change: LearnedChange): Promise<string> {
  try {
    const out = await structured({
      model: config.ai.reviewModel,
      system: "You edit a small-business owner's plain-language spending rules for their AI agent. Change only what the accepted change requires, in the owner's own style. Keep every other sentence exactly as written.",
      prompt: `<rules>\n${text}\n</rules>\n\n<accepted_change>\n${change.title}\n</accepted_change>`,
      schema: Reworded,
    });
    if (out.text.trim().length > text.length / 2) return out.text.trim();
  } catch { /* fall through */ }
  return `${text.trim()}\n${change.title}.`;
}

const NoteSchema = z.object({
  note: z.string().describe("One short rule for the AI reviewer, in the owner's voice; empty when there is no clear pattern or it is already covered"),
  based_on: z.array(z.number()).describe("Ledger ids of the declined requests the rule comes from"),
});

/**
 * Reads why the owner declined requests and proposes one new note for the AI reviewer when two or more declines share
 * a reason the current notes do not cover. Cached until a new decline arrives.
 */
export async function learnedNote(policy: Policy): Promise<{ note: string; rows: number[] } | null> {
  const declines = decided().filter((d) => !d.approved && d.row.decline_reason);
  if (declines.length < 2) return null;
  const key = declines.map((d) => d.row.id).join(",");
  const cached = store.setting<{ key: string; value: { note: string; rows: number[] } | null } | null>("learn.note", null);
  if (cached?.key === key) return cached.value && !store.setting<string[]>("learn.dismissed", []).includes(`note:${cached.value.note}`) ? cached.value : null;
  let value: { note: string; rows: number[] } | null = null;
  try {
    const out = await structured({
      model: config.ai.reviewModel,
      system: "You help a small-business owner tune the AI reviewer that checks their AI agent's refunds and payouts. Look for a reason shared by at least two of the owner's declines that the current reviewer notes do not already cover, and write it as one short rule. Do not invent reasons the owner did not give.",
      prompt: `<reviewer_notes>\n${policy.notes.map((n) => `- ${n}`).join("\n")}\n</reviewer_notes>\n\n<declined>\n${declines.map((d) => `#${d.row.id} ${d.kind} $${d.row.amount} to ${d.row.counterparty}: agent said "${d.row.justification ?? ""}"; owner declined because "${d.row.decline_reason}"`).join("\n")}\n</declined>`,
      schema: NoteSchema,
    });
    const rows = out.based_on.filter((id) => declines.some((d) => d.row.id === id));
    if (out.note.trim() && rows.length >= 2) value = { note: out.note.trim(), rows };
  } catch {
    return null;
  }
  store.setSetting("learn.note", { key, value });
  return value;
}
