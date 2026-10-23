import { useState } from "react";
import { modelName, money, post, type Policy, type State } from "../api";

function get(p: any, path: string) {
  return path.split(".").reduce((o, k) => o?.[k], p);
}

function Limit({ k, path, policy, base, fmt = money }: { k: string; path: string; policy: Policy; base: Policy; fmt?: (v: any) => string }) {
  const v = get(policy, path);
  const changed = JSON.stringify(v) !== JSON.stringify(get(base, path));
  return (
    <div className={`limit ${changed ? "changed" : ""}`}>
      <div className="k">{k}</div>
      <div className="v">{fmt(v)}</div>
    </div>
  );
}

function PolicyView({ policy, base }: { policy: Policy; base: Policy }) {
  const per = (b: { amount: number; period: string }) => `${money(b.amount)} / ${b.period}`;
  return (
    <>
      <div className="section-t">Refunds</div>
      <div className="limits">
        <Limit k="On its own up to" path="refunds.auto_approve_up_to" policy={policy} base={base} />
        <Limit k="Never above" path="refunds.hard_limit" policy={policy} base={base} />
        <Limit k="Allowance" path="refunds.budget" policy={policy} base={base} fmt={per} />
        <Limit k="Order age" path="refunds.max_order_age_days" policy={policy} base={base} fmt={(v) => `${v} days`} />
        <Limit k="Per customer / 30 d" path="refunds.max_refunds_per_customer_30d" policy={policy} base={base} fmt={(v) => String(v)} />
        <Limit k="Only the buyer" path="refunds.requester_must_be_buyer" policy={policy} base={base} fmt={(v) => (v ? "Yes" : "No")} />
      </div>
      <div className="section-t">Payouts</div>
      <div className="limits">
        <Limit k="On its own up to" path="payouts.auto_approve_up_to" policy={policy} base={base} />
        <Limit k="Never above" path="payouts.hard_limit" policy={policy} base={base} />
        <Limit k="Allowance" path="payouts.budget" policy={policy} base={base} fmt={per} />
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead><tr style={{ textAlign: "left", color: "var(--muted)" }}><th>Payee</th><th>Email</th><th>Role</th><th style={{ textAlign: "right" }}>Per 30 days</th></tr></thead>
        <tbody>
          {policy.payouts.payees.map((p) => (
            <tr key={p.email} style={{ borderTop: "1px solid var(--line)" }}>
              <td style={{ padding: "6px 0", fontWeight: 500 }}>{p.name}</td><td className="mono">{p.email}</td><td>{p.role}</td><td style={{ textAlign: "right" }}>{money(p.monthly_limit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hint" style={{ marginTop: 6 }}>Anyone else: {policy.payouts.unknown_payee === "block" ? "blocked" : "asks you"}.</div>
      <div className="section-t">Invoices</div>
      <div className="limits">
        <Limit k="On its own up to" path="invoices.auto_approve_up_to" policy={policy} base={base} />
        <Limit k="Max discount" path="invoices.max_discount_percent" policy={policy} base={base} fmt={(v) => `${v}%`} />
      </div>
      <div className="section-t">Guidance for the reviewer</div>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{policy.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </>
  );
}

export function Rules({ state, refresh, notify }: { state: State; refresh: () => void; notify: (s: string) => void }) {
  const active = state.policy.policy;
  const [text, setText] = useState(state.policy.text);
  const [preview, setPreview] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function compile() {
    setBusy(true);
    setError("");
    try {
      setPreview((await post<{ policy: Policy }>("/api/policy/compile", { text })).policy);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    await post("/api/policy", { text, policy: preview });
    setPreview(null);
    notify("New rules are active. The next money move is checked against them.");
    refresh();
  }

  return (
    <div className="rules">
      <div className="card">
        <div className="card-h"><h2>Your rules, in your words</h2></div>
        <div className="card-b">
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy || !state.configured.ai} onClick={compile}>{busy ? `${modelName(state.configured)} is reading…` : "Turn into rules"}</button>
            <span className="hint">{modelName(state.configured)} turns this into the limits on the right. Nothing changes until you activate it.</span>
          </div>
          {error && <p className="err">{error}</p>}
        </div>
      </div>
      <div className="card">
        <div className="card-h">
          <h2>{preview ? "Preview" : "Active rules"}</h2>
          {preview && <span className="pill hold">Not active yet</span>}
          <span style={{ flex: 1 }} />
          {preview && <button className="btn" onClick={() => setPreview(null)}>Discard</button>}
          {preview && <button className="btn go" onClick={activate}>Activate</button>}
        </div>
        <div className="card-b">
          <PolicyView policy={preview ?? active} base={active} />
          {preview && <p className="hint">Highlighted values differ from the active rules.</p>}
        </div>
      </div>
    </div>
  );
}
