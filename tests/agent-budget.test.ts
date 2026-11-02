// An agent saved with its own budget must show that budget on its card, not the workspace's shared one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAllowance } from '../server/agent-budget.ts';

const policy = { refunds: { budget: { amount: 500, period: 'month' as const } }, payouts: { budget: { amount: 900, period: 'week' as const } } };

test('an agent with its own budget shows that budget and period', () => {
  const a = agentAllowance({ can_refund: 1, can_payout: 0, budget: 120, budget_period: 'week' }, policy);
  assert.deepEqual(a, { budget: 120, period: 'week' });
});

test('an agent without one shows the shared budget for its job', () => {
  assert.deepEqual(agentAllowance({ can_refund: 1, can_payout: 0, budget: null, budget_period: null }, policy), { budget: policy.refunds.budget, period: 'month' });
  assert.deepEqual(agentAllowance({ can_refund: 0, can_payout: 1, budget: null, budget_period: null }, policy), { budget: policy.payouts.budget, period: 'week' });
});

test('an agent that does both jobs has no shared budget to show', () => {
  assert.equal(agentAllowance({ can_refund: 1, can_payout: 1, budget: null, budget_period: null }, policy).budget, null);
});
