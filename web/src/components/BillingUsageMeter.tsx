import { useQuery } from "@tanstack/react-query";
import { api, type BillingUsage, type State } from "../api";
import { Resource } from "./Management";

export function BillingUsageMeter({ state }: { state: State }) {
  const query = useQuery({
    queryKey: ["/api/billing/usage", state.workspace?.id ?? state.me?.workspaceId, state.workspace?.plan],
    queryFn: ({ signal }) => api<BillingUsage>("/api/billing/usage", "GET", undefined, signal),
    refetchInterval: 30_000, retry: false,
  });
  const usage = query.data;
  const percent = usage && usage.monthlyLimit > 0 ? Math.min(100, usage.actionsUsed / usage.monthlyLimit * 100) : 0;
  const warning = !!usage && (usage.warning != null || percent >= 80);
  return <section className="c1-usage" aria-labelledby="usage-heading"><Resource query={query}>
    {usage && <>
      <div className="c1-heading-row"><h3 id="usage-heading">{usage.planName} plan · Actions this month</h3>
        <span className="tabular-nums text-sm">{usage.actionsUsed.toLocaleString("en-US")} / {usage.monthlyLimit.toLocaleString("en-US")}</span>
      </div>
      <div className={`c1-usage-track${warning ? " c1-usage-warning" : ""}`} role="progressbar" aria-label="Actions this month usage"
        aria-valuenow={Math.min(usage.actionsUsed, usage.monthlyLimit)} aria-valuemin={0} aria-valuemax={usage.monthlyLimit}
        aria-valuetext={`${usage.actionsUsed.toLocaleString("en-US")} of ${usage.monthlyLimit.toLocaleString("en-US")} checked actions used`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {warning && <p role="status" className="text-sm text-hold">{usage.actionsUsed >= usage.monthlyLimit ? "Monthly limit reached. New agent actions are stopped." : usage.warning || "You have used at least 80% of this month's checked actions."}</p>}
      <p className="c1-muted">Resets <time dateTime={usage.resetsAt}>{new Date(usage.resetsAt).toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} UTC</time>.</p>
      {usage.actionsUsed === 0 && <p className="c1-muted">No actions yet this month.</p>}
      <p className="c1-muted">Every proposed action counts, including blocked and failed requests. At the monthly limit, new agent actions stop until the month resets or you upgrade. No per-action overage is charged.</p>
    </>}
  </Resource></section>;
}
