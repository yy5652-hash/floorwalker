import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Check, Pause, Play, X } from "lucide-react";
import { useRef, useState } from "react";
import {
  errorMessage,
  money,
  post,
  relativeTime,
  type Agent,
  type PageProps,
} from "../api";
import { ConnectAgent, EmptyState } from "../components/UI";
export function AgentCard({
  agent,
  compact = false,
  refresh,
  notify,
}: Pick<PageProps, "refresh" | "notify"> & {
  agent: Agent;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const frozen = agent.status === "frozen";
  const percent = agent.budget
    ? Math.min(
        100,
        Math.max(
          0,
          agent.budget.amount > 0
            ? (agent.spent / agent.budget.amount) * 100
            : agent.spent > 0
              ? 100
              : 0,
        ),
      )
    : 0;
  async function toggle() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await post(
        `/api/agents/${encodeURIComponent(agent.id)}/${frozen ? "unfreeze" : "freeze"}`,
      );
      await refresh();
      notify(
        `${agent.name} ${frozen ? "unfrozen" : "frozen — can't move money"}.`,
      );
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <Card
      className={`min-w-0 gap-0 py-0 shadow-xs   space-y-5 p-5   ${compact ? "compact" : ""}`}
      data-film={`agent-${agent.id}`}
    >
      <div className="flex flex-wrap items-center gap-3 [&>div]:min-w-0 [&>div]:flex-1 [&_p]:mt-1 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-muted-foreground">
        <Avatar className="size-10 rounded-xl">
          <AvatarFallback className="rounded-xl text-xs">
            {agent.name
              .split(/[ -]/)
              .filter(Boolean)
              .slice(0, 2)
              .map((s) => s[0])
              .join("")}
          </AvatarFallback>
        </Avatar>
        <div>
          <h3>{agent.name}</h3>
          <p>
            {compact
              ? frozen
                ? "Frozen"
                : "Active · governed by your rules"
              : agent.role}
          </p>
        </div>
        <Button
          className={`   ml-auto h-8 px-2.5 text-xs   ${frozen ? "" : "text-block hover:bg-destructive/10"}`}
          data-film={`freeze-${agent.id}`}
          disabled={busy}
          onClick={() => void toggle()}
          aria-label={`${frozen ? "Unfreeze" : "Freeze"} ${agent.name}`}
          aria-pressed={frozen}
          variant="outline"
          type="button"
        >
          {frozen ? <Play size={13} /> : <Pause size={13} />}
          {busy ? "Saving…" : frozen ? "Unfreeze" : "Freeze"}
        </Button>
      </div>
      {frozen && (
        <div className="frozen-banner rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs font-medium text-hold">
          Frozen — can't move money
        </div>
      )}
      {!compact && (
        <div className="permissions flex flex-wrap gap-3 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:rounded-md [&>span]:border [&>span]:px-2 [&>span]:py-1 [&>span]:text-xs [&>span]:text-muted-foreground">
          <span>
            Refunds{" "}
            <span className="sr-only">
              {agent.can_refund ? "allowed" : "not allowed"}
            </span>{" "}
            {agent.can_refund ? <Check size={13} /> : <X size={13} />}
          </span>
          <span>
            Payouts{" "}
            <span className="sr-only">
              {agent.can_payout ? "allowed" : "not allowed"}
            </span>{" "}
            {agent.can_payout ? <Check size={13} /> : <X size={13} />}
          </span>
        </div>
      )}
      {agent.budget ? (
        <div className="space-y-3 [&>div:first-child]:flex [&>div:first-child]:justify-between [&>div:first-child]:gap-2 [&>div:first-child]:text-xs [&>div:first-child]:text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
          <div>
            <span>
              <strong>{money(agent.spent)}</strong> of{" "}
              {money(agent.budget.amount)} this {agent.budget.period}
            </span>
            <span>{Math.round(percent)}%</span>
          </div>
          <Progress
            value={percent}
            aria-label={`${agent.name} allowance used`}
            className={`h-2 ${percent >= 100 ? "[&>div]:bg-destructive" : "[&>div]:bg-emerald-600 dark:[&>div]:bg-emerald-400"}`}
          />
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          No shared allowance assigned
        </p>
      )}
      {!compact && (
        <>
          <div className="grid grid-cols-3 gap-2 border-t pt-4 [&_strong]:block [&_strong]:text-xl [&_strong]:font-medium [&_strong]:tabular-nums [&_span]:mt-1 [&_span]:block [&_span]:text-[10px] [&_span]:text-muted-foreground">
            <div>
              <strong>{agent.metrics.funnel.auto}</strong>
              <span>Done on its own</span>
            </div>
            <div>
              <strong>{agent.metrics.funnel.approved}</strong>
              <span>Approved by you</span>
            </div>
            <div>
              <strong>{agent.metrics.funnel.blocked}</strong>
              <span>Blocked</span>
            </div>
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground border-t pt-3">
            Last activity · {relativeTime(agent.last)}
          </div>
        </>
      )}
    </Card>
  );
}
export function Agents(props: PageProps) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Each agent only gets the tools its job needs, and can never raise its
        own limits.
      </p>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {props.state.agents.length ? (
          props.state.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} {...props} />
          ))
        ) : (
          <Card className="col-span-full">
            <EmptyState title="No agents connected">
              <p>Connect an MCP client below to get started.</p>
            </EmptyState>
          </Card>
        )}
      </div>
      <Card className="min-w-0 gap-0 py-0 shadow-xs space-y-4 p-5">
        <ConnectAgent notify={props.notify} />
      </Card>
    </div>
  );
}
