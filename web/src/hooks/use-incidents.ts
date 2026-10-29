import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type IncidentsResponse, type State } from "../api";

export function useIncidents(state: State) {
  return useQuery({
    queryKey: ["incidents", state.workspace?.id ?? state.me?.workspaceId ?? null],
    queryFn: ({ signal }) =>
      api<IncidentsResponse>("/api/incidents", "GET", undefined, signal),
    refetchInterval: 8000,
  });
}

// TanStack Query 5: https://tanstack.com/query/v5/docs/framework/react/guides/query-invalidation
// Await both refreshes after every watch mutation, including failed requests
// that may already have moved money before the server returned an error.
export function useRefreshIncidents() {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["state"] }),
      client.invalidateQueries({ queryKey: ["incidents"] }),
    ]);
  }, [client]);
}
