import { describe, money, type Check, type Review } from "../api";

const MARK = { pass: "✓", hold: "!", block: "✕" } as const;
const HEAD = {
  allow: "Allowance approved it",
  hold: "Allowance is asking you",
  block: "Allowance blocked it",
} as const;

export function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={c.outcome}>
          <span className="mark">{MARK[c.outcome]}</span>
          <span className="lbl">{c.label}</span>
          <span className="txt">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function ReviewNote({ review }: { review: Review | null }) {
  if (!review) return null;
  const quote = review.concerns.find((c) => c.evidence)?.evidence;
  return (
    <div className="review">
      <b>AI review:</b> {review.summary}
      {review.verdict !== "approve" && quote && <span className="quote">“{quote}”</span>}
    </div>
  );
}

export function Verdict(props: {
  ledgerId: number;
  tool: string;
  amount: number;
  counterparty: string | null;
  decision: "allow" | "hold" | "block";
  status: string;
  checks: Check[];
  review: Review | null;
  paypalRef?: string | null;
  error?: string | null;
}) {
  const failed = props.status === "failed";
  return (
    <div className={`verdict ${failed ? "block" : props.decision}`}>
      <div className="verdict-h">
        <span>{failed ? "PayPal rejected it" : HEAD[props.decision]}</span>
        <span className="hint">#{props.ledgerId} · {describe(props)}</span>
        <span className="amt">{money(props.amount)}</span>
      </div>
      <Checks checks={props.checks} />
      <ReviewNote review={props.review} />
      {props.paypalRef && <div className="paypal-ref">PayPal sandbox reference <code>{props.paypalRef}</code></div>}
      {props.error && <div className="paypal-ref err">{props.error}</div>}
    </div>
  );
}
