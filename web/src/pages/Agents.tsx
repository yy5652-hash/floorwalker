import { isFilm } from "../auth";
import { api, canManage } from "../api";
import {
  Confirm,
  Field,
  Toggle,
  selectClass,
  useTask,
  Modal,
} from "../components/Management";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button as ActionButton } from "@/components/ui/button";
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
const manageHint = "Only owners and admins can manage agents.";
export function AgentCard({
  agent,
  compact = false,
  state,
  onEdit,
  refresh,
  notify,
}: Pick<PageProps, "refresh" | "notify" | "state"> & {
  agent: Agent;
  compact?: boolean;
  onEdit?: (agent: Agent) => void;
}) {
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const frozen = agent.status === "frozen";
  const allowance =
    typeof agent.budget === "number"
      ? { amount: agent.budget, period: agent.budget_period ?? "month" }
      : agent.budget;
  const percent = allowance
    ? Math.min(
        100,
        Math.max(
          0,
          allowance.amount > 0
            ? (agent.spent / allowance.amount) * 100
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
      className={`min-w-0 gap-0 py-0 shadow-xs   agent-card space-y-5 p-5   ${compact ? "compact" : ""}`}
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
          disabled={busy || !canManage(state)}
          title={canManage(state) ? undefined : manageHint}
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
        <div className="frozen-banner rounded-lg border border-hold/20 bg-hold/10 px-3 py-2 text-xs font-medium text-hold">
          Frozen — can't move money
        </div>
      )}
      {!compact && (
        <div className="permissions flex flex-wrap gap-5 [&>span]:flex [&>span]:items-center [&>span]:gap-2 [&>span]:text-xs [&>span]:text-muted-foreground">
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
      {!compact && !isFilm() && (
        <p className="text-xs leading-6 text-muted-foreground">
          {[
            agent.max_per_action
              ? `Up to ${money(agent.max_per_action)} per ${agent.can_refund && !agent.can_payout ? "refund" : "action"}`
              : "Workspace action limits apply",
            agent.expires_at
              ? `until ${new Date(agent.expires_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
              : null,
            agent.payees
              ? `Payees: ${JSON.parse(agent.payees).join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {allowance ? (
        <div className="space-y-3 [&>div:first-child]:flex [&>div:first-child]:justify-between [&>div:first-child]:gap-2 [&>div:first-child]:text-xs [&>div:first-child]:text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
          <div>
            <span>
              <strong>{money(agent.spent)}</strong> of {money(allowance.amount)}{" "}
              {isFilm()
                ? "this"
                : typeof agent.budget === "number"
                  ? "per"
                  : "shared /"}{" "}
              {allowance.period}
            </span>
            <span>{Math.round(percent)}%</span>
          </div>
          <Progress
            value={percent}
            aria-label={`${agent.name} allowance used`}
            className={`h-2 ${percent >= 100 ? "[&>div]:bg-destructive" : "[&>div]:bg-allow"}`}
          />
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          No shared allowance assigned
        </p>
      )}
      {!compact && (
        <>
          {!isFilm() && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canManage(state)}
                title={canManage(state) ? undefined : manageHint}
                onClick={() => onEdit?.(agent)}
              >
                Edit agent
              </Button>
              {canManage(state) && (
                <Button
                  variant="link"
                  size="sm"
                  disabled={!canManage(state)}
                  asChild
                >
                  <a
                    href={`/app#developers/keys/new/${encodeURIComponent(agent.id)}`}
                  >
                    Create a key for this agent
                  </a>
                </Button>
              )}
            </div>
          )}
          <div className="grid grid-cols-3 gap-2 border-t pt-4 [&_strong]:block [&_strong]:text-xl [&_strong]:font-medium [&_span]:mt-1 [&_span]:block [&_span]:text-xs [&_span]:text-muted-foreground">
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
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  return (
    <div className="flex flex-col gap-6">
      {!isFilm() && (
        <div className="flex flex-wrap justify-between gap-3">
          <Button
            disabled={!canManage(props.state)}
            title={canManage(props.state) ? undefined : manageHint}
            onClick={() => setEditing("new")}
          >
            New agent
          </Button>
          <FreezeAll {...props} />
        </div>
      )}
      {editing && (
        <AgentEditor
          key={editing === "new" ? "new" : editing.id}
          agent={editing === "new" ? undefined : editing}
          {...props}
          close={() => setEditing(null)}
        />
      )}
      <p className="text-sm text-muted-foreground">
        Each agent only gets the tools its job needs, and can never raise its
        own limits.
      </p>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {props.state.agents.length ? (
          props.state.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              {...props}
              onEdit={setEditing}
            />
          ))
        ) : (
          <Card className="col-span-full">
            <EmptyState title="No agents connected">
              <p>
                Create an agent, then issue a key to connect it over the API or
                MCP.
              </p>
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
export function FreezeAll({ state, refresh, notify }: PageProps) {
  const [open, setOpen] = useState(false);
  const { busy, run } = useTask();
  return (
    <>
      <Button
        data-film="freeze-all"
        variant="outline"
        disabled={
          !canManage(state) || !state.agents.some((a) => a.status === "active")
        }
        title={
          !canManage(state)
            ? manageHint
            : state.agents.some((a) => a.status === "active")
              ? undefined
              : "Every agent is already frozen."
        }
        onClick={() => setOpen(true)}
      >
        <Pause className="size-4" />
        Freeze all
      </Button>
      <Modal
        title="Freeze all agents?"
        description="Every active agent will stop initiating money movements. Requests already executing may finish. You can unfreeze agents individually."
        open={open}
        onClose={() => !busy && setOpen(false)}
      >
        <Button
          disabled={busy}
          variant="destructive"
          onClick={() =>
            void run(async () => {
              const result = await api<{ frozen: number }>(
                "/api/agents/freeze-all",
                "POST",
              );
              await refresh();
              setOpen(false);
              notify(`${result.frozen} agents frozen`);
            })
          }
        >
          Freeze all agents
        </Button>
      </Modal>
    </>
  );
}
function AgentEditor({
  agent,
  close,
  refresh,
  notify,
}: PageProps & { agent?: Agent; close: () => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [refund, setRefund] = useState(!!agent?.can_refund);
  const [payout, setPayout] = useState(!!agent?.can_payout);
  const [cap, setCap] = useState(agent?.max_per_action?.toString() ?? "");
  const [budgetMode, setBudgetMode] = useState(
    typeof agent?.budget === "number" ? "custom" : agent ? "keep" : "none",
  );
  const [budget, setBudget] = useState(
    typeof agent?.budget === "number" ? String(agent.budget) : "",
  );
  const [period, setPeriod] = useState(agent?.budget_period ?? "month");
  const [payees, setPayees] = useState<string[]>(
    agent?.payees ? JSON.parse(agent.payees) : [],
  );
  const [email, setEmail] = useState("");
  const [expires, setExpires] = useState(agent?.expires_at?.slice(0, 10) ?? "");
  const [deleteError, setDeleteError] = useState("");
  const { busy, run } = useTask();
  function addPayee() {
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      notify("Enter a valid payee email.");
      return;
    }
    setPayees([...new Set([...payees, value])]);
    setEmail("");
  }
  const form = (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim()) {
          notify("Add or clear the pending payee email before saving.");
          return;
        }
        void run(
          async () => {
            const controls = {
              name: name.trim(),
              role,
              can_refund: refund,
              can_payout: payout,
              max_per_action: cap ? Number(cap) : null,
              ...(budgetMode === "keep"
                ? {}
                : {
                    budget: budgetMode === "custom" ? Number(budget) : null,
                    budget_period: budgetMode === "custom" ? period : null,
                  }),
              payees: payees.length ? payees : null,
              expires_at: expires
                ? new Date(`${expires}T23:59:59Z`).toISOString()
                : null,
            };
            await api(
              agent
                ? `/api/agents/${encodeURIComponent(agent.id)}`
                : "/api/agents",
              agent ? "PATCH" : "POST",
              controls,
            );
            await refresh();
            close();
          },
          agent ? "Agent updated" : "Agent created",
        );
      }}
    >
      <fieldset disabled={busy} className="space-y-5">
        <Field label="Agent name">
          <Input
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Job description">
          <Input
            maxLength={200}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Handles customer refunds"
          />
        </Field>
        <div className="divide-y rounded-lg border px-4">
          <Toggle label="Refunds" checked={refund} onChange={setRefund} />
          <Toggle label="Payouts" checked={payout} onChange={setPayout} />
        </div>
        <Field
          label="Cap per action (USD)"
          hint="Leave blank to use workspace limits."
        >
          <Input
            type="number"
            step="0.01"
            min="0.01"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </Field>
        <Field
          label="Agent's own budget"
          hint={
            agent
              ? "Keep your existing independent budget, set a new one, or remove it. Workspace limits always apply."
              : "An additional limit on top of workspace rules."
          }
        >
          <select
            className={selectClass}
            value={budgetMode}
            onChange={(e) => setBudgetMode(e.target.value)}
          >
            {agent && <option value="keep">Keep existing budget</option>}
            <option value="none">No independent budget</option>
            <option value="custom">Set independent budget</option>
          </select>
        </Field>
        {budgetMode === "custom" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Budget (USD)">
              <Input
                type="number"
                required
                min="0.01"
                step="0.01"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            <Field label="Period">
              <select
                className={selectClass}
                value={period}
                onChange={(e) => setPeriod(e.target.value as typeof period)}
              >
                {["day", "week", "month"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
          </div>
        )}
        {payout && (
          <div className="space-y-3">
            <Field
              label="Allowed payee emails"
              hint="An empty list leaves payees governed by workspace rules."
            >
              <div className="flex gap-2">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPayee();
                    }
                  }}
                  placeholder="payee@example.com"
                />
                <ActionButton
                  type="button"
                  variant="outline"
                  onClick={addPayee}
                >
                  Add
                </ActionButton>
              </div>
            </Field>
            <div className="flex flex-wrap gap-2">
              {payees.map((p) => (
                <span
                  key={p}
                  className="flex max-w-full items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs"
                >
                  <span className="break-all">{p}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${p}`}
                    onClick={() => setPayees(payees.filter((v) => v !== p))}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        <Field
          label="End date (optional)"
          hint="Agent access expires at the end of this date in UTC."
        >
          <Input
            type="date"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </Field>
        <Button
          disabled={!name.trim()}
          title={name.trim() ? undefined : "Give the agent a name first."}
        >
          {busy ? "Saving…" : agent ? "Save agent" : "Create agent"}
        </Button>
      </fieldset>
      {agent && (
        <div className="space-y-3 border-t pt-4">
          <Confirm
            title="Delete this agent?"
            description="Agents with payment history cannot be deleted. Freeze an agent to stop future requests."
            label="Delete agent"
            done="Agent deleted"
            closeOnError
            onConfirm={async () => {
              try {
                await api(
                  `/api/agents/${encodeURIComponent(agent.id)}`,
                  "DELETE",
                );
                await refresh();
                close();
              } catch (e) {
                setDeleteError(errorMessage(e));
                throw e;
              }
            }}
          >
            Delete agent
          </Confirm>
          {deleteError && (
            <div
              role="alert"
              className="space-y-3 rounded-lg border border-destructive/30 p-3"
            >
              <p className="text-sm text-destructive">{deleteError}</p>
              <Button
                type="button"
                variant="outline"
                disabled={busy || agent.status === "frozen"}
                onClick={() =>
                  void run(async () => {
                    await api(
                      `/api/agents/${encodeURIComponent(agent.id)}/freeze`,
                      "POST",
                    );
                    await refresh();
                    close();
                  }, "Agent frozen")
                }
              >
                Freeze instead
              </Button>
            </div>
          )}
        </div>
      )}
    </form>
  );
  return agent ? (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v && !busy) close();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit {agent.name}</SheetTitle>
          <SheetDescription>
            Limits are enforced before any money moves.
          </SheetDescription>
        </SheetHeader>
        <div className="px-5 pb-6">{form}</div>
      </SheetContent>
    </Sheet>
  ) : (
    <Modal
      title="New agent"
      description="Give it only the permissions and limits its job needs."
      open
      onClose={() => !busy && close()}
    >
      {form}
    </Modal>
  );
}
