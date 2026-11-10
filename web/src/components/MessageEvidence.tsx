import { Fragment, useEffect, useState } from "react";
import { api, errorMessage, money, type LedgerEntry, type Review, type Ticket } from "../api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "./UI";

export type ReplyTicket = Ticket & {
  internal_note?: string | null;
  needs_follow_up?: number;
  reply_sent_at?: string | null;
  reply_stale?: boolean;
  current_payment_snapshot?: string;
};

export function TicketResult({ ticket, ledger, owner, disabled, refresh, notify }: {
  ticket: ReplyTicket; ledger: LedgerEntry[]; owner: boolean; disabled: boolean;
  refresh: () => Promise<unknown>; notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState(ticket.reply ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(ticket.reply ?? ""); }, [ticket.id, ticket.reply]);
  const payments = ledger.filter(e => e.ticket_id === ticket.id);
  async function reply(action: "send" | "save" | "update") {
    if (busy || disabled) return;
    if (action === "send") {
      if (ticket.reply_sent_at && !window.confirm("This reply was already sent. Send it again?")) return;
      if (ticket.reply_stale && !window.confirm("Written before your decision — review before sending. Send this draft anyway?")) return;
    }
    setBusy(true);
    try {
      const updated = await api<ReplyTicket>(`/api/inbox/${encodeURIComponent(ticket.id)}/reply`, "POST", {
        action, reply: draft, confirm: !!ticket.reply_sent_at,
        confirm_stale: action === "send" && !!ticket.reply_stale, payment_snapshot: ticket.current_payment_snapshot,
      });
      setDraft(updated.reply ?? "");
      await refresh();
      notify(action === "send" ? "Reply sent" : action === "update" ? "Reply updated — review before sending" : "Draft saved");
    } catch (e) { notify(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-5 pt-4">
    {owner && ticket.internal_note && <div className="rounded-xl border bg-muted/50 p-4 text-sm">
      <h3 className="mb-2 font-semibold">Internal note</h3>
      <p className="mb-2 text-xs text-muted-foreground">Owner only</p>
      <p className="whitespace-pre-wrap">{ticket.internal_note}</p>
    </div>}
    {ticket.channel === "email" && ticket.reply && <div className="space-y-3 rounded-xl border p-4 text-sm">
      <label className="block font-semibold" htmlFor={`customer-reply-${ticket.id}`}>{ticket.reply_sent_at && draft === ticket.reply ? "Reply to customer — sent" : "Reply to customer — not sent"}</label>
      {ticket.reply_stale && <p role="status" className="text-amber-800 dark:text-amber-300">Written before your decision — review before sending</p>}
      <Textarea id={`customer-reply-${ticket.id}`} value={draft} onChange={e => setDraft(e.target.value)} disabled={disabled || busy} maxLength={200000} className="min-h-40" />
      <div className="flex flex-wrap gap-3">
        <Button disabled={disabled || busy || !draft.trim()} onClick={() => void reply("send")}>Send reply</Button>
        <Button variant="outline" disabled={disabled || busy || !draft.trim() || draft === ticket.reply} onClick={() => void reply("save")}>Save draft</Button>
        {ticket.reply_stale && <Button variant="outline" disabled={disabled || busy || !draft.trim()} onClick={() => void reply("update")}>{busy ? "Working…" : "Update reply"}</Button>}
        <Button variant="outline" onClick={() => void navigator.clipboard.writeText(draft).then(() => notify("Copied")).catch(e => notify(errorMessage(e)))}>Copy</Button>
      </div>
      {ticket.reply_sent_at && <p className="text-xs text-muted-foreground">Reply sent · {new Date(ticket.reply_sent_at).toLocaleString("en-US")}</p>}
    </div>}
    <div className="space-y-3 rounded-xl border p-4 text-sm">
      <h3 className="font-semibold">Payment status</h3>
      <p className="text-xs text-muted-foreground">Current ledger outcome · PayPal sandbox</p>
      {payments.length ? payments.map(e => <div key={e.id} className="flex flex-wrap items-center gap-2">
        <span>{money(e.approved_amount ?? e.amount, e.currency)}</span>
        <StatusPill status={e.status} />
        <span className="break-all text-xs text-muted-foreground">{e.paypal_ref ? `PayPal ref: ${e.paypal_ref}` : "No PayPal reference recorded"}</span>
      </div>) : <p className="text-muted-foreground">No payment request recorded.</p>}
    </div>
  </div>;
}

/** Match only literal substrings of the source; never render message HTML. */
export function evidenceQuotes(body: string, reviews: Review[]) {
  const quotes = new Set<string>();
  for (const review of reviews.filter(r => r.injection_detected)) {
    for (const concern of review.concerns) {
      const text = concern.evidence.trim();
      if (text && body.includes(text)) quotes.add(text);
      else for (const match of text.matchAll(/[“"`]([^”"`]+)[”"`]/g)) {
        if (match[1].trim() && body.includes(match[1])) quotes.add(match[1]);
      }
    }
  }
  return [...quotes].sort((a, b) => b.length - a.length);
}
function Highlight({ text, quotes }: { text: string; quotes: string[] }) {
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    let start = text.length, quote = "";
    for (const candidate of quotes) {
      const index = text.indexOf(candidate, cursor);
      if (index >= 0 && index < start) { start = index; quote = candidate; }
    }
    if (!quote) { parts.push(<Fragment key={cursor}>{text.slice(cursor)}</Fragment>); break; }
    parts.push(<Fragment key={cursor}>{text.slice(cursor, start)}<mark title="Quoted in the AI review as suspicious instructions">{quote}</mark></Fragment>);
    cursor = start + quote.length;
  }
  return <>{parts}</>;
}
export function MessageBody({ body, reviews }: { body: string; reviews: Review[] }) {
  const quotes = evidenceQuotes(body, reviews);
  const flagged = reviews.some(r => r.injection_detected);
  const parts = body.split(/(<div\b[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/div>)/gi);
  return <div className="message whitespace-pre-wrap break-words text-sm leading-7">
    {flagged && <p className="message-warning">AI review flagged hidden instructions. {quotes.length ? "Matching text is highlighted below." : "No exact quoted passage was found in this message."}</p>}
    {parts.map((part, index) => index % 2 === 1
      ? <div key={index} className="hidden-part"><strong>Hidden in the email's HTML</strong><span><Highlight text={part} quotes={quotes} /></span></div>
      : <span key={index}><Highlight text={part} quotes={quotes} /></span>)}
  </div>;
}
