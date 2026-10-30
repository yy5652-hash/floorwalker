import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Check, CircleAlert, ShieldAlert, Sparkles } from "lucide-react";
import {
  money,
  personName,
  STATUS_LABEL,
  statusTone,
  type Check as CheckType,
  type GuardEvent,
  type LedgerEntry,
  type Review,
} from "../api";
export function Checks({
  checks: all,
  review,
}: {
  checks: CheckType[];
  review?: Review | null;
}) {
  // With a recommendation banner above, the AI review's own check row would only repeat it.
  const checks = review ? all.filter((c) => c.id !== "ai_review") : all;
  const failures = checks
    .filter((c) => c.outcome !== "pass")
    .sort(
      (a, b) => Number(b.outcome === "block") - Number(a.outcome === "block"),
    );
  const passed = checks.filter((c) => c.outcome === "pass");
  const row = (c: CheckType) => (
    <li
      key={c.id}
      className={
        c.outcome === "pass" ? "text-muted-foreground" : `tone-${c.outcome}`
      }
    >
      {c.outcome === "pass" ? <Check size={15} /> : <CircleAlert size={16} />}
      <div>
        <strong>{c.label}</strong>
        <span>{c.detail}</span>
      </div>
    </li>
  );
  return (
    <div className="space-y-3 [&_ul]:space-y-3 [&_li]:flex [&_li]:items-start [&_li]:gap-2 [&_li]:rounded-lg [&_li]:p-2 [&_li>div]:min-w-0 [&_strong]:block [&_strong]:text-xs [&_strong]:font-medium [&_li_span]:mt-1 [&_li_span]:block [&_li_span]:text-xs [&_li_span]:leading-relaxed">
      <ul>{failures.map(row)}</ul>
      {passed.length > 0 && (
        <details className="text-muted-foreground [&>summary]:text-xs [&>ul]:mt-3">
          <summary>✓ {passed.length} checks passed</summary>
          <ul>{passed.map(row)}</ul>
        </details>
      )}
    </div>
  );
}
export function ReviewNote({
  review,
  policyId,
  condensed = false,
}: {
  review: Review | null;
  policyId?: number | null;
  condensed?: boolean;
}) {
  if (!review)
    return (
      <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        No AI recommendation recorded for this request.
      </div>
    );
  const tone = { approve: "allow", escalate: "hold", reject: "block" }[
    review.verdict
  ];
  const title = {
    approve: "Approval recommended",
    escalate: "Needs your review",
    reject: "Rejection recommended",
  }[review.verdict];
  return (
    <div
      className={`review space-y-3 rounded-lg border border-current/10 p-4 text-sm leading-relaxed   tone-${tone}`}
    >
      <div className="flex flex-wrap items-center gap-2 [&>strong]:text-xs">
        <Sparkles size={15} />
        <strong>{title}</strong>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wider opacity-70">
          AI review
        </span>
      </div>
      {!condensed && <>
      <p>{review.summary}</p>
      {review.cited_rule && (
        <div className="cited-rule border-t border-current/15 pt-3 text-xs leading-relaxed">
          Rule: “{review.cited_rule}”{" "}
          {policyId != null && (
            <span className="ml-1 inline-block rounded border border-current/20 px-1 text-[10px]">
              policy v{policyId}
            </span>
          )}
        </div>
      )}
      {review.injection_detected && (
        <div className="injection space-y-2 rounded-md border border-current/20 p-3 [&>strong]:flex [&>strong]:items-center [&>strong]:gap-2 [&>strong]:text-xs [&>blockquote]:break-words [&>blockquote]:text-xs">
          <strong>
            <ShieldAlert size={15} /> Prompt injection detected
          </strong>
          {review.concerns[0]?.evidence && (
            <blockquote>“{review.concerns[0].evidence}”</blockquote>
          )}
        </div>
      )}
      </>}
    </div>
  );
}
type VerdictProps = Omit<GuardEvent, "type" | "counterparty"> & {
  counterparty: string | null;
  policyId?: number | null;
  approvedAmount?: number | null;
  justification?: string | null;
  history?: boolean;
};
export function Verdict(props: VerdictProps) {
  const amount = props.approvedAmount ?? props.amount;
  return (
    <Card
      className={`verdict gap-0 space-y-4 rounded-xl border border-current/20 bg-card p-4 text-card-foreground sm:p-5   tone-${statusTone(props.status)}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 [&_h3]:mt-2 [&_h3]:text-foreground">
        <div>
          <Badge
            className={`max-w-full whitespace-normal border-transparent text-[11px]   tone-${statusTone(props.status)}`}
            variant="secondary"
          >
            {STATUS_LABEL[props.status]}
          </Badge>
          {props.history && (
            <Badge variant="secondary" className="ml-2 text-muted-foreground">
              Demo history
            </Badge>
          )}
          <h3>
            {props.tool === "create_refund" ? "Refund" : "Payout"}{" "}
            {money(amount)} to {personName(props.counterparty)}
          </h3>
        </div>
        <div className="text-xl font-semibold tracking-tight tabular-nums [&>small]:block [&>small]:text-xs [&>small]:font-normal [&>small]:text-muted-foreground">
          {money(amount)}
          {props.approvedAmount != null &&
            props.approvedAmount !== props.amount && (
              <small>of {money(props.amount)} requested</small>
            )}
        </div>
      </div>
      {props.justification && (
        <blockquote className="my-3 border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground">
          “{props.justification}”
        </blockquote>
      )}
      <ReviewNote review={props.review} policyId={props.policyId} />
      <Checks checks={props.checks} review={props.review} />
      {props.history ? (
        <p className="border-t pt-3 text-xs text-muted-foreground">
          Simulated · not sent to PayPal
        </p>
      ) : props.paypalRef && (
        <div className="paypal-ref flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground [&>code]:break-all">
          <Check size={14} />
          PayPal sandbox reference <code>{props.paypalRef}</code>
        </div>
      )}
      {props.error && (
        <p className="mt-3 text-sm text-block break-words" role="alert">
          {props.error}
        </p>
      )}
    </Card>
  );
}
export function DecisionCard({ entry }: { entry: LedgerEntry }) {
  return (
    <Verdict
      ledgerId={entry.id}
      tool={entry.tool}
      amount={entry.amount}
      approvedAmount={entry.approved_amount}
      counterparty={entry.counterparty}
      decision={entry.decision}
      status={entry.status}
      checks={entry.checks}
      review={entry.review}
      paypalRef={entry.paypal_ref ?? undefined}
      error={entry.error ?? undefined}
      policyId={entry.policy_id}
      justification={entry.justification}
      history={entry.source === "history"}
    />
  );
}
