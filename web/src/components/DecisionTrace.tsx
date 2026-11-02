import { BlockReasons } from "./RecordedExplanation";
import { Badge } from "./ui/badge";
import { ReviewNote } from "./Verdict";
import { money, type LedgerEntry } from "../api";

export function DecisionTrace({ entry }: { entry: LedgerEntry }) {
  let facts: Exclude<LedgerEntry["facts"], string>;
  try { facts = typeof entry.facts === "string" ? JSON.parse(entry.facts) : entry.facts; }
  catch { facts = null; }
  const rules = facts?.rules;
  const age = rules?.capturedAt ? Math.floor((Date.parse(entry.created_at) - Date.parse(rules.capturedAt)) / 86400000) : NaN;
  const values = entry.kind === "payout"
    ? [["Paid to this payee in 30 days", rules?.paidToPayee30d == null ? "Not recorded" : money(rules.paidToPayee30d)]]
    : [
      ["Captured amount", rules?.capturedAmount == null ? "Not recorded" : money(rules.capturedAmount)],
      ["Refunded so far", rules?.refundedSoFar == null ? "Not recorded" : money(rules.refundedSoFar)],
      ["Buyer", rules?.buyerEmail ?? "Not recorded"],
      ["Requester", rules?.requesterEmail ?? "Not recorded"],
      ["Order age at request", Number.isFinite(age) ? `${age} days` : "Not recorded"],
    ];
  return <section aria-label={`Decision trace for request ${entry.id}`} className="space-y-4 whitespace-normal bg-card p-5 text-sm">
    <h3>Decision trace · #{entry.id}</h3>
    <BlockReasons explanations={entry.block_explanations} />
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-3">
        <ul className="space-y-2">
          {entry.checks.map((check) => <li key={check.id} className="border-b py-3">
            <div className="flex items-center justify-between gap-2"><strong className="text-xs">{check.label}</strong>
              <Badge variant="secondary" className={`status-label tone-${check.outcome === "pass" ? "allow" : check.outcome}`}>{check.outcome}</Badge></div>
            <p className="mt-1 break-words text-xs text-muted-foreground">{check.detail}</p>
          </li>)}
        </ul>
        {!entry.checks.length && <p>No checks recorded.</p>}
        <dl className="grid grid-cols-2 gap-2 text-xs">
          {values.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}
        </dl>
      </div>
      <div className="space-y-3">
        <ReviewNote review={entry.review} policyId={entry.policy_id} />
        {entry.review && <p className="text-xs">Verdict: {entry.review.verdict} · Injection flag: {entry.review.injection_detected ? "Detected" : "Not detected"}</p>}
        <p className="text-xs">Decided by {entry.decided_by ?? "Not recorded"} · {entry.decided_at ? new Date(entry.decided_at).toLocaleString("en-US") : "Decision time not recorded"}</p>
        {entry.decline_reason && <p className="text-xs">Decline reason: {entry.decline_reason}</p>}
        <p className="break-all text-xs">{entry.source === "history" ? "Simulated · not sent to PayPal" : `PayPal reference: ${entry.paypal_ref ?? "Not recorded"}`}</p>
        {entry.error && <p className="text-xs text-destructive">{entry.error}</p>}
      </div>
    </div>
  </section>;
}
