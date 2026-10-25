import { Bot, CircleAlert, FileText, Loader2, Mail, Search, Send, ShieldAlert, Sparkles } from "lucide-react";
import { useRef, useState } from "react";
import { errorMessage, money, relativeTime, streamEvents, type AgentEvent, type PageProps, type State, type Ticket } from "../api";
import { DecisionCard, Verdict } from "./Verdict";
import { EmptyState, StatusPill } from "./UI";

function MessageBody({ body }: { body: string }) {
  const parts = body.split(/(<div\b[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/div>)/gi);
  return <div className="message">{parts.map((part, i) => {
    const hidden = part.match(/^<div\b[^>]*>([\s\S]*?)<\/div>$/i);
    return hidden ? <div key={i} className="hidden-part"><strong><ShieldAlert size={14} />Hidden in the email's HTML</strong><span>{hidden[1]}</span></div> : <span key={i}>{part}</span>;
  })}</div>;
}
function toolSentence(call: Extract<AgentEvent, { type: "tool_call" }>, result: Extract<AgentEvent, { type: "tool_result" }> | undefined, ticket?: Ticket) {
  const input = call.input ?? {};
  const amount = typeof input.amount === "number" ? money(input.amount) : typeof input.amount === "string" && Number.isFinite(Number(input.amount)) ? money(Number(input.amount)) : "the requested amount";
  const complete = !!result && !result.isError;
  const email = String(input.email ?? "the customer");
  const customer = ticket?.from_email === email ? ticket.from_name : email;
  switch (call.name) {
    case "find_customer_orders": return `${complete ? "Looked up" : "Looking up"} ${customer}'s orders in PayPal`;
    case "get_order": return `${complete ? "Read" : "Reading"} order ${String(input.id ?? input.order_id ?? "details")} from PayPal`;
    case "lookup_contact": return `${complete ? "Looked up" : "Looking up"} ${String(input.name ?? input.query ?? "the payee")} in contacts`;
    case "get_refund": return `${complete ? "Read" : "Reading"} refund details from PayPal`;
    case "create_refund": return `Asked to refund ${amount} to the buyer`;
    case "send_payout": return `Asked to pay ${amount} to ${String(input.recipientEmail ?? input.recipient_email ?? input.email ?? "the payee")}`;
    default: return `${complete ? "Completed" : "Running"} ${call.name.replaceAll("_", " ")}`;
  }
}
function Trace({ events, state, ticket }: { events: AgentEvent[]; state: State; ticket?: Ticket }) {
  return <div className="trace">{events.map((event, index) => {
    switch (event.type) {
      case "start": case "done": case "tool_result": return null;
      case "note": return <div className="step note" key={index}><Sparkles size={15} /><p>{event.text}</p></div>;
      case "tool_call": {
        const result = events.find((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result" && e.id === event.id);
        return <div className={`step ${result?.isError ? "step-error" : ""}`} key={index}><span className="step-icon">{event.guarded ? <Send size={16} /> : <Search size={16} />}</span><div className="step-body"><strong>{toolSentence(event, result, ticket)}{result && !event.guarded && <span className="tool-summary"> · {result.summary}</span>}</strong>{result?.isError && <p className="error">{result.summary}</p>}{typeof event.input?.reason === "string" && <blockquote className="reason">“{event.input.reason}”</blockquote>}<details className="raw-details"><summary>Details</summary><pre>{JSON.stringify({ input: event.input, result: result ? { summary: result.summary, isError: result.isError } : "Waiting for result" }, null, 2)}</pre></details></div></div>;
      }
      case "guard": {
        const entry = state.ledger.find(e => e.id === event.ledgerId);
        return entry ? <DecisionCard key={index} entry={entry} /> : <Verdict key={index} {...event} />;
      }
      case "reply": return <div className="reply" key={index}><div className="reply-h"><Bot size={16} />Agent's reply</div>{event.text}</div>;
      case "error": return <div key={index} className="error error-banner" role="alert"><CircleAlert size={16} />{event.message}</div>;
    }
  })}</div>;
}
export function Inbox({ state, refresh, notify }: PageProps) {
  const [selected, setSelected] = useState(state.tickets[0]?.id ?? "");
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const lock = useRef(false);
  const ticket = state.tickets.find(t => t.id === selected) ?? state.tickets[0];
  const ready = state.configured.paypal && state.configured.ai;
  const agent = state.agents.find(a => a.id === (ticket?.channel === "task" ? "ops" : "support"));
  const name = agent?.name ?? (ticket?.channel === "task" ? "Back-office agent" : "Support agent");
  async function run(path: string, key: string) {
    if (lock.current) return;
    lock.current = true; setRunning(key); setEvents(m => ({ ...m, [key]: [] }));
    let ended = false;
    try {
      await streamEvents(path, event => {
        setEvents(m => ({ ...m, [key]: [...(m[key] ?? []), event] }));
        if (event.type === "guard") void refresh();
        if (event.type === "done" || event.type === "error") ended = true;
        if (event.type === "error") notify(event.message);
      });
      if (!ended) throw new Error("The agent connection ended early. Check the recorded decisions before running again.");
    } catch (e) {
      const message = errorMessage(e);
      setEvents(m => ({ ...m, [key]: [...(m[key] ?? []), { type: "error", message }] })); notify(message);
    } finally { lock.current = false; setRunning(null); await refresh(); }
  }
  function past(t: Ticket) {
    return <div className="trace">{state.ledger.filter(e => e.ticket_id === t.id).slice().reverse().map(e => <DecisionCard key={e.id} entry={e} />)}{t.reply && <div className="reply"><div className="reply-h"><Bot size={16} />Agent's reply</div>{t.reply}</div>}</div>;
  }
  if (!state.tickets.length) return <div className="card"><EmptyState title="Your inbox is ready for its first request"><p>Load the demo shop to give your agents something to work on.</p><a className="btn primary" href="/app#setup">Set up your demo shop</a></EmptyState></div>;
  return <div className="inbox"><aside className="card inbox-list"><div className="card-h"><h2>All messages</h2><span className="count">{state.tickets.length}</span></div><div className="items">{state.tickets.map(t => {
    const last = state.ledger.find(e => e.ticket_id === t.id);
    return <button className={`item ${selected !== "ATTACK" && t.id === ticket?.id ? "active" : ""}`} key={t.id} onClick={() => setSelected(t.id)}><span className="from">{t.channel === "task" ? <FileText size={15} /> : <Mail size={15} />}{t.from_name}<time>{relativeTime(t.received_at)}</time></span><span className="subject">{t.subject}</span><span className="item-agent">{t.channel === "email" ? "Support agent" : "Back-office agent"}</span><span className="item-status">{last ? <StatusPill status={last.status} /> : <span className="pill neutral">{t.status === "handled" ? "Handled" : "New request"}</span>}</span></button>;
  })}</div><div className="hijack-box"><button className="btn danger" data-film="hijack" disabled={!!running || !ready} onClick={() => { setSelected("ATTACK"); void run("/api/attack", "ATTACK"); }}><ShieldAlert size={16} />Simulate a hijacked agent</button><p>See how your rules respond when an attacker tries to take over an agent.</p></div></aside>
    <section className="card inbox-detail">{selected === "ATTACK" ? <><div className="card-h"><h2>Hijacked Support agent · simulation</h2><span className="pill block">Simulation</span></div><div className="card-b"><Trace state={state} events={events.ATTACK ?? []} />{running === "ATTACK" && <div className="working"><Loader2 className="spin" size={16} />Simulation running…</div>}</div></> : ticket && <><div className="message-heading"><div className="eyebrow">{ticket.channel === "email" ? "Customer email" : "Owner's to-do"}</div><h2>{ticket.subject}</h2><p>{ticket.from_name} <span>&lt;{ticket.from_email}&gt;</span></p></div><div className="card-b"><MessageBody body={ticket.body} /><div className="run-row"><button className="btn primary" data-film="run" disabled={!!running || !ready || agent?.status === "frozen"} onClick={() => void run(`/api/tickets/${encodeURIComponent(ticket.id)}/run`, ticket.id)}>{running === ticket.id ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}{running === ticket.id ? `${name} is working…` : `Let the ${name} handle it`}</button>{agent?.status === "frozen" && <a className="text-link" href="/app#agents">Unfreeze this agent to continue</a>}{!ready && <a className="text-link" href="/app#setup">Finish setup to run your agent</a>}</div>{events[ticket.id]?.length ? <Trace state={state} ticket={ticket} events={events[ticket.id]} /> : past(ticket)}</div></>}</section>
  </div>;
}
