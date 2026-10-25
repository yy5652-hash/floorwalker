import { Check, Pause, Play, X } from "lucide-react";
import { useRef, useState } from "react";
import { errorMessage, money, post, relativeTime, type Agent, type PageProps } from "../api";
import { ConnectAgent } from "../components/UI";

export function AgentCard({ agent, compact = false, refresh, notify }: Pick<PageProps, "refresh" | "notify"> & { agent: Agent; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const frozen = agent.status === "frozen";
  const percent = agent.budget ? Math.min(100, Math.max(0, agent.budget.amount > 0 ? agent.spent / agent.budget.amount * 100 : agent.spent > 0 ? 100 : 0)) : 0;
  async function toggle() {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try { await post(`/api/agents/${encodeURIComponent(agent.id)}/${frozen ? "unfreeze" : "freeze"}`); await refresh(); notify(`${agent.name} ${frozen ? "unfrozen" : "frozen — can't move money"}.`); }
    catch (e) { notify(errorMessage(e)); }
    finally { locked.current = false; setBusy(false); }
  }
  return <article className={`card agent-card ${compact ? "compact" : ""}`} data-film={`agent-${agent.id}`}>
    <div className="agent-header"><span className={`avatar ${agent.can_payout ? "purple" : ""}`}>{agent.name.split(/[ -]/).filter(Boolean).slice(0, 2).map(s => s[0]).join("")}</span><div><h3>{agent.name}</h3><p>{compact ? (frozen ? "Frozen" : "Active · governed by your rules") : agent.role}</p></div><button className={`btn freeze-btn ${frozen ? "" : "danger"}`} data-film={`freeze-${agent.id}`} disabled={busy} onClick={() => void toggle()} aria-label={`${frozen ? "Unfreeze" : "Freeze"} ${agent.name}`} aria-pressed={frozen}>{frozen ? <Play size={13} /> : <Pause size={13} />}{busy ? "Saving…" : frozen ? "Unfreeze" : "Freeze"}</button></div>
    {frozen && <div className="frozen-banner">Frozen — can't move money</div>}
    {!compact && <div className="permissions"><span>Refunds {agent.can_refund ? <Check size={13} /> : <X size={13} />}</span><span>Payouts {agent.can_payout ? <Check size={13} /> : <X size={13} />}</span></div>}
    {agent.budget ? <div className="allowance"><div><span><strong>{money(agent.spent)}</strong> of {money(agent.budget.amount)} this {agent.budget.period}</span><span>{Math.round(percent)}%</span></div><div className="progress" role="progressbar" aria-label={`${agent.name} allowance used`} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span className={percent >= 100 ? "full" : ""} style={{ width: `${percent}%` }} /></div></div> : <p className="hint">No shared allowance assigned</p>}
    {!compact && <><div className="agent-stats"><div><strong>{agent.metrics.funnel.auto}</strong><span>Done on its own</span></div><div><strong>{agent.metrics.funnel.approved}</strong><span>Approved by you</span></div><div><strong>{agent.metrics.funnel.blocked}</strong><span>Blocked</span></div></div><div className="hint agent-last">Last activity · {relativeTime(agent.last)}</div></>}
  </article>;
}
export function Agents(props: PageProps) {
  return <div className="page-stack"><p className="intro">Each agent only gets the tools its job needs, and can never raise its own limits.</p><div className="agents-grid">{props.state.agents.map(agent => <AgentCard key={agent.id} agent={agent} {...props} />)}</div><div className="card card-b"><ConnectAgent notify={props.notify} /></div></div>;
}
