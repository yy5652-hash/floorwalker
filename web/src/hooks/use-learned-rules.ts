import { useQuery } from "@tanstack/react-query";
import { api, type LearnedRules, type State } from "../api";
import { isFilm } from "../auth";

export const emptyLearnedRules: LearnedRules = {
  changes: [],
  note: null,
  weeks: [],
};

// TanStack Query 5: https://tanstack.com/query/v5/docs/framework/react/guides/query-invalidation
export function useLearnedRules(state: State) {
  return useQuery({
    queryKey: [
      "learned-rules",
      state.workspace?.id ?? state.me?.workspaceId ?? null,
      state.policy?.id,
      state.ledger.length,
    ],
    queryFn: async ({ signal }) => {
      try {
        const result = await api<LearnedRules>(
          "/api/rules/learned",
          "GET",
          undefined,
          signal,
        );
        // Older film shims can return a generic success object for unknown routes.
        if (
          isFilm() &&
          (!Array.isArray(result?.changes) || !Array.isArray(result?.weeks))
        )
          return emptyLearnedRules;
        return result;
      } catch (error) {
        if (isFilm() && !signal.aborted) return emptyLearnedRules;
        throw error;
      }
    },
    staleTime: 30_000,
    retry: false,
  });
}
