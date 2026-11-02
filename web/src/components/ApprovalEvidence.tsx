import { type Check, type LedgerEntry } from "../api";

const labels = { pass: "Passed", hold: "Needs you", block: "Blocked", missing: "Not recorded" };
const priority = { pass: 0, hold: 1, block: 2 };
const limits = new Set(["auto_limit", "hard_limit", "budget", "payee_limit", "agent_cap", "agent_budget"]);
function summarize(checks: Check[], fallback: string) {
  const first = [...checks].sort((a, b) => priority[b.outcome] - priority[a.outcome])[0];
  return { status: first?.outcome ?? "missing" as const, sentence: first?.detail ?? fallback };
}

/** Keep the recorded deterministic outcome visible beside the separate AI opinion. */
export function ApprovalEvidence({ entry }: { entry: LedgerEntry }) {
  const rules = entry.checks.filter(c => !["ai_review", "injection"].includes(c.id));
  const record = summarize(rules.filter(c => ["capture", "buyer"].includes(c.id)),
    entry.kind === "payout" ? "No recipient payment record is verified for this payout; see the payee rule below." : "No PayPal evidence was recorded for this request.");
  const policy = summarize(rules, "No deterministic rule checks were recorded.");
  const limit = summarize(rules.filter(c => limits.has(c.id)), "No amount or budget check was recorded.");
  const ai = entry.review ? {
    status: ({ approve: "pass", escalate: "hold", reject: "block" } as const)[entry.review.verdict],
    sentence: entry.review.summary.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || entry.review.summary,
  } : summarize(entry.checks.filter(c => ["ai_review", "injection"].includes(c.id)), "No AI recommendation recorded for this request.");
  return <dl className="approval-evidence">
    {[["PayPal records", record], ["Your rules", policy], ["Limits", limit], ["AI review", ai]].map(([label, value]) => {
      const row = value as typeof record;
      return <div key={String(label)} className={label === "AI review" ? "review" : undefined}>
        <dt>{String(label)} <span className={`check-status status-${row.status}`}>{labels[row.status]}</span></dt>
        <dd>{row.sentence}</dd>
      </div>;
    })}
  </dl>;
}
