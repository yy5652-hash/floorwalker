import { useEffect, useRef, useState } from "react";
import { api, canManage, errorMessage, money, type Agent, type PageProps, type TrustLevel, type TrustPreview } from "../api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const levels: { id: TrustLevel; label: string }[] = [
  { id: "ask", label: "Ask every time" },
  { id: "small", label: "Small amounts on its own" },
  { id: "rules", label: "Everything the rules allow" },
];
const levelOf = (cap: number | null | undefined): TrustLevel => cap == null ? "rules" : cap === 0 ? "ask" : "small";
const labelOf = (cap: number | null | undefined) => cap == null ? "Everything the rules allow" : cap === 0 ? "Ask every time" : `Small amounts on its own, up to ${money(cap)}`;

export function AgentTrust({ agent, state, refresh, notify }: Pick<PageProps, "state" | "refresh" | "notify"> & { agent: Agent }) {
  const [level, setLevel] = useState<TrustLevel>(() => levelOf(agent.max_per_action));
  const [amount, setAmount] = useState(String(agent.max_per_action && agent.max_per_action > 0 ? agent.max_per_action : 40));
  const [saved, setSaved] = useState(agent.max_per_action ?? null);
  const [preview, setPreview] = useState<TrustPreview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const proposals = state.ledger.filter(entry => entry.agent_id === agent.id).map(entry => `${entry.id}:${entry.status}:${entry.decision}:${entry.approved_amount}`).join("|");
  const value = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
  const cap = level === "ask" ? 0 : level === "rules" ? null : value;
  useEffect(() => {
    setLevel(levelOf(agent.max_per_action)); setSaved(agent.max_per_action ?? null);
    if (agent.max_per_action && agent.max_per_action > 0) setAmount(String(agent.max_per_action));
  }, [agent.id, agent.max_per_action]);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setError("");
    if (!valid) return;
    void api<TrustPreview>(`/api/agents/${encodeURIComponent(agent.id)}/trust-preview?amount=${value}`, "GET", undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setPreview(data); })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [agent.id, state.workspace?.id, proposals, value, valid, retry]);
  async function save() {
    if (lock.current || !canManage(state) || (level === "small" && !valid) || cap === saved) return;
    lock.current = true; setBusy(true); setNotice("");
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}`, "PATCH", { max_per_action: cap });
      const message = `${agent.name}: ${labelOf(saved)} → ${labelOf(cap)}. Saved.`;
      setSaved(cap); setNotice(message); notify(message);
      try { await refresh(); } catch { setNotice(`${message} The page could not refresh; reload to check the latest state.`); }
    } catch (e) { setNotice(`Not saved: ${errorMessage(e)}`); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="agent-trust" aria-label={`${agent.name} trust level`}>
    <div className="trust-heading"><h4>Trust level</h4><span>Rules and budgets still apply</span></div>
    <fieldset disabled={!canManage(state) || busy}>
      <legend className="sr-only">Trust level for {agent.name}</legend>
      <div className="trust-levels">
        {levels.map(item => <label key={item.id} data-selected={level === item.id}>
          <input type="radio" name={`trust-${agent.id}`} value={item.id} checked={level === item.id} onChange={() => { setLevel(item.id); setNotice(""); }} />
          <span>{item.label}</span>
          <small>{preview ? preview.levels[item.id].moves ? `${preview.levels[item.id].tapsPer100} taps / 100 · ${money(preview.levels[item.id].autoUsd)} without you` : "No history in the last 90 days" : "—"}</small>
        </label>)}
      </div>
      <div className="trust-save">
        <label htmlFor={`trust-amount-${agent.id}`}>Small-amount limit · USD</label>
        <Input id={`trust-amount-${agent.id}`} type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} aria-invalid={!valid} onChange={e => { setAmount(e.target.value); setNotice(""); }} />
        <Button size="sm" disabled={cap === saved || (level === "small" && !valid)} onClick={() => void save()}>{busy ? "Saving…" : "Save trust level"}</Button>
      </div>
    </fieldset>
    {!valid && <p className="text-xs text-destructive">Enter a positive USD amount with at most two decimal places.</p>}
    <div className="trust-preview" aria-live="polite">
      {error ? <p role="alert">Preview unavailable: {error} <Button size="sm" variant="link" onClick={() => setRetry(n => n + 1)}>Retry preview</Button></p>
        : !preview ? <p>{valid ? "Loading the last 90 days…" : "Enter a valid limit to preview."}</p>
        : preview.levels[level].moves === 0 ? <p>No proposals in the last 90 days. There is no history to estimate the impact.</p>
        : <p><strong>{preview.levels[level].tapsPer100} taps per 100</strong> · <strong>{money(preview.levels[level].autoUsd)}</strong> done without you at this level, replaying {preview.levels[level].moves} proposals from the last 90 days. Existing holds and blocks remain.</p>}
    </div>
    {!canManage(state) && <p className="text-xs text-muted-foreground">Only owners and admins can change trust levels.</p>}
    {notice && <p role="status" className="text-xs">{notice}</p>}
  </section>;
}
