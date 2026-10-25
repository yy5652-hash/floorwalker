import { ArrowRight, Check, Smartphone, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { agentName, amountOf, errorMessage, money, personName, post, relativeTime, type LedgerEntry, type PageProps } from "../api";
import { Checks, ReviewNote } from "./Verdict";
import { EmptyState, StatusPill } from "./UI";

// qrcode 1.5.4 browser API: https://github.com/soldair/node-qrcode/tree/v1.5.4#todataurltext-options-cberror-url
export function PhoneApproval() {
  const url = `${location.origin}/approve`;
  const [qr, setQr] = useState("");
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(url, { width: 240, margin: 4, errorCorrectionLevel: "M", color: { dark: "#0F172A", light: "#FFFFFF" } }).then(data => { if (active) setQr(data); }).catch(() => {});
    return () => { active = false; };
  }, [url]);
  return <a className="phone-approval card" href="/approve" target="_blank" rel="noreferrer">{qr ? <img src={qr} width="78" height="78" alt="QR code to open approvals on your phone" /> : <Smartphone size={34} />}<div><strong>Approve from your phone <ArrowRight size={13} /></strong><span>Scan for one-tap approvals</span><small>{url}</small></div></a>;
}
export function ApprovalCard({ entry, state, refresh, notify, compact = false }: PageProps & { entry: LedgerEntry; compact?: boolean }) {
  const [other, setOther] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<LedgerEntry | null>(null);
  const locked = useRef(false);
  const custom = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(custom) && custom > 0 && custom <= entry.amount && Math.abs(custom * 100 - Math.round(custom * 100)) < 0.000001;
  async function decide(action: "approve" | "decline", customAmount?: number) {
    if (locked.current || result || entry.status !== "awaiting_approval") return;
    locked.current = true; setBusy(action); setError("");
    try {
      const updated = await post<LedgerEntry>(`/api/ledger/${entry.id}/${action}`, customAmount === undefined ? undefined : { amount: customAmount });
      setResult(updated);
      notify(updated.status === "failed" ? `Payment failed: ${updated.error ?? "PayPal could not complete this request."}` : action === "decline" ? `Declined · ${money(entry.amount)} to ${personName(entry.counterparty)}` : updated.status === "approved" ? `PayPal ${entry.kind} ${updated.paypal_ref ?? ""} submitted · ${money(amountOf(updated))}` : `Request #${entry.id} · processing in PayPal`);
      await refresh();
    } catch (e) { setError(errorMessage(e)); notify(errorMessage(e)); await refresh(); }
    finally { setBusy(null); locked.current = false; }
  }
  return <article className={`card approval-card ${compact ? "compact" : ""}`} data-film="approval" aria-label={`Request ${entry.id}: ${money(entry.amount)} to ${entry.counterparty ?? "the buyer"}`}>
    <div className="approval-meta"><span className="agent-tag"><span className="tiny-dot" />{agentName(state, entry.agent_id)}</span><time dateTime={entry.created_at}>{relativeTime(entry.created_at)}</time><span className="request-id">#{entry.id}</span></div>
    <div className="approval-money"><div><span className="eyebrow">{entry.kind === "refund" ? "Refund request" : "Payout request"}</span><div className="big-money">{money(entry.amount)}</div></div><span className="pill hold"><span className="tiny-dot" />Needs you</span></div>
    <div className="recipient"><span>{entry.kind === "refund" ? "Refund to" : "Pay to"}</span><strong>{personName(entry.counterparty)}</strong>{entry.counterparty && personName(entry.counterparty) !== entry.counterparty && <small className="hint">{entry.counterparty}</small>}</div>
    {entry.justification && <blockquote className="reason">“{entry.justification}”</blockquote>}
    {compact ? <details className="compact-review"><summary>Review recommendation &amp; checks</summary><ReviewNote review={entry.review} policyId={entry.policy_id} /><Checks checks={entry.checks} review={entry.review} /></details> : <><ReviewNote review={entry.review} policyId={entry.policy_id} /><Checks checks={entry.checks} review={entry.review} /></>}
    {result ? <div className="action-result"><StatusPill status={result.status} />{result.error && <p className="error">{result.error}</p>}</div> : <>
      <div className="approval-actions"><button className="btn primary" data-film="approve" disabled={!!busy} onClick={() => void decide("approve")}><Check size={16} />{busy === "approve" ? "Approving…" : `Approve ${money(entry.amount)}`}</button><button className="btn decline-btn" data-film="decline" disabled={!!busy} onClick={() => void decide("decline")}><X size={15} />{busy === "decline" ? "Declining…" : "Decline"}</button></div>
      <button className="text-btn other-amount" data-film="approve-other" disabled={!!busy} aria-expanded={other} onClick={() => { setOther(!other); setError(""); }}>{compact ? "Different amount" : "Approve a different amount"}</button>
      {other && <form className="amount-form" onSubmit={e => { e.preventDefault(); if (valid) void decide("approve", custom); }}><label htmlFor={`amount-${entry.id}`}>Amount in USD · up to {money(entry.amount)}</label><div className="row"><input id={`amount-${entry.id}`} type="number" inputMode="decimal" min="0.01" max={entry.amount} step="0.01" autoFocus required value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /><button className="btn primary" disabled={!valid || !!busy}>Confirm {valid ? money(custom) : "amount"}</button></div>{amount && !valid && <small className="error">Enter a positive amount up to {money(entry.amount)}, with at most two decimals.</small>}</form>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </article>;
}
export function Approvals(props: PageProps) {
  const waiting = props.state.ledger.filter(e => e.status === "awaiting_approval");
  const recent = props.state.ledger.filter(e => e.status === "approved" || e.status === "declined").sort((a, b) => Date.parse(b.decided_at ?? b.created_at) - Date.parse(a.decided_at ?? a.created_at)).slice(0, 5);
  return <div className="page-stack"><div className="section-heading"><h2>Waiting for your approval <span className="count">{waiting.length}</span></h2><span className="hint">Your decision. Your money.</span></div>{waiting.length ? <div className="approval-grid">{waiting.map(entry => <ApprovalCard key={entry.id} entry={entry} {...props} />)}</div> : <div className="card"><EmptyState title="All caught up"><p>There are no requests waiting for your approval.</p><a href="/app#inbox" className="text-link">Go to your inbox <ArrowRight size={14} /></a></EmptyState></div>}
    <section className="card"><div className="card-h"><h2>Decided recently</h2><a className="text-link" href="/app#ledger">View ledger <ArrowRight size={14} /></a></div>{recent.length ? recent.map(e => <a className="recent-decision" key={e.id} href={`/app#ledger/${e.id}`}><div><strong>{money(amountOf(e))}</strong><span>{e.counterparty}</span></div><StatusPill status={e.status} /><time>{relativeTime(e.decided_at)}</time></a>) : <p className="card-b hint">Your approvals and declines will appear here.</p>}</section>
  </div>;
}
