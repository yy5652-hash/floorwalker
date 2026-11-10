import { formatCheckMoney, limitsCurrency, entryCurrency } from "../lib/money";
import { type Check, type LedgerEntry } from "../api";

const labels = { pass: "Passed", hold: "Needs you", block: "Blocked", missing: "Not recorded" };
const priority = { pass: 0, hold: 1, block: 2 };
const limits = new Set(["auto_limit", "hard_limit", "budget", "payee_limit", "agent_cap", "agent_budget"]);
function summarize(checks: Check[], fallback: string) {
  const first = [...checks].sort((a, b) => priority[b.outcome] - priority[a.outcome])[0];
  return { status: first?.outcome ?? "missing" as const, sentence: first?.detail ?? fallback };
}

export function ApprovalSummary({ entry }: { entry: LedgerEntry }) {
  const checks = entry.checks.map(check => ({ ...check, detail: formatCheckMoney(check, entryCurrency(entry), limitsCurrency(entry)) }));
  const buyer = checks.find(c => c.id === "buyer");
  const capture = checks.find(c => c.id === "capture");
  const captured = capture?.outcome === "pass" ? capture.detail.match(/\(captured ([^)]+)\)/)?.[1] : null;
  const reason = checks.find(c => c.outcome === "block") ?? checks.find(c => c.outcome === "hold");
  const facts = entry.kind === "refund" ? [
    buyer?.outcome === "pass" ? "Original buyer verified" : buyer?.detail,
    captured ? `${captured} captured` : capture?.detail,
  ] : ["payee", "payee_limit", "requested_by"].map(id => checks.find(c => c.id === id)?.detail);
  return <p className="text-sm leading-relaxed">{[...new Set([...facts, reason?.detail].filter(Boolean))].join(" · ") || "No recorded check explains why approval is needed."}</p>;
}

/** Keep the recorded deterministic outcome visible beside the separate AI opinion. */
export function ApprovalEvidence({ entry }: { entry: LedgerEntry }) {
  const rules = entry.checks.filter(c => !["ai_review", "injection"].includes(c.id)).map(check => ({ ...check, detail: formatCheckMoney(check, entryCurrency(entry), limitsCurrency(entry)) }));
  const record = summarize(rules.filter(c => ["capture", "buyer"].includes(c.id)), "No PayPal evidence was recorded for this request.");
  const policy = summarize(rules.filter(c => !limits.has(c.id) && !["capture", "buyer"].includes(c.id)), "No other rule applies to this request.");
  const limit = summarize(rules.filter(c => limits.has(c.id)), "No amount or budget check was recorded.");
  const ai = entry.review ? {
    status: ({ approve: "pass", escalate: "hold", reject: "block" } as const)[entry.review.verdict],
    sentence: entry.review.summary.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || entry.review.summary,
  } : summarize(entry.checks.filter(c => ["ai_review", "injection"].includes(c.id)), "No AI recommendation recorded for this request.");
  const rows = entry.kind === "payout" ? [
    ["Approved payee", summarize(rules.filter(c => c.id === "payee"), "No approved-payee check was recorded.")],
    ["Payee monthly limit", summarize(rules.filter(c => c.id === "payee_limit"), "No monthly payee limit check was recorded.")],
    ["Requested by owner", summarize(rules.filter(c => c.id === "requested_by"), "No owner-request check was recorded.")],
    ["Limits", limit], ["Other rules", summarize(rules.filter(c => !limits.has(c.id) && !["payee", "requested_by", "capture", "buyer"].includes(c.id)), "No other rule check was recorded.")], ["Initial AI review", ai],
  ] : [["PayPal records", record], ["Your rules", policy], ["Limits", limit], ["Initial AI review", ai]];
  return <dl className="approval-evidence">
    {rows.map(([label, value]) => {
      const row = value as typeof record;
      return <div key={String(label)} className={label === "Initial AI review" ? "review" : undefined}>
        <dt>{String(label)} <span className={`check-status status-${row.status}`}>{labels[row.status]}</span></dt>
        <dd>{row.sentence}</dd>
      </div>;
    })}
  </dl>;
}
