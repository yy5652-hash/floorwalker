import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Minus } from "lucide-react";
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
  money,
  personName,
  post,
  STATUS_LABEL,
  type PageProps,
  type State,
} from "../api";
import { emptyLearnedRules, useLearnedRules } from "../hooks/use-learned-rules";

function Requests({ ids, state }: { ids: number[]; state: State }) {
  const rows = new Map(state.ledger.map((row) => [row.id, row]));
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">
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
                    {new Date(row.created_at).toLocaleDateString()}
                  </time>
                </TableCell>
                <TableCell>{personName(row.counterparty)}</TableCell>
                <TableCell className="tabular-nums">
                  {money(amountOf(row))}
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
      className="space-y-4"
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
          className="gap-3 p-5"
          role="status"
          aria-label="Loading suggestions"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-16 w-full" />
          <span className="sr-only">Loading suggestions…</span>
        </Card>
      ) : query.isError ? (
        <Card className="gap-3 p-5">
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
            <Card key={change.id} className="min-w-0 gap-4 p-5 shadow-xs">
              <div className="space-y-2">
                <h3 className="font-semibold">{change.title}</h3>
                <p className="text-sm">{change.evidence}</p>
                {change.boundary && (
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Minus size={14} className="shrink-0" aria-hidden="true" />
                    {change.boundary}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 [&>[data-slot=badge]]:whitespace-normal">
                <Badge variant="secondary">
                  Saves {change.impact.tapsSaved} taps
                </Badge>
                <Badge variant="secondary">
                  Taps per 100: {change.impact.tapsPer100.before} →{" "}
                  {change.impact.tapsPer100.after}
                </Badge>
                <Badge variant="secondary">
                  {money(change.impact.moreAutoUsd)} more done without you
                </Badge>
                <Badge variant="outline" className="text-allow">
                  <Check aria-hidden="true" />
                  {change.impact.declinedLetThrough} requests you declined would
                  go through
                </Badge>
                {change.impact.bench && (
                  <Badge variant="outline" className="text-allow">
                    <Check aria-hidden="true" />
                    Attacks still stopped: {change.impact.bench.stopped}/
                    {change.impact.bench.attacks}
                  </Badge>
                )}
              </div>
              <Requests ids={change.rows} state={state} />
              {actions({ kind: "apply", id: change.id }, change.id, "Apply")}
            </Card>
          ))}
          {note && (
            <Card className="min-w-0 gap-4 p-5 shadow-xs">
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
            <Card className="p-5 text-sm text-muted-foreground">
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
