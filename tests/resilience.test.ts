/** node --import tsx --test tests/resilience.test.ts
 * All dependencies are stubbed; no credentials or network required.
 * Known defects retain failing safety assertions for the server worker.
 * No skips/TODOs hide defects. See experiments-REPORT.md.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
process.env.FLOORWALKER_DB = ':memory:';
process.env.FLOORWALKER_CORE_DB = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.FLOORWALKER_AI_FALLBACK = '';
process.env.PAYPAL_CLIENT_ID = 'test';
process.env.PAYPAL_CLIENT_SECRET = 'test';
const store = await import('../server/db.ts');
const guard = await import('../server/guard/index.ts');
const productionReviewer = guard.deps.reviewAction;
const watch = await import('../server/watch.ts');
const { audit, verifyAudit } = await import('../server/audit.ts');
const { DEFAULT_POLICY, DEFAULT_POLICY_TEXT } = await import('../server/guard/policy.ts');
const review = { verdict: 'approve' as const, matches_request: true, injection_detected: false, concerns: [], summary: 'Matches', cited_rule: '' };
const ticket: import('../server/db.ts').Ticket = { id: 'resilience', channel: 'email', from_name: 'Buyer', from_email: 'buyer@example.com', subject: 'Refund', body: 'Please refund the damaged item', received_at: new Date().toISOString(), status: 'open', reply: null };
let calls: string[];
const refundEvent = (id = 'REF-OURS') => ({ id: `EVENT-${id}`, event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id, amount: { value: '24.00' }, links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP' }] } });
const propose = (amount = 86, key?: string) => guard.guard('create_refund', { capture_id: 'CAP', amount: { value: amount.toFixed(2), currency_code: 'USD' } }, { ticket, justification: 'Damaged item', agentId: 'test-agent', idempotencyKey: key });
beforeEach(() => {
  store.resetDemo();
  store.db().exec('DELETE FROM settings');
  store.savePolicy(DEFAULT_POLICY_TEXT, DEFAULT_POLICY);
  store.upsertAgent({ id: 'test-agent', name: 'Test agent', role: 'test', can_refund: 1, can_payout: 1 });
  store.upsertOrder({ invoice_id: 'INV', customer_name: 'Buyer', customer_email: ticket.from_email, order_id: 'ORD', capture_id: 'CAP', amount: 100, items: '[]', tracking: '{}', created_at: new Date().toISOString() });
  calls = [];
  guard.deps.getCapture = async () => ({ id: 'CAP', status: 'COMPLETED', amount: { value: '100.00' }, create_time: new Date().toISOString(), links: [{ rel: 'up', href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD' }] });
  guard.deps.getOrder = async () => ({ id: 'ORD', payer: { email_address: ticket.from_email }, purchase_units: [{ payments: { refunds: [] } }] });
  guard.deps.reviewAction = async () => review;
  guard.deps.callToolkit = async (_tool, input, key) => { calls.push(key!); await new Promise(r => setTimeout(r, 5)); return { id: 'REF-OURS', status: 'COMPLETED', amount: (input as any).amount }; };
  guard.deps.sendPayout = (async (p: any) => { calls.push(p.batchId); return { batch_header: { payout_batch_id: 'BATCH', batch_status: 'PENDING' } }; }) as any;
});

test('20 concurrent approvals execute exactly once', async () => {
  const { row } = await propose();
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => guard.approve(row.id, 'Owner')));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 19);
  assert.equal(calls.length, 1);
  assert.equal(store.ledgerEntry(row.id)!.status, 'approved');
});

for (const failure of ['500 response', 'timeout response']) {
  test(`PayPal ${failure} leaves failed row; idempotent retry returns it without another execution`, async () => {
    guard.deps.callToolkit = async (_tool, _input, key) => { calls.push(key!); return { error: { message: failure } }; };
    const { row } = await propose(24, 'same-request');
    assert.equal(row.status, 'failed');
    const retry = await propose(24, 'same-request');
    assert.equal(retry.row.id, row.id);
    assert.equal(retry.row.status, 'failed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], `allowance-${row.id}-${Date.parse(row.created_at).toString(36)}`);
  });
}

test('retrying the same failed row retains its PayPal request key (explicit recovery transition)', async () => {
  guard.deps.callToolkit = async (_tool, _input, key) => { calls.push(key!); return calls.length === 1 ? { error: { message: '500' } } : { id: 'RECOVERED', status: 'COMPLETED' }; };
  const { row } = await propose(86);
  await guard.approve(row.id, 'Owner');
  assert.equal(store.ledgerEntry(row.id)!.status, 'failed');
  // No public retry endpoint exists. Exercise request-key stability without
  // pretending this test-only recovery transition is a product feature.
  assert.equal(store.transition(row.id, 'failed', 'awaiting_approval'), true);
  await guard.approve(row.id, 'Owner');
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.equal(store.ledgerEntry(row.id)!.status, 'approved');
});

for (const failure of ['PayPal 500 thrown', 'TimeoutError']) {
  test(`${failure} leaves refund failed instead of executing`, async () => {
    guard.deps.callToolkit = async (_tool, _input, key) => { calls.push(key!); throw new Error(failure); };
    const { row } = await propose();
    await guard.approve(row.id, 'Owner').catch(() => {});
    await guard.approve(row.id, 'Owner').catch(() => {});
    assert.equal(calls.length, 1);
    assert.equal(store.ledgerEntry(row.id)!.status, 'failed');
  });
}

test('payout exception leaves failed row without double execution', async () => {
  guard.deps.sendPayout = (async (p: any) => { calls.push(p.batchId); throw new Error('TimeoutError'); }) as any;
  const { row } = await guard.guard('send_payout', { email: 'sam.rivera@example.com', amount: 60, note: 'Work' }, { ticket, agentId: 'test-agent', justification: 'Work' });
  await guard.approve(row.id, 'Owner');
  await assert.rejects(guard.approve(row.id, 'Owner'), /not awaiting approval/);
  assert.equal(calls.length, 1);
  assert.equal(store.ledgerEntry(row.id)!.status, 'failed');
});

test('reviewer down holds and executes nothing', async () => {
  guard.deps.reviewAction = async () => { throw new Error('Reviewer down'); };
  const { row } = await propose(24);
  assert.equal(row.status, 'awaiting_approval');
  assert.equal(calls.length, 0);
});

for (const content of ['not JSON', '{"unexpected":true}']) {
  test(`real reviewer rejects malformed model response: ${content}`, async t => {
    const { anthropic } = await import('../server/llm.ts');
    let modelCalls = 0;
    t.mock.method(anthropic() as unknown as { fetch: typeof fetch }, 'fetch', async () => {
      modelCalls++;
      return new Response(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    guard.deps.reviewAction = productionReviewer;
    const { row } = await propose(24);
    assert.equal(modelCalls, 1);
    assert.equal(row.status, 'awaiting_approval');
    assert.equal(calls.length, 0);
  });
}

test('garbage reviewer object cannot authorize money', async () => {
  guard.deps.reviewAction = async () => ({ nonsense: true }) as any;
  const { row } = await propose(24);
  assert.equal(calls.length, 0);
  assert.notEqual(row.decision, 'allow');
});

test('expired request cannot be approved before the expiry sweep', async () => {
  const { row } = await propose();
  store.db().prepare('UPDATE ledger SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), row.id);
  await guard.approve(row.id, 'Owner').catch(() => {});
  assert.equal(calls.length, 0);
  assert.notEqual(store.ledgerEntry(row.id)!.status, 'approved');
});

test('expiry sweep declines requests and subsequent approval is refused', async () => {
  const { row } = await propose();
  store.db().prepare('UPDATE ledger SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), row.id);
  assert.equal(guard.expireOverdue(), 1);
  await assert.rejects(guard.approve(row.id, 'Owner'), /not awaiting approval/);
  assert.equal(calls.length, 0);
});

test('frozen agent cannot execute a request already held', async () => {
  const { row } = await propose();
  store.setAgentStatus('test-agent', 'frozen');
  await guard.approve(row.id, 'Owner').catch(() => {});
  assert.equal(calls.length, 0);
  assert.notEqual(store.ledgerEntry(row.id)!.status, 'approved');
});

test('duplicate refund webhook opens only one incident', () => {
  watch.handlePayPalEvent(refundEvent('ROGUE'));
  watch.handlePayPalEvent(refundEvent('ROGUE'));
  assert.equal(watch.incidents().length, 1);
  assert.equal(store.agent('test-agent')!.status, 'frozen');
});

test('out-of-order payout webhook cannot regress RETURNED to UNCLAIMED', () => {
  const id = store.recordProposal({ tool: 'send_payout', kind: 'payout', params: {}, amount: 35, decision: 'allow', checks: [], status: 'executed' });
  store.updateLedger(id, { status: 'executed', paypalRef: 'BATCH' });
  const event = (status: string, time: string) => ({ id: status, create_time: time, event_type: `PAYMENT.PAYOUTS-ITEM.${status}`, resource: { payout_batch_id: 'BATCH', transaction_status: status } });
  watch.handlePayPalEvent(event('RETURNED', '2026-01-02T00:00:00Z'));
  watch.handlePayPalEvent(event('UNCLAIMED', '2026-01-01T00:00:00Z'));
  assert.equal(JSON.parse(store.ledgerEntry(id)!.paypal_result!).webhook_status, 'RETURNED');
});

test('bad signature verifier rejects delivery without mutating workspace', async t => {
  const before = { ledger: store.ledger(), agents: store.agents(), incidents: watch.incidents(), event: store.setting('watch.last_event', null) };
  t.mock.method(globalThis, 'fetch', async (url: any) => new Response(JSON.stringify(String(url).endsWith('/v1/oauth2/token') ? { access_token: 'stub', expires_in: 300 } : { verification_status: 'FAILURE' }), { status: 200 }));
  const verified = await watch.verifyPayPalWebhook({ clientId: 'signature-test', clientSecret: 'stub' }, 'HOOK', { 'paypal-transmission-sig': 'invalid' }, refundEvent('FORGED'));
  assert.equal(verified, false);
  // Verification unit boundary only; live e2e separately hits the real HTTP route.
  assert.deepEqual({ ledger: store.ledger(), agents: store.agents(), incidents: watch.incidents(), event: store.setting('watch.last_event', null) }, before);
});

test('refund webhook arriving before immediate PayPal response causes no false incident', async () => {
  guard.deps.callToolkit = async (_tool, _input, key) => {
    calls.push(key!);
    assert.equal(watch.handlePayPalEvent(refundEvent()).matched, true);
    assert.equal(watch.incidents().length, 0);
    return { id: 'REF-OURS', status: 'COMPLETED' };
  };
  await propose(24);
  assert.equal(watch.incidents().length, 0);
});

test('refund webhook arriving first during approval of a day-old request causes no false incident', async () => {
  const { row } = await propose();
  store.db().prepare('UPDATE ledger SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 86_400_000).toISOString(), row.id);
  guard.deps.callToolkit = async () => { watch.handlePayPalEvent(refundEvent()); return { id: 'REF-OURS', status: 'COMPLETED' }; };
  await guard.approve(row.id, 'Owner');
  assert.equal(watch.incidents().length, 0);
  assert.equal(store.agent('test-agent')!.status, 'active');
});

test('audit trigger rejects edits and verifyAudit detects corruption after bypassing trigger', () => {
  audit('resilience.audit');
  assert.equal(verifyAudit().ok, true);
  const id = (store.db().prepare('SELECT MAX(id) AS id FROM audit').get() as { id: number }).id;
  assert.throws(() => store.db().prepare("UPDATE audit SET action = 'tampered' WHERE id = ?").run(id));
  const triggers = store.db().prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit'").all() as { name: string; sql: string }[];
  store.db().exec('SAVEPOINT corrupt_audit');
  try {
    for (const trigger of triggers) store.db().exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
    store.db().prepare("UPDATE audit SET action = 'tampered' WHERE id = ?").run(id);
    assert.deepEqual(verifyAudit(), { ok: false, entries: verifyAudit().entries, brokenAt: id });
  } finally { store.db().exec('ROLLBACK TO corrupt_audit; RELEASE corrupt_audit'); }
  assert.equal(verifyAudit().ok, true);
});

// The brief allows bench/run.ts changes but forbids running the real-model
// benchmark. Validate partition/merge using explicitly synthetic artifacts in
// an isolated temp directory; the repository replay is never overwritten.
test('benchmark shard partition and merge reject partial, duplicate and mismatched inputs without touching replay', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const { CASES } = await import('../bench/cases.ts');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), 'floorwalker-shards-'));
  const fixtureReplay: any[] = JSON.parse(readFileSync(new URL('../bench/replay.json', import.meta.url), 'utf8'));
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(root, 'bench/run.ts'), ...args], { cwd: temp, encoding: 'utf8', env: { ...process.env, FLOORWALKER_DB: ':memory:', FLOORWALKER_CORE_DB: ':memory:' }, timeout: 30_000 });
  try {
    mkdirSync(join(temp, 'bench'));
    const replayPath = join(temp, 'bench/replay.json');
    writeFileSync(replayPath, 'SENTINEL');
    const fingerprint = createHash('sha256').update(JSON.stringify(CASES)).digest('hex');
    const files = [0, 1].map(index => {
      const cases = CASES.filter((_, i) => i % 2 === index);
      const artifact = {
        run: { version: 1, set: 'main', model: 'synthetic-not-a-model-run', repeats: 2, fingerprint, caseIds: cases.map(c => c.id), shard: { index, total: 2 }, only: null, ranAt: new Date().toISOString() },
        results: cases.flatMap(c => Array.from({ length: 2 }, () => ({ id: c.id, group: c.group, expected: c.expected, amount: c.tool === 'send_payout' ? Number(c.input.amount) : c.input.amount?.value ? Number(c.input.amount.value) : c.order!.items.reduce((n, i) => n + i.unit * i.quantity, 0) + c.order!.shipping - (c.order!.refunded ?? 0), prompt: 'hold', rules: 'hold', full: 'hold', ms: 0 }))),
        replay: cases.map(c => fixtureReplay.find(r => r.id === c.id)),
      };
      assert.ok(artifact.replay.every(Boolean));
      const path = join(temp, `part${index}.json`);
      writeFileSync(path, JSON.stringify(artifact));
      return path;
    });
    for (const args of [['--shard', '2/2'], ['--shard', '0/0'], ['--shard', '-1/2'], ['--repeats', '0'], ['--merge', files[0]], ['--merge', `${files[0]},${files[0]}`]]) {
      assert.notEqual(run(args).status, 0, `Should reject ${args.join(' ')}`);
      assert.equal(readFileSync(replayPath, 'utf8'), 'SENTINEL');
    }
    const part = JSON.parse(readFileSync(files[1], 'utf8'));
    for (const corrupt of ['model', 'fingerprint', 'repeats', 'results', 'replay', 'only']) {
      const wrong = structuredClone(part);
      if (corrupt === 'results' || corrupt === 'replay') wrong[corrupt].pop();
      else wrong.run[corrupt] = corrupt === 'repeats' ? 3 : 'mismatch';
      const file = join(temp, 'wrong.json'); writeFileSync(file, JSON.stringify(wrong));
      assert.notEqual(run(['--merge', `${files[0]},${file}`]).status, 0, `Reject ${corrupt} mismatch`);
      assert.equal(readFileSync(replayPath, 'utf8'), 'SENTINEL');
    }
    // A real empty shard exercises the runner's output path without any model calls.
    const empty = run(['--shard', `${CASES.length}/${CASES.length + 1}`, '--repeats', '1']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(readFileSync(replayPath, 'utf8'), 'SENTINEL');
    const emptyFile = JSON.parse(readFileSync(join(temp, `bench/results-shard-${CASES.length}-of-${CASES.length + 1}.json`), 'utf8'));
    assert.deepEqual(emptyFile.run.caseIds, []);
    const merged = run(['--merge', files.slice().reverse().join(','), '--out', 'bench/merged-results']);
    assert.equal(merged.status, 0, merged.stderr);
    const result = JSON.parse(readFileSync(join(temp, 'bench/merged-results.json'), 'utf8'));
    assert.equal(result.results.length, CASES.length * 2);
    assert.equal(result.summary.cases, CASES.length);
    assert.deepEqual(JSON.parse(readFileSync(replayPath, 'utf8')).map((r: any) => r.id), CASES.map(c => c.id));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('expiry on approval records the same reason, actor and audit event as the sweep', async () => {
  const { row } = await propose();
  store.db().prepare('UPDATE ledger SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), row.id);
  await assert.rejects(guard.approve(row.id, 'Owner'), /expired.*declined/);
  const expired = store.ledgerEntry(row.id)!;
  assert.equal(expired.status, 'declined');
  assert.equal(expired.decided_by, 'Floorwalker (expired)');
  assert.match(expired.decline_reason!, /declined automatically/);
  assert.equal(store.db().prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'action.expired' AND target = ?").get(`act_${row.id}`)?.n, 1);
  assert.equal(guard.expireOverdue(), 0);
  assert.equal(calls.length, 0);
});

test('freeze refusal is explicit, leaves the request waiting and permits approval after unfreeze', async () => {
  const { row } = await propose();
  store.setAgentStatus('test-agent', 'frozen');
  await assert.rejects(guard.approve(row.id, 'Owner'), { message: 'This agent is frozen; unfreeze it first.', code: 'agent_frozen', status: 409 });
  assert.equal(store.ledgerEntry(row.id)!.status, 'awaiting_approval');
  assert.equal(calls.length, 0);
  store.setAgentStatus('test-agent', 'active');
  assert.equal((await guard.approve(row.id, 'Owner')).status, 'approved');
  assert.equal(calls.length, 1);
});

test('automatic refund adapter exceptions record failure and cannot be retried', async () => {
  guard.deps.callToolkit = async (_tool, _input, key) => { calls.push(key!); throw new Error('adapter unavailable'); };
  const { row } = await propose(24, 'throw-once');
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'adapter unavailable');
  assert.ok(row.execution_started_at);
  assert.equal((await propose(24, 'throw-once')).row.id, row.id);
  await assert.rejects(guard.approve(row.id, 'Owner'), /not awaiting approval/);
  assert.equal(calls.length, 1);
});

for (const malformed of [null, 'approve', true, {}, { ...review, verdict: 'allow' }, { ...review, concerns: null }, { ...review, injection_detected: 'false' }, { ...review, summary: undefined }]) {
  test(`guard validates reviewer result: ${JSON.stringify(malformed)}`, async () => {
    guard.deps.reviewAction = async () => malformed as any;
    const { row } = await propose(24);
    assert.equal(row.status, 'awaiting_approval');
    assert.equal(row.review, null);
    assert.equal(calls.length, 0);
  });
}

test('payout event time orders nonterminal updates and terminal status is sticky even for newer events', () => {
  const id = store.recordProposal({ tool: 'send_payout', kind: 'payout', params: {}, amount: 35, decision: 'allow', checks: [], status: 'executed' });
  store.updateLedger(id, { status: 'executed', paypalRef: 'BATCH' });
  const event = (status: string, day: number) => ({ create_time: `2026-01-0${day}T00:00:00Z`, event_type: `PAYMENT.PAYOUTS-ITEM.${status}`, resource: { payout_batch_id: 'BATCH', transaction_status: status } });
  watch.handlePayPalEvent(event('UNCLAIMED', 2));
  watch.handlePayPalEvent(event('PENDING', 1));
  assert.equal(JSON.parse(store.ledgerEntry(id)!.paypal_result!).webhook_status, 'UNCLAIMED');
  watch.handlePayPalEvent(event('RETURNED', 3));
  watch.handlePayPalEvent(event('UNCLAIMED', 4));
  const result = JSON.parse(store.ledgerEntry(id)!.paypal_result!);
  assert.equal(result.webhook_status, 'RETURNED');
  assert.equal(result.webhook_time, '2026-01-03T00:00:00.000Z');
});


test('all terminal payout statuses stay terminal on later pending deliveries', () => {
  for (const status of ['SUCCESS', 'SUCCEEDED', 'RETURNED', 'FAILED', 'DENIED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'CANCELED', 'CANCELLED']) {
    const id = store.recordProposal({ tool: 'send_payout', kind: 'payout', params: {}, amount: 35, decision: 'allow', checks: [], status: 'executed' });
    const batch = `TERMINAL-${status}`;
    store.updateLedger(id, { status: 'executed', paypalRef: batch });
    watch.handlePayPalEvent({ create_time: '2026-01-01T00:00:00Z', event_type: `PAYMENT.PAYOUTS-ITEM.${status}`, resource: { payout_batch_id: batch, transaction_status: status } });
    watch.handlePayPalEvent({ create_time: '2026-01-02T00:00:00Z', event_type: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED', resource: { payout_batch_id: batch, transaction_status: 'UNCLAIMED' } });
    assert.equal(JSON.parse(store.ledgerEntry(id)!.paypal_result!).webhook_status, status);
  }
});
