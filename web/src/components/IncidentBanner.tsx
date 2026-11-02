import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { canManage, errorMessage, money, post, type Incident, type State } from "../api";
import { useRefreshIncidents } from "../hooks/use-incidents";
import { Button } from "@/components/ui/button";

export function frozenAgentIds(value: string | null): string[] {
  try { const ids: unknown = JSON.parse(value ?? "[]"); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; }
  catch { return []; }
}

export function IncidentBanner({ state, incident }: { state: State; incident?: Incident }) {
  const refresh = useRefreshIncidents();
  const [resolved, setResolved] = useState<Incident | null>(null);
  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution: "mine" | "not_mine" }) => post<Incident>(`/api/incidents/${id}/resolve`, { resolution }),
    onSuccess: result => { setResolved(result); toast.success(result.resolution === "mine" ? "Incident marked as yours. Agent status updated." : "Incident recorded. Agents remain frozen."); },
    onError: error => toast.error(errorMessage(error)), onSettled: refresh, retry: false,
  });
  const open = (state.incidents ?? []).filter(item => !item.resolved_at).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  const newest = incident ?? open[0] ?? resolved;
  if (!newest || (!incident && !open.length && resolved?.resolution === "mine")) return null;
  const current = resolved?.id === newest.id ? resolved : newest;
  const ids = frozenAgentIds(current.frozen_agents);
  return <section data-film="incident" className="incident-banner incident-timeline" aria-label={`Incident ${current.id}`}>
    <h2>{current.resolved_at ? "Resolved PayPal activity" : "Money moved outside Floorwalker"} <span>#{current.id}</span></h2>
    <ol>
      <li><span className="timeline-step">1</span><div><h3>What happened</h3><p>{current.detail}</p><p>{money(current.amount)} · {current.kind}{current.counterparty ? ` · ${current.counterparty}` : ""}</p></div></li>
      <li><span className="timeline-step">2</span><div><h3>PayPal evidence</h3><dl>
        <div><dt>Transaction</dt><dd>{current.paypal_ref}</dd></div>
        {current.capture_id && <div><dt>Capture</dt><dd>{current.capture_id}</dd></div>}
        <div><dt>Seen at</dt><dd><time dateTime={current.created_at}>{new Date(current.created_at).toLocaleString("en-US")}</time> · {current.detected_by === "webhook" ? "PayPal webhook" : "Order check"}</dd></div>
      </dl></div></li>
      <li><span className="timeline-step">3</span><div><h3>Who was frozen</h3><p>{ids.length ? ids.map(id => (state.agents.find(agent => agent.id === id)?.name ?? id)).join(", ") : "No agents were recorded as frozen by this incident."}</p>
        {ids.length > 0 && <p className="text-muted-foreground">Current status: {ids.map(id => `${(state.agents.find(agent => agent.id === id)?.name ?? id)} (${state.agents.find(agent => agent.id === id)?.status ?? "no longer connected"})`).join(", ")}</p>}
      </div></li>
      <li><span className="timeline-step">4</span><div><h3>What you do next</h3>
        {current.resolved_at ? <p>{current.resolution === "mine" ? "Marked as your transaction. Review current agent status before continuing." : "Rotate your PayPal app's secret in the PayPal Developer Dashboard, then reconnect it in Settings. Review the incident before unfreezing agents."}</p>
          : <><p>Recognize this transaction? Confirm it was yours, or keep agents frozen while you investigate.</p>
          <div className="incident-actions">
            <Button variant="outline" data-film="incident-mine" disabled={!canManage(state) || resolve.isPending} onClick={() => resolve.mutate({ id: current.id, resolution: "mine" })}>That was me</Button>
            <Button variant="outline" className="text-destructive h-auto min-h-9 whitespace-normal" disabled={!canManage(state) || resolve.isPending} onClick={() => resolve.mutate({ id: current.id, resolution: "not_mine" })}>Not me, keep agents frozen</Button>
            {resolve.isPending && <span role="status">Saving…</span>}
          </div></>}
        {current.resolved_at && <p className="text-xs text-muted-foreground">Resolved {new Date(current.resolved_at).toLocaleString("en-US")}{current.resolved_by ? ` by ${current.resolved_by}` : ""}</p>}
        {!incident && open.length > 1 && <a href="/app#watch" className="text-sm underline">+{open.length - 1} more</a>}
      </div></li>
    </ol>
  </section>;
}
