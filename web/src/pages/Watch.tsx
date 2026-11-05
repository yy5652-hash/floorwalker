import { isFilm } from "../auth";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useTheme } from "../components/theme-provider";
import { lightTheme, darkTheme } from "../components/grid-theme";
import { IncidentBanner, frozenAgentIds } from "../components/IncidentBanner";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  api, canManage, errorMessage, personName, post, relativeTime,
  type BypassResult, type Incident, type State,
} from "../api";
import { money } from "../lib/money";
import { useIncidents, useRefreshIncidents } from "../hooks/use-incidents";
import { Confirm, Resource, Toggle } from "../components/Management";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";


const columns = (currency: string): ColDef<Incident>[] => [
  { field: "created_at", headerName: "Opened", width: 170,
    valueFormatter: ({ value }) => new Date(value).toLocaleString("en-US") },
  { field: "kind", headerName: "Kind", width: 100,
    valueFormatter: ({ value }) => value === "refund" ? "Refund" : "Payout" },
  { field: "amount", headerName: "Amount", width: 115,
    valueFormatter: ({ value, data }) => money(value, (data as (Incident & { currency?: string }) | undefined)?.currency ?? currency), cellClass: "tabular-nums font-medium" },
  { field: "counterparty", headerName: "Who", minWidth: 160, flex: 1,
    valueFormatter: ({ value }) => value ? personName(value) : "—" },
  { field: "paypal_ref", headerName: "PayPal reference", width: 220, cellClass: "font-mono text-xs" },
  { field: "detected_by", headerName: "Found by", width: 230,
    valueFormatter: ({ value }) => value === "webhook" ? "PayPal webhook" : "Checking your orders in PayPal" },
  { field: "resolution", headerName: "Status", width: 140,
    valueFormatter: ({ data }) => !data?.resolved_at ? "Open" : data.resolution === "mine" ? "That was me" : "Not me" },
  { field: "resolved_by", headerName: "Resolved by", width: 160,
    valueFormatter: ({ value }) => value ?? "—" },
];
const defaultColDef: ColDef<Incident> = {
  sortable: true, resizable: true, tooltipValueGetter: ({ valueFormatted, value }) => valueFormatted ?? value,
};


export function Watch({ state }: { state: State }) {
  const currency = state.policy.policy.currency ?? "USD";
  const query = useIncidents(state);
  const { resolvedTheme } = useTheme();
  const refresh = useRefreshIncidents();
  const [checking, setChecking] = useState(false);
  const onError = (error: unknown) => toast.error(errorMessage(error));
  const sweep = useMutation({
    mutationFn: () => post<{ orders: number; refunds: number; incidents: Incident[] }>("/api/incidents/sweep"),
    onSuccess: (result) => toast.success(`${result.orders} orders, ${result.refunds} refunds checked`),
    onError, onSettled: refresh, retry: false,
  });
  const settings = useMutation({
    mutationFn: (freeze: boolean) => api("/api/incidents/settings", "PATCH", { freeze }),
    onError, onSettled: refresh, retry: false,
  });
  const bypass = useMutation({
    mutationFn: () => post<BypassResult>("/api/demo/bypass"),
    onMutate: () => setChecking(false),
    // The endpoint refunds and sweeps together. Check the refreshed PayPal watch
    // state after it returns; never invent progress with a timer or refund twice.
    onSuccess: () => setChecking(true),
    onError, onSettled: refresh, retry: false,
  });
  const busy = sweep.isPending || settings.isPending || bypass.isPending;
  const manageable = canManage(state);
  const watch = query.data?.watch;
  // An open incident, or one the owner marked "not me" while its agents are still frozen: the next step stays on screen.
  const attention = (query.data?.incidents ?? []).filter(incident => !incident.resolved_at
    || (incident.resolution === "not_mine" && frozenAgentIds(incident.frozen_agents).some(id => state.agents.find(agent => agent.id === id)?.status === "frozen")));
  return (
    <div className="watch-page space-y-6">
      <Resource query={query}>
        {watch && (
          <>
            <Card className="gap-0 py-0">
              <CardHeader className="p-5"><CardTitle>Watch status</CardTitle></CardHeader>
              <CardContent className="divide-y px-5 pb-2">
                <div className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <h2 className="text-sm font-medium">PayPal webhooks</h2>
                  <div className="space-y-1 text-sm">
                    {watch.webhook ? (
                      <span className="flex items-center gap-1.5">Connected <Check className="size-4 text-allow" aria-label="Connected" /></span>
                    ) : <p>Not available on this server</p>}
                    {watch.webhook_error && <p className="max-w-lg break-words text-xs text-destructive">{watch.webhook_error}</p>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div className="space-y-1">
                    <h2 className="text-sm font-medium">Order check</h2>
                    {watch.last_sweep ? (
                      <p className="text-xs text-muted-foreground">
                        <time dateTime={watch.last_sweep.at} title={new Date(watch.last_sweep.at).toLocaleString("en-US")}>{relativeTime(watch.last_sweep.at)}</time>
                        {` · ${watch.last_sweep.orders} orders, ${watch.last_sweep.refunds} refunds checked`}
                      </p>
                    ) : <p className="text-xs text-muted-foreground">Not checked yet</p>}
                  </div>
                  <Button variant="outline" disabled={!manageable || busy || !state.configured.paypal}
                    title={!manageable ? "Only owners and admins can check PayPal." : !state.configured.paypal ? "PayPal isn't configured on this server." : undefined}
                    onClick={() => sweep.mutate()}>
                    {sweep.isPending && <Loader2 className="animate-spin" />}
                    {sweep.isPending ? "Checking PayPal…" : "Check now"}
                  </Button>
                </div>
                <div className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <h2 className="text-sm font-medium">Last PayPal event</h2>
                  <p className="break-all text-sm text-muted-foreground">
                    {watch.last_event ? <>{watch.last_event.type}{" · "}
                      <time dateTime={watch.last_event.at} title={new Date(watch.last_event.at).toLocaleString("en-US")}>{relativeTime(watch.last_event.at)}</time>
                    </> : "None yet"}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card className="mt-6 px-5 py-2">
              {!manageable && (
                <p className="pt-3 text-xs text-muted-foreground">
                  Only owners and admins can check PayPal or change this setting.
                </p>
              )}
              <Toggle label="Freeze every agent when money moves outside Floorwalker"
                checked={watch.freeze} disabled={!manageable || busy}
                onChange={(freeze) => settings.mutate(freeze)} />
            </Card>
            <section className="watch-incidents" aria-label="Incidents">
              <h2>Incidents</h2>
              {attention.length ? attention.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id).map(incident => <IncidentBanner key={`${state.workspace?.id ?? "film"}:${incident.id}`} incident={incident} state={state} />)
                : <div className="watch-empty"><h3>{query.data?.incidents.length ? "No open incidents" : "No incidents recorded"}</h3><p>Watching for PayPal refunds and payout events that have no matching Floorwalker action. Order checks compare refunds on tracked PayPal orders; connected webhooks report PayPal events.</p><p>{watch.last_sweep ? `Last order check: ${new Date(watch.last_sweep.at).toLocaleString("en-US")}. ${watch.last_sweep.orders} orders and ${watch.last_sweep.refunds} refunds checked.` : "No order check has completed yet."}</p>{watch.last_event && <p>Last PayPal event: {new Date(watch.last_event.at).toLocaleString("en-US")}.</p>}</div>}
            </section>
            <details className="watch-history" open>
              <summary>Incident history · expand a row for its timeline</summary>
              <div className="h-[300px] w-full min-w-0 mt-4">
                <AgGridReact<Incident>
                  theme={resolvedTheme === "dark" ? darkTheme : lightTheme}
                  animateRows={!isFilm() && !window.matchMedia("(prefers-reduced-motion: reduce)").matches}
                  columnDefs={[{ field: "id", headerName: "#", width: 85, cellRenderer: "agGroupCellRenderer" }, ...columns(currency)]} defaultColDef={defaultColDef}
                  rowData={query.data?.incidents ?? []}
                  masterDetail detailRowAutoHeight
                  detailCellRenderer={({ data }: ICellRendererParams<Incident>) => data ? <IncidentBanner key={`${state.workspace?.id ?? "film"}:${data.id}`} incident={data} state={state} /> : null}
                  getRowId={({ data }) => String(data.id)} rowHeight={64} headerHeight={48}
                  overlayNoRowsTemplate="No incidents recorded. Order checks and PayPal events appear above."
                  tooltipShowDelay={250}
                />
              </div>
            </details>
          </>
        )}
      </Resource>
      {state.workspace?.demo && (
        <Card className="gap-3 p-5">
          <CardTitle>Try it</CardTitle>
          <p className="text-xs leading-relaxed text-muted-foreground">
            This is what an agent holding your PayPal key could do. Floorwalker can't stop it, but it notices within minutes and freezes your agents.
          </p>
          <Button className="h-auto min-h-9 w-fit whitespace-normal" variant="outline" data-film="bypass"
            disabled={!manageable || busy || !state.configured.paypal}
            onClick={() => bypass.mutate()}>
            {bypass.isPending && <Loader2 className="animate-spin" />}
            {bypass.isPending ? (checking ? "Checking PayPal…" : "Refunding in PayPal…") : `Refund ${money(25, currency)} straight through PayPal`}
          </Button>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Confirm
              disabled={!manageable || busy || !state.configured.paypal}
              reason={!manageable ? "Only owners and admins can reset the demo." : "PayPal isn't configured on this server."}
              title="Reset the demo?"
              description="This clears the demo's ledger and inbox and creates fresh sandbox orders, so you can try every step again."
              label="Reset demo"
              done="Fresh sandbox orders created."
              onConfirm={async () => {
                await post("/api/demo/reset");
                await refresh();
              }}
            >
              Reset the demo
            </Confirm>
            Each try uses up a sandbox order; reset when none are left.
          </div>
          {bypass.isPending && <span role="status" className="sr-only">{checking ? "Checking PayPal…" : "Refunding in PayPal…"}</span>}
          {bypass.data && (
            <p role="status" className="break-words text-sm leading-relaxed">
              Refunded {money(bypass.data.refund.amount, currency)} on order {bypass.data.refund.invoice} directly through the PayPal API (refund {bypass.data.refund.id}).{" "}
              {bypass.data.incident
                ? `Floorwalker found it and opened incident #${bypass.data.incident.id}.`
                : "No new incident was returned. Check the incidents table or check PayPal again."}
            </p>
          )}
          {bypass.isError && <p role="alert" className="text-sm text-destructive">{errorMessage(bypass.error)}</p>}
        </Card>
      )}
    </div>
  );
}
