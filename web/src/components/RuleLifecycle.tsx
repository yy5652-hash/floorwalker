import { useQuery } from "@tanstack/react-query";
import { api, DECISION_LABEL, money, personName, type PageProps, type PolicyStatus, type ShadowView } from "../api";
import { isFilm } from "../auth";
import { Resource } from "./Management";
import { Button } from "./ui/button";

// TanStack Query 5: workspace-scoped keys and abortable reads, refreshed while visible.
export function useRulesResource<T>(path: string, state: PageProps["state"]) {
  return useQuery({
    queryKey: [path, state.workspace?.id ?? state.me?.workspaceId, state.policy.id],
    queryFn: ({ signal }) => api<T>(path, "GET", undefined, signal),
    enabled: !isFilm(), refetchInterval: isFilm() ? false : 15_000, retry: false,
  });
}
const fields: Record<string, string> = {
  refunds: "Refunds", payouts: "Payouts", invoices: "Invoices", notes: "Reviewer guidance",
  auto_approve_up_to: "automatic approval limit", hard_limit: "maximum amount",
  budget: "budget", amount: "amount", period: "period", max_order_age_days: "order age in days",
  max_refunds_per_customer_30d: "refunds per customer in 30 days", requester_must_be_buyer: "buyer must be the requester",
  payees: "approved payees", unknown_payee: "unknown payees", only_owner_requests: "only owner requests can run automatically",
  max_discount_percent: "maximum discount (%)", monthly_limit: "monthly payee limit",
};
function valueText(value: unknown): string {
  if (value == null) return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.map(valueText).join("; ") : "none";
  if (typeof value === "object") return Object.entries(value).map(([key, v]) => `${fields[key] ?? key.replaceAll("_", " ")}: ${valueText(v)}`).join(", ");
  return String(value);
}
export function RuleStatus({ state, rollback, disabled }: {
  state: PageProps["state"]; rollback?: () => void; disabled: boolean;
}) {
  const query = useRulesResource<PolicyStatus>("/api/policy/status", state);
  if (isFilm()) return <p className="c1-muted">Live rule status is unavailable in this recorded demo. Active rules: v{state.policy.id}.</p>;
  return <Resource query={query}>{query.data && <>
    <dl className="c1-status-facts">
      <div><dt>Active version</dt><dd>{query.data.version == null ? "No saved version yet" : `v${query.data.version}`}</dd></div>
      <div><dt>Took effect</dt><dd>{query.data.effectiveAt ? <time dateTime={query.data.effectiveAt}>{new Date(query.data.effectiveAt).toLocaleString("en-US")}</time> : "Not recorded"}</dd></div>
      <div><dt>Changed by</dt><dd>{query.data.changedBy ?? "Not recorded"}</dd></div>
    </dl>
    <div className="c1-section-line">
      <h3>What changed</h3>
      {query.data.differences.length ? <ul className="c1-differences">{query.data.differences.map((diff) => <li key={diff.field}>
        <strong>{diff.field.split(".").map(key => fields[key] ?? key.replaceAll("_", " ")).join(" · ")}</strong>
        <span>{valueText(diff.before)} → {valueText(diff.after)}</span>
      </li>)}</ul> : <p className="c1-muted">No differences from a previous saved version are available.</p>}
    </div>
    <p className="text-sm">{query.data.waitingChanged} of {query.data.waiting} waiting requests would decide differently under these rules.</p>
    {query.data.waitingUnknown > 0 && <p className="text-sm text-hold">{query.data.waitingUnknown} waiting requests could not be checked because their recorded facts are incomplete. They are not counted as unchanged.</p>}
    <p className="c1-muted">Uses current spend and time with recorded PayPal facts and AI checks. PayPal records and AI review are not fetched again.</p>
    {rollback ? <Button variant="outline" disabled={disabled} onClick={rollback}>Roll back</Button> : <p className="c1-muted">No earlier version is available to roll back to.</p>}
  </>}</Resource>;
}
export function ShadowReport({ view, disabled, activate, stop }: {
  view: ShadowView; disabled: boolean; activate: () => void; stop: () => void;
}) {
  if (!view.draft) return null;
  const { draft, report } = view;
  return <section className="c1-shadow" aria-labelledby="shadow-heading">
    <div className="c1-heading-row"><div>
      <h2 id="shadow-heading">{view.active ? "Watching your draft" : "Watch period ended"}</h2>
      <p className="c1-muted">Started {new Date(draft.startedAt).toLocaleString("en-US")} by {draft.startedBy || "an unrecorded user"}{draft.endsAt ? ` · Ends ${new Date(draft.endsAt).toLocaleString("en-US")}` : " · Until you stop it"}</p>
    </div><span className="text-xs">Your active rules still decide</span></div>
    <p className="text-sm">Shadow results use the rules only. AI review could still change a decision.</p>
    <p className="c1-muted">{view.caveat}</p>
    {report.seen > 0 ? <>
      <dl className="c1-verdict">
        <div><dt>Taps per 100 requests</dt><dd>{report.tapsPer100.before} → {report.tapsPer100.after}</dd></div>
        <div><dt>Requests observed</dt><dd>{report.seen}</dd></div>
        <div><dt>Held → automatic</dt><dd>{report.wouldAutoActuallyHeld}</dd></div>
      </dl>
      <p className="c1-muted">{report.wouldHoldActuallyAuto} automatic requests would wait for you. {report.wouldBlockNotBlocked} requests would be newly blocked. These are decisions, not settled payments.</p>
      <details><summary>Show {report.differences.length} differing requests</summary>
        {report.differences.length ? <div className="c1-table-scroll"><table className="c1-table"><thead><tr><th>Request</th><th>Amount</th><th>Live decision</th><th>Shadow decision</th></tr></thead><tbody>
          {report.differences.map(row => <tr key={row.id}><td>#{row.id} · {personName(row.counterparty)}</td><td>{money(row.amount)}</td><td>{DECISION_LABEL[row.realDecision]}</td><td>{DECISION_LABEL[row.shadowDecision]}</td></tr>)}
        </tbody></table></div> : <p className="c1-muted">No decisions differed.</p>}
      </details>
    </> : <p className="c1-muted">No requests observed yet. New requests will appear here while this draft is watching.</p>}
    <details><summary>View the watched draft</summary><pre className="c1-policy-text">{valueText(draft.policy)}</pre></details>
    <div className="c1-actions"><Button disabled={disabled} onClick={activate}>Activate</Button><Button disabled={disabled} variant="outline" onClick={stop}>Stop</Button></div>
    <p className="c1-muted">Activating makes this watched draft live and stops watching. Stopping clears the draft and its report.</p>
  </section>;
}
