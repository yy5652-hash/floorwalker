import { useState } from "react";
import { describe, money, post, type State } from "../api";
import { Checks, ReviewNote } from "./Verdict";

export function Approvals({ state, refresh, notify }: { state: State; refresh: () => void; notify: (s: string) => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const waiting = state.ledger.filter((l) => l.status === "awaiting_approval");

  async function act(id: number, what: "approve" | "decline") {
    setBusy(id);
    try {
      const r = await post(`/api/ledger/${id}/${what}`);
      notify(what === "approve" ? r.note ?? `Request #${id} approved.` : `Request #${id} declined. No money moved.`);
    } catch (e: any) {
      notify(e.message);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  if (!waiting.length) return <div className="card empty">Nothing is waiting for you. The agent handles everything inside your allowance on its own.</div>;

  return (
    <div className="approvals">
      {waiting.map((l) => {
        const ticket = state.tickets.find((t) => t.id === l.ticket_id);
        return (
          <div key={l.id} className="card approval">
            <div className="card-b">
              <div className="row">
                <span className="pill hold">Needs you</span>
                <span className="hint">#{l.id} · {new Date(l.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div className="amount">{money(l.amount)}</div>
              <div className="what">{describe(l)}{ticket ? ` · from “${ticket.subject}”` : ""}</div>
              {l.justification && <div className="reason"><b>Agent's reason:</b> {l.justification}</div>}
            </div>
            <Checks checks={l.checks.filter((c) => c.outcome !== "pass").concat(l.checks.filter((c) => c.outcome === "pass"))} />
            <ReviewNote review={l.review} />
            <div className="card-b" style={{ paddingTop: 0 }}>
              <div className="actions">
                <button className="btn go" disabled={busy !== null} onClick={() => act(l.id, "approve")}>{busy === l.id ? "Sending to PayPal…" : `Approve ${money(l.amount)}`}</button>
                <button className="btn" disabled={busy !== null} onClick={() => act(l.id, "decline")}>Decline</button>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>Approving runs exactly this action with these parameters, once.</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
