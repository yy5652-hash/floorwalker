import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  amountOf,
  canManage,
  errorMessage,
  entryCurrency,
  money,
  personName,
  post,
  STATUS_LABEL,
  type PageProps,
  type State,
  type LearnedRules,
  type LedgerEntry,
} from "../api";
import { emptyLearnedRules, useLearnedRules } from "../hooks/use-learned-rules";

function Requests({ ids, state }: { ids: number[]; state: State }) {
  const rows = new Map(state.ledger.map((row) => [row.id, row]));
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="min-h-11 cursor-pointer py-3">
        Show the {ids.length} requests
      </summary>
      <Table className="mt-3 text-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Counterparty</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ids.map((id) => {
            const row = rows.get(id);
            return row ? (
              <TableRow key={id}>
                <TableCell>
                  <time dateTime={row.created_at}>
                    {new Date(row.created_at).toLocaleDateString("en-US")}
                  </time>
                </TableCell>
                <TableCell><a className="inline-flex min-h-11 items-center underline" href={`/app#ledger/${id}`}>#{id} · {personName(row.counterparty)}</a></TableCell>
                <TableCell className="tabular-nums">
                  {money(amountOf(row), entryCurrency(row))}
                </TableCell>
                <TableCell>
                  {STATUS_LABEL[row.status]}
                  {row.source === "history" && (
                    <Badge
                      variant="secondary"
                      className="ml-2 text-muted-foreground"
                    >
                      Demo history
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              <TableRow key={id}>
                <TableCell colSpan={4}>
                  Request #{id} is not in the current ledger.
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </details>
  );
}

type Action = { kind: "apply" | "dismiss"; id: string } | { kind: "note" };

type LearnedChange = LearnedRules["changes"][number];
export function LearningComparison({ change, state, compact = false, entry }: {
  change: LearnedChange; state: State; compact?: boolean; entry?: LedgerEntry;
}) {
  const active = state.policy.policy;
  const draft = change.draft;
  const currency = draft.currency ?? active.currency ?? "USD";
  const changes: { label: string; before: string; after: string }[] = [];
  for (const kind of ["refunds", "payouts"] as const) {
    const label = kind === "refunds" ? "Refund" : "Payout";
    if (active[kind].auto_approve_up_to !== draft[kind].auto_approve_up_to) changes.push({ label: `${label} automatic limit`, before: money(active[kind].auto_approve_up_to, currency), after: money(draft[kind].auto_approve_up_to, currency) });
    if (active[kind].budget.amount !== draft[kind].budget.amount || active[kind].budget.period !== draft[kind].budget.period) changes.push({ label: `${label} budget`, before: `${money(active[kind].budget.amount, currency)} / ${active[kind].budget.period}`, after: `${money(draft[kind].budget.amount, currency)} / ${draft[kind].budget.period}` });
  }
  for (const payee of draft.payouts.payees) {
    const before = active.payouts.payees.find(p => p.email === payee.email);
    if (before && before.monthly_limit !== payee.monthly_limit) changes.push({ label: `${payee.name} monthly limit`, before: money(before.monthly_limit, currency), after: money(payee.monthly_limit, currency) });
  }
  // The API provides boundary wording, not an id. Link only matching recorded declines.
  const boundaryAmount = change.boundary?.match(/\$([\d,.]+)/)?.[1];
  const boundaryRows = boundaryAmount ? state.ledger.filter(row => row.status === "declined" && row.amount === Number(boundaryAmount.replaceAll(",", "")) && ((row.kind === "refund" && active.refunds.auto_approve_up_to !== draft.refunds.auto_approve_up_to) || (row.kind === "payout" && active.payouts.auto_approve_up_to !== draft.payouts.auto_approve_up_to))) : [];
  const remainingHolds = entry?.checks.filter(c => {
    if (c.outcome === "pass" || ["auto_limit", "ai_review"].includes(c.id)) return false;
    if (c.id === "budget" && (entry.kind === "refund" || entry.kind === "payout")) {
      const kind = entry.kind === "refund" ? "refunds" : "payouts";
      return active[kind].budget.amount === draft[kind].budget.amount && active[kind].budget.period === draft[kind].budget.period;
    }
    if (c.id === "payee_limit") return active.payouts.payees.find(p => p.email === entry.counterparty)?.monthly_limit === draft.payouts.payees.find(p => p.email === entry.counterparty)?.monthly_limit;
    return true;
  }) ?? [];
  return <div className={`space-y-4 ${compact ? "text-sm" : ""}`}>
    <section className="space-y-1">
      <h4 className="font-semibold">What changes</h4>
      {changes.length ? changes.map(row => <p key={row.label}>{row.label}: <strong>{row.before} → {row.after}</strong></p>) : <p>{change.title}</p>}
    </section>
    <section className="space-y-2">
      <h4 className="font-semibold">Why</h4>
      <p>{change.evidence}</p>
      <div className="flex flex-wrap gap-x-3">
        {change.rows.slice(0, compact ? 3 : 5).map(id => <a key={id} className="inline-flex min-h-11 items-center underline" href={`/app#ledger/${id}`}>Supporting approval #{id}{state.ledger.find(row => row.id === id)?.source === "history" ? " · Demo history" : ""}</a>)}
      </div>
      {change.boundary && <p>{change.boundary} {boundaryRows.map(row => <a key={row.id} className="inline-flex min-h-11 items-center underline mr-3" href={`/app#ledger/${row.id}`}>Declined boundary #{row.id}{row.source === "history" ? " · Demo history" : ""}</a>)}{!boundaryRows.length && <span className="text-muted-foreground">The boundary request is not in the current ledger.</span>}</p>}
      <Requests ids={change.rows} state={state} />
    </section>
    <section className="space-y-2">
      <h4 className="font-semibold">What would have changed</h4>
      <p className="text-xs text-muted-foreground">Replay using recorded facts and AI reviews</p>
      <dl className="learning-backtest">
        <div><dt>Taps per 100 money moves</dt><dd>{change.impact.tapsPer100.before} → {change.impact.tapsPer100.after}</dd></div>
        <div><dt>Approvals avoided in replay</dt><dd>{change.impact.tapsSaved}</dd></div>
        {!compact && <div><dt>More automatic in replay</dt><dd>{money(change.impact.moreAutoUsd, currency)}</dd></div>}
        <div><dt>Declined requests that would pass</dt><dd>{change.impact.declinedLetThrough}</dd></div>
      </dl>
      {change.impact.bench && <p className="text-xs">Recorded benchmark replay: {change.impact.bench.stopped} / {change.impact.bench.attacks} attacks stopped.{change.impact.bench.rulesBefore !== undefined && change.impact.bench.rulesAfter !== undefined && ` Rules alone: ${change.impact.bench.rulesBefore} → ${change.impact.bench.rulesAfter}.`}</p>}
      <p className="text-xs text-muted-foreground">This replay does not rerun the {change.impact.bench?.attacks ?? 80} attacks live. It reuses recorded AI reviews; future outcomes can differ.</p>
    </section>
    <section className="space-y-1">
      <h4 className="font-semibold">What stays in force</h4>
      <p>Budgets still apply: refunds {money(draft.refunds.budget.amount, currency)} / {draft.refunds.budget.period}; payouts {money(draft.payouts.budget.amount, currency)} / {draft.payouts.budget.period}. Other limits, buyer and payee checks, and AI review still apply.</p>
      {remainingHolds.length > 0 && <p className="text-hold">Other recorded holds stay in force: {remainingHolds.map(c => c.label).join(", ")}. This change does not clear them.</p>}
    </section>
    <section className="space-y-1">
      <h4 className="font-semibold">Who applies it</h4>
      <p>You apply this as a new policy version. You can roll back in Versions.</p>
    </section>
  </div>;
}

export function LearnedRulesPanel({ state, notify }: PageProps) {
  const query = useLearnedRules(state);
  const { changes, note } = query.data ?? emptyLearnedRules;
  const client = useQueryClient();
  const permitted = canManage(state);
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      if (!permitted) throw new Error("You need permission to update rules.");
      if (action.kind === "dismiss") {
        await post("/api/rules/learned/dismiss", { id: action.id });
        return null;
      }
      return post<State["policy"]>(
        `/api/rules/learned/${action.kind}`,
        action.kind === "note" ? {} : { id: action.id },
      );
    },
    onSuccess: async (saved) => {
      if (saved) notify(`Rules updated (version ${saved.id})`);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["learned-rules"] }),
        client.invalidateQueries({ queryKey: ["state"] }),
      ]);
    },
    onError: (error) => notify(errorMessage(error)),
  });
  const disabled = !permitted || mutation.isPending;
  const actions = (action: Action, id: string, label: string) => (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          data-film="apply"
          disabled={disabled}
          onClick={() => mutation.mutate(action)}
        >
          {label}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => mutation.mutate({ kind: "dismiss", id })}
        >
          Not now
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        You can roll back any time in Versions.
      </p>
    </div>
  );
  return (
    <section
      className="c1-learned space-y-4"
      aria-labelledby="learned-rules-heading"
      aria-busy={query.isPending || mutation.isPending}
    >
      <div className="space-y-2">
        <h2 id="learned-rules-heading">Learned from your decisions</h2>
        <p className="text-sm text-muted-foreground">
          Changes your own approvals support, each tested on your history before
          you see it.
        </p>
      </div>
      {query.isPending ? (
        <Card
          className="c1-learned-item gap-3"
          role="status"
          aria-label="Loading suggestions"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-16 w-full" />
          <span className="sr-only">Loading suggestions…</span>
        </Card>
      ) : query.isError ? (
        <Card className="c1-learned-item gap-3">
          <p role="alert" className="text-sm text-block">
            Couldn't load suggestions. {errorMessage(query.error)}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </Card>
      ) : (
        <>
          {changes.map((change) => (
            <Card key={change.id} data-film={`learned-${change.id.split("=")[0]}`} className="learned-card c1-learned-item">
              <h3 className="font-semibold">{change.title}</h3>
              <LearningComparison change={change} state={state} />
              {!change.impact.bench && <p className="text-xs text-muted-foreground">No benchmark result available for this suggestion.</p>}
              {actions({ kind: "apply", id: change.id }, change.id, "Apply as new version")}
            </Card>
          ))}
          {note && (
            <Card className="c1-learned-item min-w-0 gap-4">
              <h3 className="font-semibold">Guidance for the AI reviewer</h3>
              <blockquote className="border-l-2 pl-3 text-sm">
                “{note.note}”
              </blockquote>
              <p className="text-xs text-muted-foreground">
                Based on {note.rows.length} requests you declined
              </p>
              <Requests ids={note.rows} state={state} />
              {actions({ kind: "note" }, `note:${note.note}`, "Add to rules")}
            </Card>
          )}
          {!changes.length && !note && (
            <Card className="c1-learned-item text-sm text-muted-foreground">
              Nothing to change yet. Floorwalker suggests a change after you've
              approved at least three similar requests.
            </Card>
          )}
        </>
      )}
      {mutation.isError && (
        <p role="alert" className="text-sm text-block">
          {errorMessage(mutation.error)}
        </p>
      )}
    </section>
  );
}

export function LearnedRulesNudge({ state }: { state: State }) {
  const { data } = useLearnedRules(state);
  if (!data?.changes.length) return null;
  const taps = data.changes.reduce(
    (sum, change) => sum + change.impact.tapsSaved,
    0,
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/40 px-4 py-3">
      <p className="text-sm">
        You keep approving the same kind of request. Floorwalker can save you{" "}
        {taps} taps.
      </p>
      <Button asChild size="sm" variant="outline">
        <a href="#rules">See suggestions</a>
      </Button>
    </div>
  );
}
