import { after, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'floorwalker-redesign-b-'));
process.env.FLOORWALKER_DB = ':memory:';
process.env.FLOORWALKER_CORE_DB = join(dir, 'core.db');
process.env.FLOORWALKER_DATA_DIR = dir;
process.env.BETTER_AUTH_SECRET = 'redesign-b-test-secret-not-production';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.PAYPAL_CLIENT_ID = 'test';
process.env.PAYPAL_CLIENT_SECRET = 'test';
const store = await import('../server/db.ts');
const { inWorkspace } = await import('../server/context.ts');
const { manage } = await import('../server/manage.ts');
const { registerWorkspace, openWorkspace, removeWorkspace } = await import('../server/workspaces.ts');
const guard = await import('../server/guard/index.ts');
const observe = await import('../server/guard/observe.ts');
const { DEFAULT_POLICY } = await import('../server/guard/policy.ts');
const { checkAgent, decide } = await import('../server/guard/rules.ts');
const { billingUsage, assertActionQuota } = await import('../server/billing.ts');
const { agentView } = await import('../server/explanations.ts');
const { handlePayPalEvent } = await import('../server/watch.ts');
after(() => rmSync(dir, { recursive: true, force: true }));
let sequence = 0;
const evaluator = observe.shadowDeps.evaluate;
beforeEach(() => { observe.shadowDeps.evaluate = evaluator; });
async function harness(t: TestContext, role = 'owner') {
  const id = `redesign-${++sequence}`;
  registerWorkspace(id, { demo: false });
  const ws = openWorkspace(id);
  const run = <T>(fn: () => T): T => inWorkspace(ws, { kind: 'user', id: 'owner', name: 'Owner', role }, fn);
  run(() => {
    store.savePolicy('Original', DEFAULT_POLICY);
    store.upsertAgent({ id: 'bot', name: 'Support', role: 'Refunds', can_refund: 1, can_payout: 1 });
  });
  const app = express();
  app.use('/api', (req, _res, next) => {
    req.me = { userId: 'owner', name: 'Owner', email: 'owner@example.com', role, anonymous: false, workspaceId: id, sessionId: 'test', signedInAt: Date.now() };
    run(next);
  }, manage);
  t.after(() => removeWorkspace(id));
  // Dispatch through the real Express router without binding a TCP port (sandbox forbids listen).
  const request = (path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: () => Promise<any> }> => new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    req.url = '/api' + path; req.method = method; req.headers = { 'content-type': 'application/json' };
    Object.assign(req, { body });
    const res = new ServerResponse(req);
    res.end = ((data: string | Buffer) => {
      resolve({ status: res.statusCode, json: async () => JSON.parse(String(data)) });
      return res;
    }) as typeof res.end;
    (app as unknown as { handle: (req: IncomingMessage, res: ServerResponse, next: (e: unknown) => void) => void }).handle(req, res, reject);
  });
  return { id, run, request };
}
function row(decision: 'allow' | 'hold' | 'block', amount: number, extras: Partial<Parameters<typeof store.recordProposal>[0]> = {}) {
  return store.recordProposal({ agentId: 'bot', tool: 'create_refund', kind: 'refund', params: { kind: 'refund', captureId: 'CAP', amount }, amount,
    counterparty: 'buyer@example.com', decision, status: decision === 'allow' ? 'executed' : decision === 'hold' ? 'awaiting_approval' : 'blocked', checks: [], ...extras });
}
const refundFacts = { captureFound: true, captureStatus: 'COMPLETED', capturedAmount: 100, refundedSoFar: 0, buyerEmail: 'buyer@example.com', requesterEmail: 'buyer@example.com', customerRefunds30d: 0 };
function stubGuard() {
  guard.deps.getCapture = async () => ({ id: 'CAP', status: 'COMPLETED', amount: { value: '100.00' }, create_time: new Date().toISOString(), links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER' }] });
  guard.deps.getOrder = async () => ({ payer: { email_address: 'buyer@example.com' }, purchase_units: [{ payments: { refunds: [] } }] });
  guard.deps.reviewAction = async () => ({ verdict: 'approve', matches_request: true, injection_detected: false, concerns: [], summary: 'Matches.', cited_rule: '' });
  guard.deps.callToolkit = async () => ({ id: 'REF', status: 'COMPLETED' });
}
const ticket: import("../server/db.ts").Ticket = { id: 'T', channel: 'email', from_name: 'Buyer', from_email: 'buyer@example.com', subject: 'Refund', body: 'Refund the broken item', received_at: new Date().toISOString(), status: 'open', reply: null };
const call = (amount: number) => guard.guard('create_refund', { capture_id: 'CAP', amount: { value: String(amount) } }, { agentId: 'bot', ticket, justification: 'Broken item' });

test('trust preview preserves blocks/holds, counts only automatic successful money, uses 90 days, and validates amount', async t => {
  const h = await harness(t);
  h.run(() => {
    row('allow', 10); row('allow', 30); row('hold', 20); row('block', 5); row('allow', 7, { status: 'failed' });
    const old = row('allow', 500);
    store.db().prepare('UPDATE ledger SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 91 * 86_400_000).toISOString(), old);
  });
  const res = await h.request('/agents/bot/trust-preview?amount=15');
  assert.equal(res.status, 200);
  const p = await res.json();
  assert.deepEqual(p.levels.ask, { moves: 5, taps: 4, tapsPer100: 80, autoUsd: 0 });
  assert.deepEqual(p.levels.small, { moves: 5, taps: 2, tapsPer100: 40, autoUsd: 10 });
  assert.deepEqual(p.levels.rules, { moves: 5, taps: 1, tapsPer100: 20, autoUsd: 40 });
  for (const amount of ['-1', '', 'NaN', 'Infinity', '1&amount=2']) assert.equal((await h.request('/agents/bot/trust-preview?amount=' + amount)).status, 400);
  assert.equal((await h.request('/agents/missing/trust-preview')).status, 404);
});

test('empty history is honest; zero cap is accepted and holds every cent amount', async t => {
  const h = await harness(t);
  const patch = await h.request('/agents/bot', 'PATCH', { max_per_action: 0 });
  assert.equal(patch.status, 200);
  const agent = await patch.json();
  for (const amount of [0.01, 1, 20, 500]) assert.equal(decide(checkAgent(agent, { kind: 'refund', captureId: 'C', amount }, amount)), 'hold');
  const p = await (await h.request('/agents/bot/trust-preview')).json();
  assert.equal(p.smallAmount, 0);
  for (const level of Object.values(p.levels)) assert.deepEqual(level, { moves: 0, taps: 0, tapsPer100: 0, autoUsd: 0 });
  const created = await h.request('/agents', 'POST', { name: 'Ask bot', max_per_action: 0 });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).max_per_action, 0);
});

test('shadow never changes live decisions or PayPal calls; exceptions are contained', async t => {
  const h = await harness(t); stubGuard();
  const baseline = await h.run(() => call(10));
  h.run(() => store.db().prepare('DELETE FROM ledger WHERE id = ?').run(baseline.row.id));
  const draft = structuredClone(DEFAULT_POLICY); draft.refunds.hard_limit = 5; draft.refunds.auto_approve_up_to = 5;
  assert.equal((await h.request('/policy/shadow', 'POST', { policy: draft })).status, 200);
  let calls = 0;
  guard.deps.callToolkit = async () => { calls++; return { id: 'REF', status: 'COMPLETED' }; };
  const observed = await h.run(() => call(10));
  assert.equal(observed.row.decision, baseline.row.decision);
  assert.equal(observed.row.status, baseline.row.status);
  assert.deepEqual(JSON.parse(observed.row.checks), JSON.parse(baseline.row.checks));
  assert.equal(calls, 1);
  const report = await (await h.request('/policy/shadow')).json();
  assert.equal(report.report.wouldBlockNotBlocked, 1);
  assert.equal(report.report.differences[0].shadowDecision, 'block');
  h.run(() => { const policy = structuredClone(DEFAULT_POLICY); policy.refunds.max_refunds_per_customer_30d = 100; store.savePolicy('Repeat test', policy); });
  observe.shadowDeps.evaluate = () => { throw new Error('test failure'); };
  const failed = await h.run(() => call(10));
  assert.equal(failed.row.decision, baseline.row.decision); assert.equal(failed.row.status, baseline.row.status); assert.equal(calls, 2);
  assert.equal((await (await h.request('/policy/shadow')).json()).report.seen, 1);
});

test('shadow reports each disagreement, replacement clears results, expiry/stop do not observe, workspace isolation', async t => {
  const h = await harness(t); const other = await harness(t);
  h.run(() => {
    observe.startShadow(DEFAULT_POLICY, null);
    for (const [real, amount] of [['hold', 10], ['allow', 60], ['allow', 300], ['allow', 20]] as const) {
      const id = row(real, amount);
      // Observer runs before the real request executes, as in guard().
      store.updateLedger(id, { status: real === 'allow' ? 'executing' : 'awaiting_approval' });
      observe.observeShadow(id, { kind: 'refund', captureId: 'CAP', amount }, refundFacts, []);
    }
  });
  const { report, rulesOnly } = await (await h.request('/policy/shadow')).json();
  assert.equal(rulesOnly, true);
  assert.equal(report.seen, 4); assert.equal(report.wouldAutoActuallyHeld, 1); assert.equal(report.wouldHoldActuallyAuto, 1); assert.equal(report.wouldBlockNotBlocked, 1);
  assert.deepEqual(report.tapsPer100, { before: 25, after: 25 }); assert.equal(report.differences.length, 3);
  assert.equal((await (await other.request('/policy/shadow')).json()).report.seen, 0);
  await h.request('/policy/shadow', 'POST', { policy: DEFAULT_POLICY });
  assert.equal((await (await h.request('/policy/shadow')).json()).report.seen, 0);
  h.run(() => {
    store.db().prepare('UPDATE shadow_policy SET ends_at = ?').run('2000-01-01T00:00:00.000Z');
    observe.observeShadow(row('hold', 10), { kind: 'refund', captureId: 'CAP', amount: 10 }, refundFacts, []);
  });
  const expired = await (await h.request('/policy/shadow')).json(); assert.equal(expired.active, false); assert.equal(expired.report.seen, 0);
  assert.equal((await h.request('/policy/shadow', 'DELETE')).status, 200);
  assert.equal((await (await h.request('/policy/shadow')).json()).draft, null);
  assert.equal((await h.request('/policy/shadow', 'POST', { policy: {} })).status, 400);
  assert.equal((await h.request('/policy/shadow', 'POST', { policy: DEFAULT_POLICY, endsAt: 'yesterday' })).status, 400);
  assert.equal((await h.request('/policy/shadow', 'POST', { policy: DEFAULT_POLICY, endsAt: '2000-01-01T00:00:00Z' })).status, 400);
});

test('read-only policy status shows actor, differences, changed pending requests and unknown history', async t => {
  const h = await harness(t);
  h.run(() => {
    row('hold', 60, { facts: { rules: refundFacts }, checks: [{ id: 'auto_limit', label: 'Limit', outcome: 'hold', detail: 'Over 40' }] });
    row('hold', 10); // no stored facts: must be reported as unknown
    row('hold', 20, { facts: { rules: refundFacts }, checks: [{ id: 'ai_review', label: 'AI', outcome: 'hold', detail: 'Review' }] });
    const draft = structuredClone(DEFAULT_POLICY); draft.refunds.auto_approve_up_to = 70;
    store.savePolicy('Up to 70', draft);
  });
  const status = await (await h.request('/policy/status')).json();
  assert.equal(status.changedBy, 'Owner'); assert.ok(status.effectiveAt); assert.equal(status.waitingChanged, 1); assert.equal(status.waitingUnknown, 1); assert.equal(status.waiting, 3);
  assert.deepEqual(status.differences, [{ field: 'refunds.auto_approve_up_to', before: 40, after: 70 }]);
  h.run(() => store.db().exec('DELETE FROM policies'));
  assert.equal((await (await h.request('/policy/status')).json()).version, null);
  assert.equal(h.run(() => store.policyVersions().length), 0);
});

test('usage matches enforced counter, warns at 80%, and resets next UTC month', async t => {
  const h = await harness(t);
  h.run(() => { for (let i = 0; i < 159; i++) row('block', 1); });
  const before = await (await h.request('/billing/usage')).json(); assert.equal(before.warning, null); assert.equal(before.monthlyLimit, 200); assert.equal(before.planName, 'Free');
  h.run(() => row('hold', 1));
  const usage = await (await h.request('/billing/usage')).json(); assert.equal(usage.actionsUsed, 160); assert.ok(usage.warning);
  const now = new Date(); assert.equal(usage.resetsAt, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());
  h.run(() => {
    for (let i = 0; i < 40; i++) row('allow', 1);
    assert.equal(billingUsage(h.id).actionsUsed, store.actionsThisMonth());
    assert.throws(() => assertActionQuota(h.id, billingUsage(h.id).actionsUsed), /used all 200/);
  });
});

test('viewer can read new endpoints but cannot change shadow rules or trust', async t => {
  const h = await harness(t, 'viewer');
  for (const path of ['/agents/bot/trust-preview', '/policy/status', '/policy/shadow', '/billing/usage']) assert.equal((await h.request(path)).status, 200);
  assert.equal((await h.request('/policy/shadow', 'POST', { policy: DEFAULT_POLICY })).status, 403);
  assert.equal((await h.request('/policy/shadow', 'DELETE')).status, 403);
  assert.equal((await h.request('/agents/bot', 'PATCH', { max_per_action: 0 })).status, 403);
});

test('manual and Watch freezes expose rule, transaction/time evidence and recovery; blocked action exposes explanation', async t => {
  const h = await harness(t); stubGuard();
  const frozen = await (await h.request('/agents/bot/freeze', 'POST', {})).json();
  assert.equal(frozen.freeze_explanation.check, 'owner_freeze'); assert.ok(frozen.freeze_explanation.evidence.at); assert.ok(frozen.freeze_explanation.next_step);
  await h.request('/agents/bot/unfreeze', 'POST', {});
  h.run(() => {
    handlePayPalEvent({ event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: 'UNACCOUNTED', amount: { value: '20' } } } });
    const explanation = agentView(store.agent('bot')!).freeze_explanation;
    assert.equal(explanation.evidence.paypal_ref, 'UNACCOUNTED'); assert.ok(explanation.evidence.seen_at); assert.ok(explanation.next_step);
  });
  const blocked = await h.run(() => call(10));
  const view = h.run(() => guard.actionView(blocked.row));
  assert.equal(view.decision, 'block'); assert.ok(view.block_explanations.length);
  assert.equal(view.block_explanations[0].freeze.evidence.paypal_ref, 'UNACCOUNTED'); assert.ok(view.block_explanations[0].next_step);
});

test('shadow preserves held/blocked decisions and agent limits, and retries produce one observation', async t => {
  const h = await harness(t); stubGuard();
  for (const amount of [60, 300]) {
    const baseline = await h.run(() => call(amount));
    h.run(() => {
      store.db().prepare('DELETE FROM ledger WHERE id = ?').run(baseline.row.id);
      observe.startShadow(DEFAULT_POLICY, null);
    });
    const observed = await h.run(() => call(amount));
    assert.equal(observed.row.decision, baseline.row.decision);
    assert.equal(observed.row.status, baseline.row.status);
    assert.deepEqual(JSON.parse(observed.row.checks), JSON.parse(baseline.row.checks));
    h.run(() => { observe.stopShadow(); store.db().prepare('DELETE FROM ledger WHERE id = ?').run(observed.row.id); });
  }
  h.run(() => {
    store.setAgentControls('bot', { max_per_action: 0, budget: null, budget_period: null, payees: null, expires_at: null });
    observe.startShadow(DEFAULT_POLICY, null);
  });
  const invoke = () => guard.guard('create_refund', { capture_id: 'CAP', amount: { value: '10' } }, { agentId: 'bot', ticket, justification: 'Broken item', idempotencyKey: 'retry' });
  const first = await h.run(invoke); const retry = await h.run(invoke);
  assert.equal(first.row.decision, 'hold'); assert.equal(first.row.id, retry.row.id);
  const report = await (await h.request('/policy/shadow')).json();
  assert.equal(report.report.seen, 1); assert.equal(report.report.wouldAutoActuallyHeld, 0);
});

test('shadow database write failure cannot change the real decision', async t => {
  const h = await harness(t); stubGuard();
  h.run(() => {
    observe.startShadow(DEFAULT_POLICY, null);
    store.db().exec("CREATE TRIGGER fail_shadow BEFORE INSERT ON shadow_results BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  });
  const outcome = await h.run(() => call(10));
  assert.equal(outcome.row.decision, 'allow'); assert.equal(outcome.row.status, 'executed');
  assert.equal(h.run(() => observe.shadowView().report.seen), 0);
});

test('Watch block evidence survives resolution and unfreeze', async t => {
  const h = await harness(t); stubGuard();
  const incident = h.run(() => handlePayPalEvent({ event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: 'HISTORICAL', amount: { value: '20' } } } }).incident)!;
  const blocked = await h.run(() => call(10));
  const { resolveIncident } = await import('../server/watch.ts');
  h.run(() => resolveIncident(incident.id, 'Owner', 'mine'));
  const view = h.run(() => guard.actionView(store.ledgerEntry(blocked.row.id)!));
  assert.equal(view.block_explanations[0].freeze.evidence.paypal_ref, 'HISTORICAL');
  assert.equal(h.run(() => store.agent('bot')!.status), 'active');
});
