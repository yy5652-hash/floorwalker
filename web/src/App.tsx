import { useCallback, useEffect, useState } from "react";
import { getState, modelName, money, post, type State } from "./api";
import { Approvals } from "./components/Approvals";
import { Inbox } from "./components/Inbox";
import { Ledger } from "./components/Ledger";
import { Rules } from "./components/Rules";

type Tab = "inbox" | "approvals" | "ledger" | "rules";

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [tab, setTab] = useState<Tab>("inbox");
  const [toast, setToast] = useState("");
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(() => {
    getState().then(setState).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const notify = useCallback((s: string) => {
    setToast(s);
    setTimeout(() => setToast(""), 6000);
  }, []);

  async function reset() {
    setResetting(true);
    try {
      await post("/api/demo/reset");
      notify("Fresh sandbox orders created and the demo inbox is loaded.");
    } catch (e: any) {
      notify(e.message);
    } finally {
      setResetting(false);
      refresh();
    }
  }

  if (!state) return null;
  const s = state.stats;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" width={28} height={28} alt="" />
          Allowance <small>Give your AI agent an allowance, not your wallet.</small>
        </div>
        <span className="spacer" />
        <span className="status-chip"><span className={`dot ${state.configured.paypal ? "on" : ""}`} />PayPal sandbox</span>
        <span className="status-chip"><span className={`dot ${state.configured.ai ? "on" : ""}`} />{modelName(state.configured)}</span>
        <button className="btn ghost-dark" disabled={resetting || !state.configured.paypal} onClick={reset}>{resetting ? "Creating orders…" : "Reset demo"}</button>
      </header>
      <nav className="tabs">
        {(["inbox", "approvals", "ledger", "rules"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "inbox" ? "Inbox" : t === "approvals" ? "Approvals" : t === "ledger" ? "Ledger" : "Rules"}
            {t === "approvals" && s.awaiting > 0 && <span className="badge">{s.awaiting}</span>}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span className="hint" style={{ alignSelf: "center" }}>Juniper &amp; Oak Ceramics · support agent on {state.configured.agentModel}</span>
      </nav>
      <main>
        <section className="kpis">
          <div className="kpi"><div className="label">Moved by the agent</div><div className="value">{money(s.moved)}</div><div className="sub">refunds and payouts in PayPal</div></div>
          <div className="kpi"><div className="label">Done on its own</div><div className="value">{s.autoApproved}</div><div className="sub">inside your allowance</div></div>
          <div className="kpi"><div className="label">Waiting for you</div><div className="value" style={{ color: s.awaiting ? "var(--hold)" : undefined }}>{s.awaiting}</div><div className="sub">one tap to approve</div></div>
          <div className="kpi"><div className="label">Stopped</div><div className="value" style={{ color: s.stopped ? "var(--block)" : undefined }}>{money(s.stopped)}</div><div className="sub">{s.blocked} blocked before reaching PayPal</div></div>
        </section>
        {tab === "inbox" && <Inbox state={state} refresh={refresh} notify={notify} />}
        {tab === "approvals" && <Approvals state={state} refresh={refresh} notify={notify} />}
        {tab === "ledger" && <Ledger state={state} />}
        {tab === "rules" && <Rules state={state} refresh={refresh} notify={notify} />}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
