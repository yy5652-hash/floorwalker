import { BlockReasons } from "./RecordedExplanation";
import { Badge } from "./ui/badge";
import { ReviewNote } from "./Verdict";
import { entryCurrency, money, statusTone, type LedgerEntry } from "../api";
import { decisionAttribution, outcomeLabels } from "./ledger/helpers";

export function DecisionTrace({ entry }: { entry: LedgerEntry }) {
  let facts: Exclude<LedgerEntry["facts"], string>;
  try { facts = typeof entry.facts === "string" ? JSON.parse(entry.facts) : entry.facts; }
  catch { facts = null; }
  const rules = facts?.rules;
  const age = rules?.capturedAt ? Math.floor((Date.parse(entry.created_at) - Date.parse(rules.capturedAt)) / 86400000) : NaN;
  const attribution = decisionAttribution(entry);
  const currency = entryCurrency(entry);
  const values = entry.kind === "payout"
    ? [["Paid to this payee in 30 days", rules?.paidToPayee30d == null ? "Not recorded" : money(rules.paidToPayee30d, currency)]]
    : [
      ["Captured amount", rules?.capturedAmount == null ? "Not recorded" : money(rules.capturedAmount, currency)],
      ["Refunded so far", rules?.refundedSoFar == null ? "Not recorded" : money(rules.refundedSoFar, currency)],
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
        <div className="space-y-2 rounded-lg border p-4">
          <h4 className="text-xs font-medium text-muted-foreground">Current outcome</h4>
          <p className={`font-medium tone-${statusTone(entry.status)}`}>{outcomeLabels[entry.status]}</p>
          <p className="text-xs">{attribution.text}{attribution.at && <> · <time dateTime={attribution.at}>{new Date(attribution.at).toLocaleString("en-US")}</time></>}</p>
          {entry.decline_reason && <p className="text-xs">Decline reason: {entry.decline_reason}</p>}
        </div>
        <h4 className="text-xs font-medium text-muted-foreground">Initial AI review</h4>
        <ReviewNote review={entry.review} policyId={entry.policy_id} />
        {entry.review && <p className="text-xs">AI verdict: {entry.review.verdict} · Injection flag: {entry.review.injection_detected ? "Detected" : "Not detected"}</p>}
        <p className="break-all text-xs">{entry.source === "history" ? "Simulated · not sent to PayPal" : `PayPal reference: ${entry.paypal_ref ?? "Not recorded"}`}</p>
        {entry.error && <p className="text-xs text-destructive">{entry.error}</p>}
      </div>
    </div>
  </section>;
}
