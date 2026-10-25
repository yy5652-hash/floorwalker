import { Check, CircleAlert, ShieldAlert, Sparkles } from "lucide-react";
import { money, personName, STATUS_LABEL, statusTone, type Check as CheckType, type GuardEvent, type LedgerEntry, type Review } from "../api";

export function Checks({ checks: all, review }: { checks: CheckType[]; review?: Review | null }) {
  // With a recommendation banner above, the AI review's own check row would only repeat it.
  const checks = review ? all.filter(c => c.id !== "ai_review") : all;
  const failures = checks.filter(c => c.outcome !== "pass").sort((a, b) => Number(b.outcome === "block") - Number(a.outcome === "block"));
  const passed = checks.filter(c => c.outcome === "pass");
  const row = (c: CheckType) => <li key={c.id} className={c.outcome}>{c.outcome === "pass" ? <Check size={15} /> : <CircleAlert size={16} />}<div><strong>{c.label}</strong><span>{c.detail}</span></div></li>;
  return <div className="checks"><ul>{failures.map(row)}</ul>{passed.length > 0 && <details className="passed-checks"><summary>✓ {passed.length} checks passed</summary><ul>{passed.map(row)}</ul></details>}</div>;
}
export function ReviewNote({ review, policyId }: { review: Review | null; policyId?: number | null }) {
  if (!review) return <div className="review-unavailable">No AI recommendation recorded for this request.</div>;
  const tone = { approve: "allow", escalate: "hold", reject: "block" }[review.verdict];
  const title = { approve: "Approval recommended", escalate: "Needs your review", reject: "Rejection recommended" }[review.verdict];
  return <div className={`review ${tone}`}><div className="review-title"><Sparkles size={15} /><strong>{title}</strong><span className="review-label">AI review</span></div><p>{review.summary}</p>{review.cited_rule && <div className="cited-rule">Rule: “{review.cited_rule}” {policyId != null && <span className="policy-version">policy v{policyId}</span>}</div>}{review.injection_detected && <div className="injection"><strong><ShieldAlert size={15} /> Prompt injection detected</strong>{review.concerns[0]?.evidence && <blockquote>“{review.concerns[0].evidence}”</blockquote>}</div>}</div>;
}
type VerdictProps = Omit<GuardEvent, "type" | "counterparty"> & { counterparty: string | null; policyId?: number | null; approvedAmount?: number | null; justification?: string | null };
export function Verdict(props: VerdictProps) {
  const amount = props.approvedAmount ?? props.amount;
  return <section className={`verdict ${statusTone(props.status)}`}>
    <div className="verdict-h"><div><span className={`pill ${statusTone(props.status)}`}>{STATUS_LABEL[props.status]}</span><h3>{props.tool === "create_refund" ? "Refund" : "Payout"} {money(amount)} to {personName(props.counterparty)}</h3></div><div className="verdict-amount">{money(amount)}{props.approvedAmount != null && props.approvedAmount !== props.amount && <small>of {money(props.amount)} requested</small>}</div></div>
    {props.justification && <blockquote className="reason">“{props.justification}”</blockquote>}
    <ReviewNote review={props.review} policyId={props.policyId} /><Checks checks={props.checks} review={props.review} />
    {props.paypalRef && <div className="paypal-ref"><Check size={14} />PayPal sandbox reference <code>{props.paypalRef}</code></div>}
    {props.error && <p className="error" role="alert">{props.error}</p>}
  </section>;
}
export function DecisionCard({ entry }: { entry: LedgerEntry }) {
  return <Verdict ledgerId={entry.id} tool={entry.tool} amount={entry.amount} approvedAmount={entry.approved_amount} counterparty={entry.counterparty} decision={entry.decision} status={entry.status} checks={entry.checks} review={entry.review} paypalRef={entry.paypal_ref ?? undefined} error={entry.error ?? undefined} policyId={entry.policy_id} justification={entry.justification} />;
}
