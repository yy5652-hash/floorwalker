import { Fragment } from "react";
import type { Review } from "../api";

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
