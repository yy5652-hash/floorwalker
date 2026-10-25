import { ArrowDownLeft, ArrowRight, Clock3, ShieldCheck, Sparkles } from "lucide-react";
import { agentName, amountOf, money, relativeTime, why, type LedgerEntry, type Metrics, type PageProps, type State, personName, plural } from "../api";
import { ApprovalCard } from "../components/Approvals";
import { EmptyState, OutcomeIcon } from "../components/UI";
import { AgentCard } from "./Agents";

const outcomes: { key: keyof Metrics["funnel"]; label: string; color: string }[] = [
  { key: "auto", label: "Auto-approved", color: "#059669" }, { key: "approved", label: "Approved by you", color: "#60A5FA" },
  { key: "declined", label: "Declined", color: "#FB7185" }, { key: "waiting", label: "Waiting", color: "#FBBF24" }, { key: "blocked", label: "Blocked", color: "#DC2626" },
];
function activity(e: LedgerEntry, state: State) {
  const name = agentName(state, e.agent_id), who = personName(e.counterparty), value = money(amountOf(e));
  if (e.status === "awaiting_approval") return `Waiting for you: ${e.kind} of ${value} to ${who}`;
  if (e.status === "blocked") return `${name}'s ${value} ${e.kind} to ${who} was blocked`;
  if (e.status === "declined") return `You declined ${name}'s ${value} ${e.kind} to ${who}`;
  if (e.status === "failed") return `${name}'s ${value} ${e.kind} to ${who} failed`;
  if (e.status === "executing") return `${name}'s ${value} ${e.kind} to ${who} is processing`;
  return `${name} ${e.kind === "refund" ? "refunded" : "paid"} ${who} ${value}${e.status === "approved" ? " · approved by you" : ""}`;
}
export function Overview(props: PageProps & { reset: () => void; resetting: boolean }) {
  const { state } = props, m = state.metrics;
  const waiting = state.ledger.filter(e => e.status === "awaiting_approval");
  const total = Object.values(m.funnel).reduce((a, b) => a + b, 0);
  const metrics = [
    { key: "moved", label: "Moved by your agents", value: money(m.moved), sub: plural(m.movedCount, "refund or payout", "refunds and payouts"), icon: ArrowDownLeft, tone: "allow" },
    { key: "waiting", label: "Waiting for you", value: money(m.waiting), sub: plural(m.waitingCount, "request to review", "requests to review"), icon: Clock3, tone: "hold" },
    { key: "stopped", label: "Stopped before PayPal", value: money(m.stopped), sub: `${m.stoppedCount} blocked or declined`, icon: ShieldCheck, tone: "block" },
    { key: "auto", label: "Done without you", value: m.automationRate === null ? "—" : `${Math.round(m.automationRate * 100)}%`, sub: m.medianApprovalMinutes === null ? "No approvals yet" : `Median approval ${Math.round(m.medianApprovalMinutes)} min`, icon: Sparkles, tone: "blue" },
  ];
  return <div className="page-stack overview"><div className="metrics">{metrics.map(({ key, label, value, sub, icon: Icon, tone }) => <div className="card metric" key={key} data-film={`metric-${key}`}><div className="metric-top"><span>{label}</span><Icon size={17} className={`text-${tone}`} /></div><div className={`metric-value ${key === "waiting" && m.waitingCount ? "text-hold" : ""}`}>{value}</div>{key === "waiting" ? <a className="metric-sub" href="/app#approvals">{sub}<ArrowRight size={13} /></a> : <span className="metric-sub">{sub}</span>}</div>)}</div>
    <section className="card outcome-card"><div className="section-heading"><h2>Every request, accounted for</h2><span className="hint">{total} decisions</span></div><div className="outcome-bar" role="img" aria-label={outcomes.map(o => `${o.label}: ${m.funnel[o.key]}`).join(", ")}>{outcomes.map(o => m.funnel[o.key] > 0 && <span key={o.key} style={{ width: `${m.funnel[o.key] / total * 100}%`, background: o.color }} />)}</div><div className="outcome-legend">{outcomes.map(o => <span key={o.key}><i style={{ background: o.color }} />{o.label}<strong>{m.funnel[o.key]}</strong></span>)}</div></section>
    {!state.tickets.length && <div className="card demo-empty"><div><h3>Meet your demo shop</h3><p>Load Juniper &amp; Oak Ceramics to see your agents handle real sandbox requests.</p></div><button className="btn primary" disabled={props.resetting || !state.configured.paypal} onClick={props.reset}>{props.resetting ? "Creating sandbox orders…" : "Load the demo shop"}</button><a className="text-link" href="/app#setup">Setup <ArrowRight size={14} /></a></div>}
    <section><div className="section-heading"><h2>Needs you <span className="count">{waiting.length}</span></h2><a className="text-link" href="/app#approvals">All approvals <ArrowRight size={14} /></a></div>{waiting.length ? <div className="compact-approvals">{waiting.slice(0, 3).map(entry => <ApprovalCard key={entry.id} {...props} entry={entry} compact />)}</div> : <div className="card caught-up"><ShieldCheck size={23} /><div><strong>You're all caught up</strong><span>Your agents will ask when a request needs your attention.</span></div></div>}</section>
    <section><div className="section-heading"><h2>Your agents</h2><a className="text-link" href="/app#agents">Manage agents <ArrowRight size={14} /></a></div><div className="agents-grid">{state.agents.map(agent => <AgentCard key={agent.id} {...props} agent={agent} compact />)}</div></section>
    <section className="card activity-card"><div className="card-h"><h2>Recent activity</h2><a className="text-link" href="/app#ledger">View ledger <ArrowRight size={14} /></a></div>{state.ledger.length ? state.ledger.slice(0, 8).map(e => <a key={e.id} href={`/app#ledger/${e.id}`} className="activity-row"><OutcomeIcon status={e.status} /><div className="activity-content"><strong>{activity(e, state)}</strong><div className="activity-detail"><span>{why(e)}</span>{e.paypal_ref && <code>{e.paypal_ref}</code>}</div></div><time dateTime={e.created_at}>{relativeTime(e.created_at)}</time><ArrowRight size={14} className="activity-arrow" /></a>) : <EmptyState title="Your agents' work will appear here"><a className="text-link" href="/app#inbox">Start with an inbox item <ArrowRight size={14} /></a></EmptyState>}</section>
  </div>;
}
