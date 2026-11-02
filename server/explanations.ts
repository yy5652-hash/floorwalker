import * as store from "./db.ts";
import type { Check } from "./guard/rules.ts";

export function agentView(agent: store.Agent) {
  const saved = (agent as store.Agent & { freeze_explanation?: string | null }).freeze_explanation;
  let explanation = null;
  try { explanation = saved ? JSON.parse(saved) : null; } catch { /* Historical evidence must not break an API response. */ }
  return { ...agent, freeze_explanation: agent.status !== "frozen" ? null : explanation ?? {
    check: "agent_frozen", evidence: { status_changed_at: agent.status_changed_at, source: "Historical freeze; reason was not recorded." },
    next_step: "Review Watch incidents and the audit log, then unfreeze this agent on the Agents page.",
  } };
}

export function blockExplanations(row: store.LedgerRow) {
  const checks = JSON.parse(row.checks) as Check[];
  const blocked = checks.filter(c => c.outcome === "block");
  if (!blocked.length) return [];
  let facts: any = null;
  try { facts = row.facts ? JSON.parse(row.facts) : null; } catch { /* Older rows may have no usable replay evidence. */ }
  return blocked.map(c => ({ check: c.id, rule: c.label, evidence: c.detail,
    facts: facts ? { rules: facts.rules, paypal_capture: facts.review?.paypal_capture ?? null } : null,
    freeze: c.id === "agent" ? facts?.freeze ?? (row.agent_id && store.agent(row.agent_id)?.status === "frozen" ? agentView(store.agent(row.agent_id)!).freeze_explanation : null) : null,
    next_step: c.id === "agent" ? "Review this agent's freeze, access expiry, permissions and payee list on the Agents page before submitting a corrected request."
      : c.id === "capture" || c.id === "buyer" ? "Verify the PayPal payment, refundable balance and buyer identity, then submit a corrected request."
      : c.id === "injection" || c.id === "ai_review" ? "Review the original message and AI evidence. Remove untrusted instructions and submit a legitimate request for review."
      : "Review this check and the workspace rules. Correct the request or have an owner change the rule before submitting a new request. Blocked requests cannot be approved." }));
}
