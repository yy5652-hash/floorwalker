import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const dir = mkdtempSync(join(tmpdir(), 'fw-notifications-'));
process.env.FLOORWALKER_CORE_DB = join(dir, 'core.db');
process.env.FLOORWALKER_DATA_DIR = dir;
process.env.FLOORWALKER_DB = ':memory:';
process.env.BETTER_AUTH_SECRET = 'notifications-test-secret-with-enough-characters';
process.env.FLOORWALKER_DEMO_POOL = '0';
process.env.FLOORWALKER_BASE_URL = 'http://localhost:3000';
process.env.PAYPAL_CLIENT_ID = 'test';
process.env.PAYPAL_CLIENT_SECRET = 'test';
const { auth } = await import('../server/auth.ts');
const { core, openWorkspace, registerWorkspace, setWorkspacePayPal } = await import('../server/workspaces.ts');
const { inWorkspace } = await import('../server/context.ts');
const store = await import('../server/db.ts');
const { setEmailTransport } = await import('../server/email.ts');
const notify = await import('../server/notify.ts');
const actions = await import('../server/email-actions.ts');
const guard = await import('../server/guard/index.ts');
const { publish } = await import('../server/events.ts');
const { tapsPer100, learnedChanges } = await import('../server/guard/learn.ts');
const mail: import('../server/email.ts').Email[] = [];
setEmailTransport(async e => { mail.push(e); });
let calls = 0;
guard.deps.callToolkit = async () => { calls++; return { id: 'refund-1', status: 'COMPLETED' }; };
const now = Date.now();
for (const [id, role] of [['owner-user','owner'], ['approver-user','approver'], ['viewer-user','viewer']]) {
  core.prepare('INSERT INTO user(id,name,email,emailVerified,isAnonymous,createdAt,updatedAt) VALUES (?,?,?,1,0,?,?)').run(id, id, `${id}@example.com`, now, now);
}
const org = await auth.api.createOrganization({ body: { userId: 'owner-user', name: 'Notification tests', slug: 'notification-tests' } });
assert.ok(org);
registerWorkspace(org.id, { demo: false });
for (const [id, role] of [['approver-user','approver'], ['viewer-user','viewer']]) {
  core.prepare('INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES (?,?,?,?,?)').run(id, org.id, id, role, now);
}
setWorkspacePayPal(org.id, { clientId: 'test', clientSecret: 'test' });
const ws = openWorkspace(org.id);
const actor = { kind: 'system' as const, id: 'test', name: 'Test' };
const inside = <T>(fn: () => T) => inWorkspace(ws, actor, fn);
const proposal = (amount = 86, agentId?: string) => inside(() => store.recordProposal({ tool: 'create_refund', kind: 'refund', params: { captureId: 'capture', amount }, amount, counterparty: 'Daniel Okafor', decision: 'hold', status: 'awaiting_approval', agentId,
  checks: [{ id: 'auto_limit', label: 'Limit', outcome: 'hold', detail: 'This amount needs your approval.' }],
  expiresAt: new Date(Date.now() + 86400000).toISOString() }));
const token = (url: string) => new URL(url).searchParams.get('t')!;
const linkFrom = (email: import('../server/email.ts').Email, label: string) => token(email.text.split(`${label}: `)[1].split('\n')[0]);
after(() => { setEmailTransport(); ws.db.close(); core.close(); rmSync(dir, { recursive: true, force: true }); });

test('held events email every approver once, with escaped evidence, footer and single-use hashed links', async () => {
  const id = proposal();
  inside(() => { publish('action.held', guard.actionView(store.ledgerEntry(id)!)); publish('action.held', guard.actionView(store.ledgerEntry(id)!)); });
  await new Promise<void>(resolve => setImmediate(resolve));
  const held = mail.filter(e => e.tag === 'request-held');
  assert.equal(held.length, 2);
  assert.deepEqual(held.map(e => e.to).sort(), ['approver-user@example.com','owner-user@example.com']);
  for (const email of held) {
    assert.equal(email.subject, 'Approve a $86.00 refund to Daniel Okafor?');
    for (const label of ['PayPal records:', 'Your rules:', 'Limits: Needs you', 'AI review:', 'Notification settings:', ws.name, 'Expires:']) assert.ok(email.text.includes(label), label);
    assert.ok(!/<img|<script/i.test(email.html));
  }
  const t = linkFrom(held[0], 'Approve $86.00');
  assert.ok(!JSON.stringify(core.prepare('SELECT * FROM email_action').all()).includes(t));
  assert.match(await actions.emailAction(t, 'GET'), /<button type="submit">Approve \$86.00/);
  assert.equal(inside(() => store.ledgerEntry(id)!.status), 'awaiting_approval');
  assert.equal(calls, 0);
  const results = await Promise.all([actions.emailAction(t, 'POST'), actions.emailAction(t, 'POST')]);
  assert.ok(results.some(r => /Request approved/.test(r)), JSON.stringify(results));
  assert.ok(results.some(r => /already|used/.test(r)));
  assert.equal(calls, 1);
  assert.match(await actions.emailAction(linkFrom(held[1], 'Decline'), 'POST', 'No'), /already approved/);
  assert.equal((core.prepare('SELECT COUNT(*) n FROM email_action WHERE ws_id=? AND ledger_id=? AND used=0').get(ws.id,id) as { n: number }).n, 0);
  assert.ok(inside(() => ws.db.prepare("SELECT 1 FROM audit WHERE action='action.approved'").get()));
});
test('step-up refuses unsigned and signed email approvals; decline requires a reason and records it', async () => {
  const id = proposal(300);
  const approve = inside(() => token(actions.actionToken(ws, store.ledgerEntry(id)!, 'owner-user', 'approve')));
  assert.match(await actions.emailAction(approve, 'GET'), /step-up check/);
  assert.match(await actions.emailAction(approve, 'POST'), /step-up check/);
  assert.equal(inside(() => store.ledgerEntry(id)!.status), 'awaiting_approval');
  const decline = inside(() => token(actions.actionToken(ws, store.ledgerEntry(id)!, 'owner-user', 'decline')));
  assert.match(await actions.emailAction(decline, 'GET'), /textarea name="reason" required/);
  assert.match(await actions.emailAction(decline, 'POST'), /Enter a reason/);
  assert.match(await actions.emailAction(decline, 'POST', 'Wrong payee'), /Request declined/);
  assert.equal(inside(() => store.ledgerEntry(id)!.decline_reason), 'Wrong payee');
});
test('decisions outside email, expired links, frozen agents and revoked membership refuse action', async () => {
  const id = proposal();
  const t = inside(() => token(actions.actionToken(ws, store.ledgerEntry(id)!, 'owner-user', 'approve')));
  inside(() => guard.declineRequest(id, 'Owner', 'No'));
  assert.match(await actions.emailAction(t, 'POST'), /already declined/);
  const exp = proposal();
  const expired = inside(() => token(actions.actionToken(ws, store.ledgerEntry(exp)!, 'owner-user', 'approve')));
  core.prepare('UPDATE email_action SET expires_at=0 WHERE ledger_id=?').run(exp);
  assert.match(await actions.emailAction(expired, 'POST'), /expired/);
  inside(() => { store.upsertAgent({ id: 'test-agent', name: 'Test agent', role: 'support', can_refund: 1, can_payout: 0 }); store.setAgentStatus('test-agent', 'frozen'); });
  const frozenId = proposal(86, 'test-agent');
  const frozen = inside(() => token(actions.actionToken(ws, store.ledgerEntry(frozenId)!, 'owner-user', 'approve')));
  assert.match(await actions.emailAction(frozen, 'POST'), /frozen/);
  const rev = proposal();
  const revoked = inside(() => token(actions.actionToken(ws, store.ledgerEntry(rev)!, 'approver-user', 'approve')));
  core.prepare("UPDATE member SET role='viewer' WHERE userId='approver-user'").run();
  assert.match(await actions.emailAction(revoked, 'POST'), /no longer have permission/);
  core.prepare("UPDATE member SET role='approver' WHERE userId='approver-user'").run();
});
test('blocked messages explain the stop without action links; preferences suppress delivery', async () => {
  const id = inside(() => store.recordProposal({ tool: 'create_refund', kind: 'refund', params: {}, amount: 40, counterparty: '<Daniel>', decision: 'block', status: 'blocked', checks: [{id: 'buyer',label: 'Buyer', outcome: 'block', detail: 'Buyer does not match.'}] }));
  const before = mail.length;
  inside(() => notify.setPrefs('approver-user', ws.id, { email_blocked: false }));
  await inside(() => notify.emailRequest(ws, id, 'blocked'));
  assert.equal(mail.length, before + 1);
  assert.match(mail.at(-1)!.text, /Buyer does not match/);
  assert.match(mail.at(-1)!.html, /&lt;Daniel&gt;/);
  assert.ok(!mail.at(-1)!.text.includes('/email/act'));
});
test('push-delay reminder rule sends once and demo workspaces send nothing', async () => {
  const id = proposal();
  inside(() => { ws.db.prepare('UPDATE ledger SET created_at=? WHERE id=?').run(new Date(Date.now() - 7200000).toISOString(), id); });
  const before = mail.filter(e => e.tag === 'request-reminders').length;
  await inside(() => notify.remindWaiting());
  await inside(() => notify.remindWaiting());
  assert.equal(mail.filter(e => e.tag === 'request-reminders').length, before + 2);
  const count = mail.length;
  await inWorkspace({ ...ws, demo: true }, actor, async () => {
    await notify.emailRequest({ ...ws, demo: true }, proposal(), 'held');
    await notify.sendWeeklySummary(new Date('2026-11-02T09:00:00Z'));
  });
  assert.equal(mail.length, count);
});
test('weekly numbers match Overview tap, metrics and learning functions; scheduling, opt-out and empty weeks', async () => {
  const now = new Date('2026-11-02T09:00:00Z');
  inside(() => {
    ws.db.prepare('UPDATE ledger SET created_at=?').run('2026-10-27T12:00:00Z');
    const id = proposal(30); store.updateLedger(id, {status: 'executed'});
    ws.db.prepare('UPDATE ledger SET created_at=? WHERE id=?').run('2026-10-28T12:00:00Z',id);
  });
  // Evaluate the actual Overview metrics function rather than a copy of its formula.
  const index = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
  const code = index.slice(index.indexOf('const moved ='), index.indexOf('function agentsWithStats'));
  const metrics = runInNewContext(stripTypeScriptTypes(code + '\nmetrics'));
  notify.useOverviewMetrics(metrics);
  const result = inside(() => notify.weeklySummary(now));
  const rows = inside(() => store.ledger());
  const week = rows.filter(r => r.created_at >= '2026-10-26' && r.created_at < '2026-11-02');
  assert.equal(result.taps, tapsPer100(week.map(r => r.decision)));
  assert.equal(result.stopped, metrics(week).stopped);
  assert.equal(result.automatic, metrics(week.filter(r => r.status === 'executed')).moved);
  assert.equal(result.waiting, metrics(rows).waitingCount);
  assert.deepEqual(result.suggestion, inside(() => learnedChanges(store.activePolicy().policy)[0] ?? null));
  const before = mail.length;
  await inside(() => notify.sendWeeklySummary(new Date('2026-11-02T08:59:00Z')));
  assert.equal(mail.length,before);
  await inside(() => notify.sendWeeklySummary(now));
  await inside(() => notify.sendWeeklySummary(now));
  assert.equal(mail.length,before + 1);
  assert.equal(mail.at(-1)!.to, 'owner-user@example.com');
  assert.ok(mail.at(-1)!.text.includes(`Money stopped: $${result.stopped.toFixed(2)}`));
  await inside(() => notify.sendWeeklySummary(new Date('2026-12-07T09:00:00Z')));
  assert.equal(mail.length,before + 1);
  inside(() => notify.setPrefs('owner-user',ws.id,{email_weekly:false}));
  core.prepare("DELETE FROM email_notice WHERE notice LIKE 'weekly:%'").run();
  await inside(() => notify.sendWeeklySummary(now));
  assert.equal(mail.length,before + 1);
});

test('HTTP confirmation uses form POST, rejects cross-site origins, and rate-limits scanners without sockets', async () => {
  const { default: express } = await import('express');
  const { IncomingMessage, ServerResponse } = await import('node:http');
  const { Socket } = await import('node:net');
  const app = express(); app.use('/email', actions.emailActions);
  const request = (method: string, url: string, data = '', origin?: string) => new Promise<{status: number; body: string; headers: ReturnType<import('node:http').ServerResponse['getHeaders']>}>(resolve => {
    const req = new IncomingMessage(new Socket()); req.method = method; req.url = url;
    req.headers = { host: 'localhost:3000', ...(method === 'POST' ? {'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(data))} : {}), ...(origin ? {origin} : {}) };
    const res = new ServerResponse(req);
    res.end = ((chunk?: any) => { resolve({ status: res.statusCode, body: chunk?.toString() ?? '', headers: res.getHeaders() }); return res; }) as typeof res.end;
    app(req, res);
    if (data) req.push(data);
    req.push(null);
  });
  const id = proposal();
  const t = inside(() => token(actions.actionToken(ws, store.ledgerEntry(id)!, 'owner-user', 'approve')));
  const before = calls;
  const get = await request('GET', `/email/act?t=${t}`);
  assert.match(get.body, /method="post"/);
  assert.equal(get.headers['cache-control'], 'no-store');
  assert.equal(get.headers['referrer-policy'], 'no-referrer');
  assert.equal(calls,before);
  assert.equal((await request('POST','/email/act', `t=${t}`, 'https://other.example')).status,403);
  assert.match((await request('POST','/email/act', `t=${t}`, 'http://localhost:3000')).body, /Request approved/);
  assert.match((await request('POST','/email/act', `t=${t}`)).body, /already approved/);
  assert.equal(calls,before+1);
  for (let i=0; i<27; i++) await request('GET','/email/act?t=invalid');
  const limited = await request('GET','/email/act?t=invalid');
  assert.equal(limited.status,429);
});
