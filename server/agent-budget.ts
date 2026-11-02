/** What an agent card shows as its allowance: the agent's own budget if it has one, otherwise the workspace budget for its job. */
export type SharedBudget = { amount: number; period: "day" | "week" | "month" } | null;

export function agentAllowance(
  agent: { can_refund: number; can_payout: number; budget: number | null; budget_period: "day" | "week" | "month" | null },
  policy: { refunds: { budget: SharedBudget }; payouts: { budget: SharedBudget } },
) {
  const shared = agent.can_refund && !agent.can_payout ? policy.refunds.budget : agent.can_payout && !agent.can_refund ? policy.payouts.budget : null;
  if (typeof agent.budget === "number") return { budget: agent.budget, period: agent.budget_period ?? "week" };
  return { budget: shared, period: shared?.period ?? "week" };
}
