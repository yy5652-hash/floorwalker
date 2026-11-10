import { useRef, useState } from "react";
import { StartChecklist } from "./Setup";
import { MoneyChart } from "../components/MoneyChart";
import { canManage } from "../api";
import { TapsChart } from "../components/TapsChart";
import { isFilm } from "../auth";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowDownLeft,
  ArrowRight,
  Clock3,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  agentName,
  amountOf,
  money,
  moneyTotals,
  entryCurrency,
  relativeTime,
  why,
  type LedgerEntry,
  type Metrics,
  type PageProps,
  type State,
  personName,
  plural,
  streamEvents,
  errorMessage,
  type GuardEvent,
} from "../api";
import { useIncidents } from "../hooks/use-incidents";
import { EmptyState, OutcomeIcon, Money } from "../components/UI";
import { AgentCard } from "./Agents";
const outcomes: {
  key: keyof Metrics["funnel"];
  label: string;
  color: string;
}[] = [
  { key: "auto", label: "Auto-approved", color: "var(--chart-1)" },
  { key: "approved", label: "Approved by you", color: "var(--chart-2)" },
  { key: "declined", label: "Declined by you", color: "var(--chart-5)" },
  { key: "waiting", label: "Waiting", color: "var(--chart-3)" },
  { key: "blocked", label: "Blocked by Floorwalker", color: "var(--chart-4)" },
];
function activity(e: LedgerEntry, state: State) {
  const name = agentName(state, e.agent_id),
    who = personName(e.counterparty),
    value = money(amountOf(e), entryCurrency(e));
  if (e.status === "awaiting_approval")
    return `Waiting for you: ${e.kind} of ${value} to ${who}`;
  if (e.status === "blocked")
    return `${name}'s ${value} ${e.kind} to ${who} was blocked`;
  if (e.status === "declined")
    return `You declined ${name}'s ${value} ${e.kind} to ${who}`;
  if (e.status === "failed")
    return `${name}'s ${value} ${e.kind} to ${who} failed`;
  if (e.status === "executing")
    return `${name}'s ${value} ${e.kind} to ${who} is processing`;
  return `${name} ${e.kind === "refund" ? "refunded" : "paid"} ${who} ${value}${e.status === "approved" ? " · approved by you" : ""}`;
}
const scopes = ["This session", "Example history"] as const;
const inScope = (row: LedgerEntry, scope: typeof scopes[number]) => (row.source === "history") === (scope === "Example history");

// Same metrics as the workspace overview, calculated separately for each source.
export function overviewMetrics(rows: LedgerEntry[], scope: typeof scopes[number]) {
  rows = rows.filter(row => inScope(row, scope));
  const by = (status: LedgerEntry["status"]) => rows.filter(row => row.status === status);
  const auto = by("executed"), approved = by("approved"), declined = by("declined"), waiting = by("awaiting_approval"), blocked = by("blocked");
  const decided = [...approved, ...declined].filter(row => row.decided_at).map(row => (Date.parse(row.decided_at!) - Date.parse(row.created_at)) / 60000).sort((a, b) => a - b);
  const reachable = auto.length + approved.length + declined.length + waiting.length;
  return { auto, approved, declined, waiting, blocked, automationRate: reachable ? auto.length / reachable : null,
    medianApprovalMinutes: decided.length ? decided[Math.floor(decided.length / 2)] : null,
    funnel: { auto: auto.length, approved: approved.length, declined: declined.length, waiting: waiting.length, blocked: blocked.length } };
}

const demoRequests = [
  { id: "T1", title: "Maya's chipped mug", hint: "Runs automatically" },
  { id: "T2", title: "Daniel's wrong-colour bowl", hint: "Waits for you" },
  { id: "T5", title: "Jordan's email with hidden instructions", hint: "Blocked by Floorwalker" },
];
const resultLabel: Record<LedgerEntry["status"], string> = { executed: "Done automatically", approved: "Approved by you", awaiting_approval: "Waiting for you", blocked: "Blocked by Floorwalker", declined: "Declined by you", executing: "Processing in PayPal", failed: "Failed" };

function DemoRequests({ state, refresh }: PageProps) {
  const [dismissed, setDismissed] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, GuardEvent[]>>({});
  const pending = useRef(false);
  const rowsFor = (id: string) => {
    const rows = state.ledger.filter(row => row.ticket_id === id);
    return rows.length ? rows : (results[id] ?? []).map(row => ({ id: row.ledgerId, status: row.status, amount: row.amount, currency: state.policy.policy.currency }));
  };
  async function run(id: string) {
    if (pending.current || rowsFor(id).length) return;
    pending.current = true; setRunning(id); setProgress("Reading the request…");
    setErrors(current => ({ ...current, [id]: "" }));
    let recorded = false, failure = "";
    try {
      await streamEvents(`/api/tickets/${id}/run`, event => {
        if (event.type === "tool_call") setProgress(event.guarded ? "Checking the proposed move…" : "Reading PayPal records…");
        if (event.type === "guard") {
          recorded = true;
          setResults(current => ({ ...current, [id]: [...(current[id] ?? []).filter(row => row.ledgerId !== event.ledgerId), event] }));
          setProgress(resultLabel[event.status]);
        }
        if (event.type === "error") failure = event.message;
      });
      if (failure) setErrors(current => ({ ...current, [id]: failure }));
      else if (!recorded) setErrors(current => ({ ...current, [id]: "No money request was recorded. Check the inbox for details." }));
    } catch (error) { setErrors(current => ({ ...current, [id]: errorMessage(error) })); }
    finally {
      try { await refresh(); } catch { setErrors(current => ({ ...current, [id]: "Couldn't refresh the ledger. Open it to check the latest outcome." })); }
      pending.current = false; setRunning(null);
    }
  }
  if (dismissed) return null;
  const complete = demoRequests.every(request => rowsFor(request.id).length > 0) && !running;
  return <Card className="gap-4 p-5">
    <div className="flex items-center justify-between gap-3"><h2>Try these three requests</h2><Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>Dismiss</Button></div>
    <p className="text-sm text-muted-foreground">This session · PayPal sandbox. Expected paths below; results come from each run.</p>
    <div className="grid gap-3 md:grid-cols-3">{demoRequests.map(request => {
      const ticket = state.tickets.find(ticket => ticket.id === request.id), rows = rowsFor(request.id);
      return <div key={request.id} className="flex flex-col gap-3 rounded-lg border p-4">
        <h3>{request.title}</h3><p className="text-sm text-muted-foreground">{request.hint}</p>
        {!rows.length && <Button type="button" variant="outline" disabled={!!running || !ticket || ticket.status !== "open" || !canManage(state) || !state.configured.paypal || !state.configured.ai || state.agents.find(agent => agent.id === "support")?.status === "frozen"} onClick={() => void run(request.id)}>{running === request.id ? "Running…" : "Try request"}</Button>}
        {running === request.id && <p className="text-sm" role="status">{progress}</p>}
        {rows.map(row => <a key={row.id} className="text-sm underline underline-offset-4" href={`/app#ledger/${row.id}`}>{resultLabel[row.status]} · {money(row.amount, row.currency)} · #{row.id}</a>)}
        {errors[request.id] && <p className="text-sm text-block" role="alert">{errors[request.id]}</p>}
        {!ticket && <p className="text-sm text-muted-foreground">Load the demo shop to try this request.</p>}
      </div>;
    })}</div>
    {complete && <div className="flex flex-wrap gap-4 text-sm underline underline-offset-4"><a href="#ledger">Inspect the ledger</a><a href="#rules">See a suggested rule change</a><a href="#watch">Test a PayPal bypass</a></div>}
  </Card>;
}

export function Overview(
  props: PageProps & {
    reset: () => void;
    resetting: boolean;
  },
) {
  const { state } = props;
  const waiting = state.ledger.filter((e) => e.status === "awaiting_approval");
  const incidentsQuery = useIncidents(state);
  const incidents = (incidentsQuery.data?.incidents ?? state.incidents ?? []).filter(i => !i.resolved_at);
  const scoped = scopes.filter(scope => scope === "This session" || state.ledger.some(row => inScope(row, scope))).map(scope => {
    const m = overviewMetrics(state.ledger, scope);
    return { scope, m, metrics: [
      { key: "moved", label: "Moved by your agents", value: moneyTotals([...m.auto, ...m.approved], state.policy.policy.currency), sub: plural(m.auto.length + m.approved.length, "refund or payout", "refunds and payouts"), icon: ArrowDownLeft, tone: "allow" },
      { key: "waiting", label: "Waiting for you", value: moneyTotals(m.waiting, state.policy.policy.currency), sub: plural(m.waiting.length, "request to review", "requests to review"), icon: Clock3, tone: "hold" },
      { key: "blocked", label: "Blocked by Floorwalker", value: moneyTotals(m.blocked, state.policy.policy.currency), sub: plural(m.blocked.length, "request", "requests"), icon: ShieldCheck, tone: "block" },
      { key: "declined", label: "Declined by you", value: moneyTotals(m.declined, state.policy.policy.currency), sub: plural(m.declined.length, "request", "requests"), icon: ShieldCheck, tone: "block" },
      { key: "auto", label: "Done without you", value: m.automationRate === null ? "—" : `${Math.round(m.automationRate * 100)}%`, sub: m.medianApprovalMinutes === null ? "No approvals yet" : `Median approval ${Math.round(m.medianApprovalMinutes)} min`, icon: Sparkles, tone: "foreground" },
    ] };
  });
  return (
    <div className="flex flex-col gap-6 overview">
      {state.workspace?.demo && <DemoRequests key={state.workspace.id} {...props} />}
      <StartChecklist state={state} />
      <section className="overview-attention" aria-labelledby="attention-title">
        <div className="section-heading"><h2 id="attention-title">What needs you now</h2><span>{waiting.length + incidents.length ? "Your next decisions" : "All caught up"}</span></div>
        <div className="attention-links">
          <a href="/app#approvals"><strong>{waiting.filter(row => row.source !== "history").length}</strong><span>requests waiting · this session{waiting.some(row => row.source === "history") && ` (+${waiting.filter(row => row.source === "history").length} from example history)`} <ArrowRight size={16} /></span></a>
          <a href="/app#watch"><strong>{incidents.length}</strong><span>active incidents · this session <ArrowRight size={16} /></span></a>
        </div>
        {incidentsQuery.isError && <p role="status">Couldn't refresh incidents. Showing the last available records.</p>}
        {!!incidents.length && <div className="attention-incidents">{incidents.slice(0, 2).map(incident => <a key={incident.id} href="/app#watch"><span className="text-block">Needs review</span> {incident.detail} <ArrowRight size={14} /></a>)}</div>}
        {!!waiting.length && <div className="attention-requests">{waiting.slice(0, 3).map(entry => <a key={entry.id} href={`/app#approvals/${entry.id}`}><span>{personName(entry.counterparty)}</span><strong>{money(entry.amount, entryCurrency(entry))}</strong><span>{agentName(state, entry.agent_id)}</span><ArrowRight size={14} /></a>)}</div>}
      </section>
      <TapsChart state={state} />
      {scoped.map(({ scope, m, metrics }) => <section key={scope} className="flex flex-col gap-6" aria-label={scope}>
      <section className="overview-money" aria-label={`Money outcomes · ${scope}`}>
      <h2 className="mb-3">{scope}</h2>
      {scope === "Example history" && <p className="mb-3 text-sm text-muted-foreground">Simulated requests · not sent to PayPal</p>}
      <div className="overview-metrics lg:!grid-cols-5">
        {metrics.map(({ key, label, value, sub, icon: Icon, tone }) => (
          <Card
            className="min-w-0 gap-0 py-0 shadow-xs p-5"
            key={key}
            data-film={`metric-${key}`}
          >
            <div className="metric-label flex items-center justify-between gap-3">
              <span>{label}</span>
              <Icon size={17} className={`text-${tone}`} />
            </div>
            <div
              className="metric-value flex flex-wrap items-baseline gap-2"
            >
              <Money value={value} /><span className="text-xs font-normal text-muted-foreground">{scope}</span>
            </div>
            {key === "waiting" ? (
              <a
                className="flex items-center gap-2 text-xs text-muted-foreground"
                href="/app#approvals"
              >
                {sub}
                <ArrowRight size={13} />
              </a>
            ) : (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {sub}
              </span>
            )}
          </Card>
        ))}
      </div>
      </section>
      <Card className="overview-funnel min-w-0 gap-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>Every request, accounted for</h2>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {Object.values(m.funnel).reduce((a, b) => a + b, 0)} decisions · {scope}
          </span>
        </div>
        <div
          className="flex h-2.5 gap-1 overflow-hidden rounded-full bg-muted [&>span]:min-w-1 [&>span]:rounded-sm"
          role="img"
          aria-label={outcomes
            .map((o) => `${o.label}: ${m.funnel[o.key]}`)
            .join(", ")}
        >
          {outcomes.map(
            (o) =>
              m.funnel[o.key] > 0 && (
                <span
                  key={o.key}
                  style={{
                    width: `${(m.funnel[o.key] / Math.max(1, Object.values(m.funnel).reduce((a, b) => a + b, 0))) * 100}%`,
                    background: o.color,
                  }}
                />
              ),
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:text-xs [&>span]:text-muted-foreground [&_i]:size-2 [&_i]:rounded-sm [&_strong]:font-medium [&_strong]:text-foreground">
          {outcomes.map((o) => (
            <span key={o.key}>
              <i style={{ background: o.color }} />
              {o.label}
              <strong>{m.funnel[o.key]}</strong>
            </span>
          ))}
        </div>
      </Card>
      </section>)}
      {!state.tickets.length && (state.workspace?.demo || isFilm()) && (
        <Card className="min-w-0 gap-0 py-0 shadow-xs flex flex-wrap items-center gap-4 p-5 [&>div]:flex-1 [&_p]:mt-2 [&_p]:text-muted-foreground">
          <div>
            <h3>Meet your demo shop</h3>
            <p>
              Load Juniper &amp; Oak Ceramics to see your agents handle real
              sandbox requests.
            </p>
          </div>
          <Button
            disabled={!canManage(state) || props.resetting || !state.configured.paypal}
            title={!canManage(state) ? "Only owners and admins can load the demo shop." : !state.configured.paypal ? "PayPal isn't configured on this server." : undefined}
            onClick={props.reset}
            variant="default"
            type="button"
          >
            {props.resetting
              ? "Creating sandbox orders…"
              : "Load the demo shop"}
          </Button>
          <a
            className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
            href="/app#setup"
          >
            Setup <ArrowRight size={14} />
          </a>
        </Card>
      )}
      <MoneyChart state={state} />
      <div className="overview-workbench">
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>Your agents</h2>
          <a
            className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
            href="/app#agents"
          >
            Manage agents <ArrowRight size={14} />
          </a>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">Budget figures: This session{state.ledger.some(row => row.source === "history") ? " + Example history (simulated)" : ""}.</p>
        <div className="grid grid-cols-1 gap-4">
          {state.agents.map((agent) => (
            <AgentCard key={agent.id} {...props} agent={agent} compact />
          ))}
        </div>
      </section>
      </div>
      <Card className="min-w-0 gap-0 py-0 shadow-xs activity-card">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>Recent activity</h2>
          <a
            className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
            href="/app#ledger"
          >
            View ledger <ArrowRight size={14} />
          </a>
        </CardHeader>
        {state.ledger.length ? (
          state.ledger.slice(0, 8).map((e) => (
            <a
              key={e.id}
              href={`/app#ledger/${e.id}`}
              className="flex items-center gap-3 border-b px-5 py-4 last:border-0 hover:bg-muted/50 [&>time]:ml-auto [&>time]:hidden [&>time]:shrink-0 sm:[&>time]:block"
            >
              <OutcomeIcon status={e.status} />
              <div className="min-w-0 flex-1 [&>strong]:block [&>strong]:text-sm [&>strong]:font-medium">
                <strong>{activity(e, state)}</strong>
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground [&>span]:truncate [&>code]:hidden xl:[&>code]:block">
                  <span>{why(e)}</span>
                  {e.source === "history" ? (
                    <span>Example history · simulated, not sent to PayPal</span>
                  ) : <><span>This session</span>{e.paypal_ref && <code>{e.paypal_ref}</code>}</>}
                </div>
              </div>
              <time dateTime={e.created_at}>{relativeTime(e.created_at)}</time>
              <ArrowRight size={14} className="text-muted-foreground" />
            </a>
          ))
        ) : (
          <EmptyState title="Your agents' work will appear here">
            <a
              className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
              href="/app#inbox"
            >
              Start with an inbox item <ArrowRight size={14} />
            </a>
          </EmptyState>
        )}
      </Card>
    </div>
  );
}
