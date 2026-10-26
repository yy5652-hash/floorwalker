import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  relativeTime,
  why,
  type LedgerEntry,
  type Metrics,
  type PageProps,
  type State,
  personName,
  plural,
} from "../api";
import { ApprovalCard } from "../components/Approvals";
import { EmptyState, OutcomeIcon } from "../components/UI";
import { AgentCard } from "./Agents";
const outcomes: {
  key: keyof Metrics["funnel"];
  label: string;
  color: string;
}[] = [
  { key: "auto", label: "Auto-approved", color: "#059669" },
  { key: "approved", label: "Approved by you", color: "#10B981" },
  { key: "declined", label: "Declined", color: "#FB7185" },
  { key: "waiting", label: "Waiting", color: "#FBBF24" },
  { key: "blocked", label: "Blocked", color: "#DC2626" },
];
function activity(e: LedgerEntry, state: State) {
  const name = agentName(state, e.agent_id),
    who = personName(e.counterparty),
    value = money(amountOf(e));
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
export function Overview(
  props: PageProps & {
    reset: () => void;
    resetting: boolean;
  },
) {
  const { state } = props,
    m = state.metrics;
  const waiting = state.ledger.filter((e) => e.status === "awaiting_approval");
  const total = Object.values(m.funnel).reduce((a, b) => a + b, 0);
  const metrics = [
    {
      key: "moved",
      label: "Moved by your agents",
      value: money(m.moved),
      sub: plural(m.movedCount, "refund or payout", "refunds and payouts"),
      icon: ArrowDownLeft,
      tone: "allow",
    },
    {
      key: "waiting",
      label: "Waiting for you",
      value: money(m.waiting),
      sub: plural(m.waitingCount, "request to review", "requests to review"),
      icon: Clock3,
      tone: "hold",
    },
    {
      key: "stopped",
      label: "Stopped before PayPal",
      value: money(m.stopped),
      sub: `${m.stoppedCount} blocked or declined`,
      icon: ShieldCheck,
      tone: "block",
    },
    {
      key: "auto",
      label: "Done without you",
      value:
        m.automationRate === null
          ? "—"
          : `${Math.round(m.automationRate * 100)}%`,
      sub:
        m.medianApprovalMinutes === null
          ? "No approvals yet"
          : `Median approval ${Math.round(m.medianApprovalMinutes)} min`,
      icon: Sparkles,
      tone: "foreground",
    },
  ];
  return (
    <div className="flex flex-col gap-6 overview">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ key, label, value, sub, icon: Icon, tone }) => (
          <Card
            className="min-w-0 gap-0 py-0 shadow-xs p-5"
            key={key}
            data-film={`metric-${key}`}
          >
            <div className="flex items-center justify-between gap-3 text-xs font-medium text-muted-foreground">
              <span>{label}</span>
              <Icon size={17} className={`text-${tone}`} />
            </div>
            <div
              className={`my-3 text-3xl font-semibold tracking-tight tabular-nums   ${key === "waiting" && m.waitingCount ? "text-hold" : ""}`}
            >
              {value}
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
      <Card className="min-w-0 gap-0 py-0 shadow-xs p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>Every request, accounted for</h2>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {total} decisions
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
                    width: `${(m.funnel[o.key] / total) * 100}%`,
                    background: o.color,
                  }}
                />
              ),
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-3 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:text-xs [&>span]:text-muted-foreground [&_i]:size-2 [&_i]:rounded-sm [&_strong]:font-medium [&_strong]:text-foreground [&_strong]:tabular-nums">
          {outcomes.map((o) => (
            <span key={o.key}>
              <i style={{ background: o.color }} />
              {o.label}
              <strong>{m.funnel[o.key]}</strong>
            </span>
          ))}
        </div>
      </Card>
      {!state.tickets.length && (
        <Card className="min-w-0 gap-0 py-0 shadow-xs flex flex-wrap items-center gap-4 p-5 [&>div]:flex-1 [&_p]:mt-2 [&_p]:text-muted-foreground">
          <div>
            <h3>Meet your demo shop</h3>
            <p>
              Load Juniper &amp; Oak Ceramics to see your agents handle real
              sandbox requests.
            </p>
          </div>
          <Button
            disabled={props.resetting || !state.configured.paypal}
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
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2">
          <h2>
            Needs you{" "}
            <Badge className="tabular-nums" variant="secondary">
              {waiting.length}
            </Badge>
          </h2>
          <a
            className="inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
            href="/app#approvals"
          >
            All approvals <ArrowRight size={14} />
          </a>
        </div>
        {waiting.length ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {waiting.slice(0, 3).map((entry) => (
              <ApprovalCard key={entry.id} {...props} entry={entry} compact />
            ))}
          </div>
        ) : (
          <Card className="min-w-0 gap-0 py-0 shadow-xs flex flex-row items-center gap-4 p-5 [&>svg]:text-allow [&_strong]:block [&_span]:mt-1 [&_span]:block [&_span]:text-xs [&_span]:text-muted-foreground">
            <ShieldCheck size={23} />
            <div>
              <strong>You're all caught up</strong>
              <span>
                Your agents will ask when a request needs your attention.
              </span>
            </div>
          </Card>
        )}
      </section>
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
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {state.agents.map((agent) => (
            <AgentCard key={agent.id} {...props} agent={agent} compact />
          ))}
        </div>
      </section>
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
                  {e.paypal_ref && <code>{e.paypal_ref}</code>}
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
