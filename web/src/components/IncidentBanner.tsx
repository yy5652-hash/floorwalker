import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { canManage, errorMessage, post, relativeTime, type Incident, type State } from "../api";
import { useRefreshIncidents } from "../hooks/use-incidents";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

function frozenCount(value: string | null) {
  try {
    const ids: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(ids) ? ids.length : 0;
  } catch {
    return 0;
  }
}

export function IncidentBanner({ state }: { state: State }) {
  const refresh = useRefreshIncidents();
  const [showAdvice, setShowAdvice] = useState(false);
  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: number; resolution: "mine" | "not_mine" }) =>
      post<Incident>(`/api/incidents/${id}/resolve`, { resolution }),
    onSuccess: (_, { resolution }) => {
      if (resolution === "mine") toast.success("Agents are running again");
      else setShowAdvice(true);
    },
    onError: (error) => toast.error(errorMessage(error)),
    onSettled: refresh,
    retry: false,
  });
  const incidents = state.incidents ?? [];
  const newest = incidents.reduce<Incident | undefined>((latest, incident) =>
    !latest || incident.created_at > latest.created_at ||
    (incident.created_at === latest.created_at && incident.id > latest.id)
      ? incident : latest, undefined);
  if (!newest && !showAdvice) return null;
  const frozen = frozenCount(newest?.frozen_agents ?? null);
  return (
    <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
      <ShieldAlert />
      <AlertTitle className="line-clamp-none">Money moved outside Floorwalker</AlertTitle>
      <AlertDescription className="gap-3">
        {newest && (
          <>
            <p className="break-words">{newest.detail}</p>
            <p className="text-xs">
              {newest.detected_by === "webhook"
                ? "Found by PayPal webhook"
                : "Found by checking your orders in PayPal"}
              {" · "}<time dateTime={newest.created_at} title={new Date(newest.created_at).toLocaleString()}>
                {relativeTime(newest.created_at)}
              </time>
              {frozen > 0 && ` · ${frozen} agents frozen`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" disabled={!canManage(state) || resolve.isPending}
                onClick={() => resolve.mutate({ id: newest.id, resolution: "mine" })}>
                That was me
              </Button>
              <Button variant="destructive" className="h-auto min-h-9 whitespace-normal"
                disabled={!canManage(state) || resolve.isPending}
                onClick={() => resolve.mutate({ id: newest.id, resolution: "not_mine" })}>
                Not me, keep agents frozen
              </Button>
              {incidents.length > 1 && (
                <a href="/app#watch" className="text-sm underline underline-offset-4">
                  +{incidents.length - 1} more
                </a>
              )}
              {resolve.isPending && <span role="status">Saving…</span>}
            </div>
          </>
        )}
        {showAdvice && (
          <p role="status">
            Rotate your PayPal app's secret in the PayPal Developer Dashboard, then reconnect it in Settings.
            Your agents stay frozen until you unfreeze them.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
