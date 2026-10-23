import { useState } from "react";
import { streamEvents, type AgentEvent, type LedgerEntry, type State, type Ticket } from "../api";
import { Verdict } from "./Verdict";

const TOOL_LABEL: Record<string, string> = {
  find_customer_orders: "Looked up the customer's orders",
  get_order: "Read the order from PayPal",
  get_shipment_tracking: "Checked shipment tracking in PayPal",
  get_refund: "Read a refund from PayPal",
  create_refund: "Asked to refund",
  send_payout: "Asked to send a payout",
};

/** Shows the message the way the agent reads it, with HTML-hidden text called out. */
function MessageBody({ body }: { body: string }) {
  const parts = body.split(/(<div style="display:none">[\s\S]*?<\/div>)/g);
  return (
    <div className="message">
      {parts.map((p, i) => {
        const m = p.match(/^<div style="display:none">([\s\S]*?)<\/div>$/);
        return m ? <span key={i} className="hidden-part">{m[1]}</span> : <span key={i}>{p}</span>;
      })}
    </div>
  );
}

function lastDecision(ledger: LedgerEntry[], ticketId: string) {
  return ledger.filter((l) => l.ticket_id === ticketId);
}

function Trace({ events }: { events: AgentEvent[] }) {
  return (
    <div className="trace">
      {events.map((e, i) => {
        switch (e.type) {
          case "start":
            return null;
          case "note":
            return (
              <div key={i} className="step note">
                <span className="icon">✎</span>
                <div className="body">{e.text}</div>
              </div>
            );
          case "tool_call":
            return (
              <div key={i} className="step">
                <span className="icon">{e.guarded ? "$" : "⌕"}</span>
                <div className="body">
                  <div className="title">{TOOL_LABEL[e.name] ?? e.name} <code>{e.name}</code></div>
                  <div className="detail mono">{JSON.stringify(Object.fromEntries(Object.entries(e.input ?? {}).filter(([k]) => k !== "reason")))}</div>
                  {e.input?.reason && <div className="detail">Agent's reason: {e.input.reason}</div>}
                </div>
              </div>
            );
          case "tool_result":
            return e.name === "create_refund" || e.name === "send_payout" ? null : (
              <div key={i} className="step">
                <span className="icon">↳</span>
                <div className="body detail">{e.isError ? `Error: ${e.summary}` : e.summary}</div>
              </div>
            );
          case "guard":
            return <Verdict key={i} {...e} />;
          case "reply":
            return (
              <div key={i} className="reply">
                <div className="reply-h">Agent's reply</div>
                {e.text}
              </div>
            );
          case "error":
            return <div key={i} className="err">{e.message}</div>;
          case "done":
            return null;
        }
      })}
    </div>
  );
}

export function Inbox({ state, refresh, notify }: { state: State; refresh: () => void; notify: (s: string) => void }) {
  const [selected, setSelected] = useState<string>(state.tickets[0]?.id ?? "");
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const ticket = state.tickets.find((t) => t.id === selected) ?? state.tickets[0];
  const ready = state.configured.paypal && state.configured.ai;

  async function run(path: string, key: string) {
    setRunning(key);
    setEvents((m) => ({ ...m, [key]: [] }));
    try {
      await streamEvents(path, (e) => {
        setEvents((m) => ({ ...m, [key]: [...(m[key] ?? []), e] }));
        if (e.type === "guard") refresh();
      });
    } catch (err: any) {
      notify(err.message);
    } finally {
      setRunning(null);
      refresh();
    }
  }

  const tracePast = (t: Ticket) => {
    if (events[t.id]?.length) return null;
    const rows = lastDecision(state.ledger, t.id);
    return (
      <div className="trace">
        {rows.slice().reverse().map((l) => (
          <Verdict key={l.id} ledgerId={l.id} tool={l.tool} amount={l.amount} counterparty={l.counterparty} decision={l.decision} status={l.status} checks={l.checks} review={l.review} paypalRef={l.paypal_ref} error={l.error} />
        ))}
        {t.reply && (
          <div className="reply">
            <div className="reply-h">Agent's reply</div>
            {t.reply}
          </div>
        )}
      </div>
    );
  };

  if (!state.tickets.length) {
    return <div className="card empty">The inbox is empty. Press “Reset demo” to create fresh sandbox orders and load the demo inbox.</div>;
  }

  return (
    <div className="inbox">
      <div className="card">
        <div className="card-h">
          <h2>Inbox</h2>
          <span className="hint">{state.tickets.filter((t) => t.status === "open").length} open</span>
        </div>
        <div className="items">
          {state.tickets.map((t) => {
            const rows = lastDecision(state.ledger, t.id);
            const last = rows[0];
            return (
              <button key={t.id} className={`item ${t.id === ticket?.id ? "active" : ""}`} onClick={() => setSelected(t.id)}>
                <span className="from">
                  {t.from_name}
                  {t.channel === "task" && <span className="pill task">To-do</span>}
                </span>
                <span className="subject">{t.subject}</span>
                <span className="meta">
                  {t.status === "handled" ? <span className="pill neutral">Handled</span> : <span>Open</span>}
                  {last && <span className={`pill ${last.status}`}>{last.decision === "allow" ? "Approved" : last.decision === "hold" ? "Needs you" : "Blocked"}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="card-b" style={{ borderTop: "1px solid var(--line)" }}>
          <button className="btn danger" style={{ width: "100%" }} disabled={!!running || !state.configured.paypal} onClick={() => { setSelected("ATTACK"); void run("/api/attack", "ATTACK"); }}>
            Simulate a hijacked agent
          </button>
          <div className="hint" style={{ marginTop: 6 }}>Replays six money moves an attacker would make after taking over the agent's prompt.</div>
        </div>
      </div>

      <div className="card">
        {selected === "ATTACK" ? (
          <>
            <div className="card-h"><h2>Hijacked agent</h2><span className="pill block">Simulation</span></div>
            <div className="card-b"><Trace events={events.ATTACK ?? []} /></div>
          </>
        ) : ticket && (
          <>
            <div className="card-h">
              <div>
                <h2>{ticket.subject}</h2>
                <div className="hint">{ticket.from_name} &lt;{ticket.from_email}&gt; · {new Date(ticket.received_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
              </div>
              <span style={{ flex: 1 }} />
              <button className="btn primary" disabled={!!running || !ready} onClick={() => run(`/api/tickets/${ticket.id}/run`, ticket.id)}>
                {running === ticket.id ? "Agent working…" : ticket.status === "handled" ? "Run agent again" : "Let the agent handle it"}
              </button>
            </div>
            <div className="card-b">
              <MessageBody body={ticket.body} />
              {events[ticket.id]?.length ? <Trace events={events[ticket.id]} /> : tracePast(ticket)}
              {!ready && <p className="hint">Add PayPal sandbox credentials and an Anthropic or Gemini key to .env to run the agent.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
