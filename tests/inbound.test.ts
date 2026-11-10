import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
const dir = mkdtempSync(join(tmpdir(), 'fw-inbound-'));
process.env.FLOORWALKER_CORE_DB = join(dir, 'core.db');
process.env.FLOORWALKER_DATA_DIR = dir;
process.env.FLOORWALKER_DB = ':memory:';
process.env.BETTER_AUTH_SECRET = 'inbound-test-secret-with-enough-characters';
process.env.FLOORWALKER_DEMO_POOL = '0';
process.env.FLOORWALKER_INBOUND_DOMAIN = 'in.floorwalker.test';
const SECRET = 'whsec_' + Buffer.from('inbound-test-signing-key-32-bytes').toString('base64');
process.env.RESEND_WEBHOOK_SECRET = SECRET;
process.env.RESEND_API_KEY = ''; // set, so the real key in .env is not loaded
const { auth } = await import('../server/auth.ts');
const store = await import('../server/db.ts');
const { inWorkspace } = await import('../server/context.ts');
const { core, openWorkspace, registerWorkspace, removeWorkspace } = await import('../server/workspaces.ts');
const inbound = await import('../server/inbound.ts');
const { config } = await import('../server/config.ts');
const { setEmailTransport } = await import('../server/email.ts');
const { createKey } = await import('../server/keys.ts');
const { v1 } = await import('../server/v1.ts');
const mail: import('../server/email.ts').Email[] = [];
const actor = { kind: 'system' as const, id: 'test', name: 'Test' };
let sequence = 0;
function workspace() {
  const id = `inbound-${++sequence}`;
  registerWorkspace(id, { demo: false });
  core.prepare('INSERT INTO organization(id,name,slug,createdAt) VALUES (?,?,?,?)').run(id, 'Test Shop', id, Date.now());
  const ws = openWorkspace(id);
  const run = <T>(fn: () => T) => inWorkspace(ws, actor, fn);
  const address = run(() => inbound.inboxSettings().address)!;
  return { ws, run, token: address.split('@')[0] };
}
const payload = (token: string, id = `message-${++sequence}`): any => ({ to: [`${token}@in.floorwalker.test`], message_id: id,
  from: 'A Customer <buyer@example.com>', subject: 'Help with order', text: 'Original email', headers: { date: '2026-11-03T10:00:00Z' } });
const event = (data: any) => ({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: randomUUID(), ...data } });
const deliver = (data: any) => inbound.receiveResend(event(data));
const sign = (body: string, id = 'msg_test', ts = String(Math.floor(Date.now() / 1000))) =>
  ({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}` });
beforeEach(() => { mail.length = 0; setEmailTransport(async e => { mail.push(e); }); inbound.setInboundRunner(); config.mailFrom = 'floorwalker@example.com'; });
after(() => { setEmailTransport(); core.close(); rmSync(dir, { recursive: true, force: true }); });

// Re-evaluate the startup module against the existing files, with a fresh core handle.
async function backfill() {
  const restarted = await import(`../server/workspaces.ts?backfill=${randomUUID()}`);
  restarted.core.close();
}

test('routing uses the token index and opens only the matching one of two workspaces', async t => {
  const a = workspace(), b = workspace();
  const opened: string[] = [];
  const prepare = core.prepare.bind(core);
  t.mock.method(core, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql === 'SELECT * FROM workspace WHERE id = ?') {
      const get = statement.get.bind(statement);
      t.mock.method(statement, 'get', (id: string) => { opened.push(id); return get(id); });
    }
    assert.doesNotMatch(sql, /^SELECT id FROM workspace$/);
    return statement;
  });
  // With no index entry there must be no fallback scan of workspace databases.
  core.prepare('DELETE FROM inbound_tokens WHERE workspace_id = ?').run(a.ws.id);
  assert.deepEqual(await deliver(payload(a.token)), { ok: true });
  assert.deepEqual(opened, []);
  core.prepare('INSERT INTO inbound_tokens (token, workspace_id) VALUES (?, ?)').run(a.token, a.ws.id);
  assert.ok('id' in await deliver(payload(a.token)));
  assert.deepEqual(opened, [a.ws.id]);
  assert.equal(a.run(() => store.tickets().length), 1);
  assert.equal(b.run(() => store.tickets().length), 0);
});

test('unknown and rotated tokens keep the drop response and log, even with a stale index', async t => {
  const h = workspace();
  const logs: unknown[][] = [];
  t.mock.method(console, 'info', (...args: unknown[]) => { logs.push(args); });
  const current = h.run(() => inbound.rotateAddress()).address!.split('@')[0];
  assert.equal(core.prepare('SELECT 1 FROM inbound_tokens WHERE token = ?').get(h.token), undefined);
  assert.deepEqual(await deliver(payload('unknown-token')), { ok: true });
  assert.deepEqual(await deliver(payload(h.token)), { ok: true });
  // The current workspace token must still be verified after an index hit.
  core.prepare('UPDATE inbound_tokens SET token = ? WHERE workspace_id = ?').run(h.token, h.ws.id);
  assert.deepEqual(await deliver(payload(h.token)), { ok: true });
  assert.deepEqual(logs, Array.from({ length: 3 }, () => ['Inbound email dropped: unknown or rotated mailbox']));
  assert.equal(h.run(() => store.tickets().length), 0);
  core.prepare('UPDATE inbound_tokens SET token = ? WHERE workspace_id = ?').run(current, h.ws.id);
  assert.ok('id' in await deliver(payload(current)));
});

test('startup backfills JSON-encoded tokens set before the index row existed', async () => {
  const h = workspace();
  h.run(() => store.setSetting('inbound.token', 'legacy-token'));
  core.prepare('DELETE FROM inbound_tokens WHERE workspace_id = ?').run(h.ws.id);
  await backfill();
  assert.equal((core.prepare('SELECT workspace_id FROM inbound_tokens WHERE token = ?').get('legacy-token') as { workspace_id: string }).workspace_id, h.ws.id);
  assert.ok('id' in await deliver(payload('legacy-token')));
  assert.equal(h.run(() => store.tickets().length), 1);
});

test('deleted workspace tokens are dropped, including stale index entries', async t => {
  const h = workspace();
  removeWorkspace(h.ws.id);
  assert.equal(core.prepare('SELECT 1 FROM inbound_tokens WHERE token = ?').get(h.token), undefined);
  const info = t.mock.method(console, 'info', () => {});
  assert.deepEqual(await deliver(payload(h.token)), { ok: true });
  core.prepare('INSERT INTO inbound_tokens (token, workspace_id) VALUES (?, ?)').run(h.token, h.ws.id);
  assert.deepEqual(await deliver(payload(h.token)), { ok: true });
  assert.deepEqual(info.mock.calls.map(call => call.arguments), Array.from({ length: 2 }, () => ['Inbound email dropped: unknown or rotated mailbox']));
  core.prepare('DELETE FROM inbound_tokens WHERE workspace_id = ?').run(h.ws.id);
});

test('startup skips files without settings, corrupt files and invalid JSON, and closes every opened database', async t => {
  const badIds = ['missing-settings', 'corrupt-workspace', 'invalid-settings'];
  for (const id of badIds) registerWorkspace(id, { demo: false });
  const empty = new DatabaseSync(join(dir, `${badIds[0]}.db`)); empty.close();
  writeFileSync(join(dir, `${badIds[1]}.db`), 'not a sqlite database');
  const invalid = new DatabaseSync(join(dir, `${badIds[2]}.db`));
  invalid.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('inbound.token', 'unparsable')");
  invalid.close();
  const healthy = workspace();
  core.prepare('DELETE FROM inbound_tokens WHERE workspace_id = ?').run(healthy.ws.id);
  const opened = new Set<DatabaseSync>(), closed = new Set<DatabaseSync>();
  const prepare = DatabaseSync.prototype.prepare, close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT value FROM settings WHERE key = 'inbound.token'") opened.add(this);
    return prepare.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) { closed.add(this); return close.call(this); });
  await assert.doesNotReject(backfill());
  assert.ok(opened.size >= badIds.length);
  for (const db of opened) assert.ok(closed.has(db), 'backfill must close each database even on failure');
  for (const id of badIds) assert.equal(core.prepare('SELECT 1 FROM inbound_tokens WHERE workspace_id = ?').get(id), undefined);
  assert.ok(core.prepare('SELECT 1 FROM inbound_tokens WHERE token = ?').get(healthy.token));
});

test('webhook signature fails closed: wrong secret, stale timestamp, tampered body, missing headers', () => {
  const body = JSON.stringify(event(payload('x')));
  assert.equal(inbound.authorized(sign(body), body), true);
  assert.equal(inbound.authorized({ ...sign(body), 'svix-signature': 'v1,AAAA v1,' + sign(body)['svix-signature'].slice(3) }, body), true);
  assert.equal(inbound.authorized(sign(body), body + ' '), false);
  assert.equal(inbound.authorized(sign(body, 'msg', String(Math.floor(Date.now() / 1000) - 400)), body), false);
  assert.equal(inbound.authorized({}, body), false);
  process.env.RESEND_WEBHOOK_SECRET = ''; assert.equal(inbound.authorized(sign(body), body), false); process.env.RESEND_WEBHOOK_SECRET = SECRET;
});
test('routes by recipient token, de-duplicates message_id, drops unknown and rotated addresses', async () => {
  const a = workspace(), b = workspace();
  const p = { ...payload(a.token), to: ['help@shop.example'], received_for: [`${a.token}@in.floorwalker.test`], headers: { date: '2026-11-03T10:00:00Z', references: '<older@example.com>' }, attachments: [{ id: 'att', filename: 'photo.jpg' }] };
  const result = await deliver(p);
  assert.equal(a.run(() => store.tickets().length), 1); assert.equal(b.run(() => store.tickets().length), 0);
  const t = a.run(() => store.tickets()[0]);
  assert.equal(t.body, 'Original email'); assert.equal(t.from_name, 'A Customer'); assert.equal(t.from_email, 'buyer@example.com');
  assert.equal(Date.parse(t.received_at), Date.parse(p.headers.date)); assert.equal(t.thread_references, '<older@example.com>'); assert.match(t.attachment_note!, /1 attachment/);
  assert.equal((await deliver(p)).duplicate, true);
  assert.equal(a.run(() => inbound.inboxSettings().received), true);
  assert.deepEqual(await deliver(payload('unknown')), { ok: true });
  assert.deepEqual(await deliver({ ...payload(a.token), to: [`${a.token}@other.example`] }), { ok: true });
  const rotated = a.run(() => inbound.rotateAddress()); assert.notEqual(rotated.address?.split('@')[0], a.token);
  assert.deepEqual(await deliver(payload(a.token)), { ok: true });
  assert.equal(a.run(() => store.tickets().length), 1); assert.ok('id' in result);
});
test('with an API key the body is fetched from Resend, never taken from the event', async () => {
  const h = workspace(); process.env.RESEND_API_KEY = 'test-key'; const asked: string[] = [];
  inbound.setReceivedFetcher(async id => { asked.push(id); return { ...payload(h.token), text: 'Fetched body' }; });
  try {
    await inbound.receiveResend({ type: 'email.received', data: { email_id: 'em_1', to: [`${h.token}@in.floorwalker.test`], text: 'Event body' } });
    assert.deepEqual(asked, ['em_1']); assert.equal(h.run(() => store.tickets()[0].body), 'Fetched body');
    assert.deepEqual(await inbound.receiveResend({ type: 'email.sent', data: {} }), { ok: true, ignored: true });
  } finally { delete process.env.RESEND_API_KEY; inbound.setReceivedFetcher(); }
});
test('HTML fallback is plain text', async () => {
  const h = workspace();
  await deliver({ ...payload(h.token), text: '', html: '<style>bad</style><p>Hello &amp; welcome</p><script>bad</script>' });
  const body = h.run(() => store.tickets()[0].body);
  assert.match(body, /Hello & welcome/); assert.doesNotMatch(body, /bad|<p>/);
});
test('skips automatic/bulk mail without storing its content, and records skipped deduplication', async () => {
  const h = workspace();
  for (const headers of [{ 'auto-submitted': 'auto-replied' }, { Precedence: 'list' }]) {
    const p = { ...payload(h.token), headers }; assert.equal((await deliver(p)).skipped, true); assert.equal((await deliver(p)).duplicate, true);
  }
  assert.equal((await deliver({ ...payload(h.token), from: 'mailer-daemon@example.com' })).skipped, true);
  assert.equal(h.run(() => store.tickets().length), 0);
  const data = h.run(() => inbound.inboxSettings()); assert.equal(data.received, false); assert.equal(data.skipped.length, 3); assert.ok(!JSON.stringify(data.skipped).includes('Original email'));
});
test('forwarding confirmations require sender and subject; link host is allowlisted', async () => {
  const h = workspace();
  await deliver({ ...payload(h.token), from: 'Gmail Team <forwarding-noreply@google.com>', subject: 'Gmail Forwarding Confirmation', text: 'Confirmation code: 123456789\nhttps://evil.example/\nhttps://mail.google.com/mail/vf-abc', headers: { 'auto-submitted': 'auto-generated' } });
  const data = h.run(() => inbound.inboxSettings()); assert.equal(data.confirmations.length, 1); assert.equal(data.received, false);
  assert.equal(data.confirmations[0].confirmation_link, 'https://mail.google.com/mail/vf-abc'); assert.equal(data.confirmations[0].confirmation_code, '123456789');
  assert.ok(inbound.confirmation('forwarding@outlook.com', 'Confirm your email forwarding', 'https://outlook.live.com/confirm', ''));
  assert.equal(inbound.confirmation('attacker@example.com', 'Gmail Forwarding Confirmation', '', ''), null);
  assert.equal(inbound.confirmation('forwarding-noreply@google.com', 'Normal message', '', ''), null);
});
test('manual/API messages are idempotent by external_id within each workspace and do not run by default', async () => {
  const a = workspace(), b = workspace(); let runs = 0; inbound.setInboundRunner(async () => { runs++; });
  const input = { from_email: 'buyer@example.com', subject: 'Help', body: 'Please help', external_id: 'same-helpdesk-id' };
  const first = a.run(() => inbound.addMessage(input));
  const second = a.run(() => inbound.addMessage({ ...input, body: 'Different', run: true }));
  assert.equal(second.duplicate, true); assert.equal(first.ticket.id, second.ticket.id); assert.equal(second.ticket.body, input.body);
  assert.notEqual(b.run(() => inbound.addMessage(input)).ticket.id, first.ticket.id);
  await new Promise(r => setImmediate(r)); assert.equal(runs, 0);
  assert.equal(a.run(() => inbound.inboxSettings().auto_run), false); assert.equal(a.run(() => inbound.inboxSettings().auto_send), false);
});
test('automatic runs serialize per workspace and confirmations never run', async () => {
  const h = workspace(); h.ws.paypal = { clientId: 'test', clientSecret: 'test' }; const original = config.ai.configured; config.ai.configured = true;
  let active = 0, max = 0; const ran: string[] = []; let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  inbound.setInboundRunner(async id => { active++; max = Math.max(max, active); ran.push(id); await gate; active--; });
  try {
    h.run(() => inbound.saveInboxSettings({ support_address: '', auto_run: true, auto_send: false }));
    h.run(() => { inbound.addMessage({ from_email: 'buyer@example.com', subject: 'One', body: 'One' }); inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Two', body: 'Two' }); inbound.addMessage({ from_email: 'forwarding-noreply@google.com', subject: 'Confirm', body: 'Confirm' }, { inbound_kind: 'confirmation' }); });
    assert.equal(active, 1); assert.equal(ran.length, 1); assert.equal(inbound.running.has(h.ws.id), true);
    unblock();
    for (let i = 0; i < 10 && inbound.running.has(h.ws.id); i++) await new Promise(r => setImmediate(r));
    assert.equal(ran.length, 2); assert.equal(max, 1); assert.equal(inbound.running.has(h.ws.id), false);
  } finally { unblock(); config.ai.configured = original; inbound.setInboundRunner(); }
});
test('reply requires support address; sends shop identity and threading headers; repeat requires confirmation', async () => {
  const h = workspace();
  const t = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'My order', body: 'Please help' }, { message_id: '<current@example.com>', thread_references: '<older@example.com>' }).ticket);
  h.run(() => store.closeTicket(t.id, 'Here is your reply.'));
  await assert.rejects(h.run(() => inbound.sendReply(t.id)), /support address/); assert.equal(mail.length, 0);
  h.run(() => inbound.saveInboxSettings({ support_address: 'help@shop.example', auto_run: false, auto_send: false }));
  await h.run(() => inbound.sendReply(t.id));
  assert.equal(mail[0].to, 'buyer@example.com'); assert.equal(mail[0].subject, 'Re: My order');
  assert.equal(mail[0].replyTo, 'help@shop.example'); assert.equal(mail[0].from, '"Test Shop via Floorwalker" <floorwalker@example.com>');
  assert.deepEqual(mail[0].headers, [{ Name: 'In-Reply-To', Value: '<current@example.com>' }, { Name: 'References', Value: '<older@example.com> <current@example.com>' }]);
  assert.ok(h.run(() => store.ticket(t.id)?.reply_sent_at));
  await assert.rejects(h.run(() => inbound.sendReply(t.id)), /Confirm/); assert.equal(mail.length, 1);
  await h.run(() => inbound.sendReply(t.id, true)); assert.equal(mail.length, 2);
});
test('automatic sending refuses held/blocked moves even when reply text claims success', async () => {
  const h = workspace(); h.run(() => inbound.saveInboxSettings({ support_address: 'help@shop.example', auto_run: false, auto_send: true }));
  for (const decision of ['hold', 'block'] as const) {
    const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Refund', body: 'Refund please' }).ticket.id);
    h.run(() => { store.closeTicket(id, 'Your refund is complete.'); store.recordProposal({ ticketId: id, tool: 'create_refund', kind: 'refund', params: {}, amount: 10, decision, status: decision === 'hold' ? 'awaiting_approval' : 'blocked', checks: [] }); });
    await h.run(() => inbound.maybeSendReply(id));
  }
  assert.equal(mail.length, 0);
});
test('legacy owner sections are split on read and never included in manual or automatic mail', async () => {
  const h = workspace();
  h.run(() => inbound.saveInboxSettings({ support_address: 'help@shop.example', auto_run: false, auto_send: true }));
  for (const auto of [false, true]) {
    const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Help', body: 'Help' }).ticket.id);
    h.run(() => store.db().prepare('UPDATE tickets SET reply=?, status=? WHERE id=?')
      .run('Customer reply:\nThank you for writing.\n\n**Owner to-do note:**\nPrivate owner instructions.', 'handled', id));
    const ticket = h.run(() => store.ticket(id))!;
    assert.equal(ticket.reply, 'Thank you for writing.');
    assert.equal(ticket.internal_note, 'Private owner instructions.');
    assert.deepEqual(h.run(store.tickets).find(t => t.id === id), ticket);
    await h.run(() => auto ? inbound.maybeSendReply(id) : inbound.sendReply(id));
    assert.equal(mail.at(-1)!.text, 'Thank you for writing.');
    assert.doesNotMatch(mail.at(-1)!.html, /Private|Owner to-do/);
  }
  assert.equal(mail.length, 2);
  assert.deepEqual(store.splitTicketReply('Internal note: Private\n\nReply to customer — not sent:\nHello.'), { reply: 'Hello.', internalNote: 'Private' });
  assert.deepEqual(store.splitTicketReply('## Internal notes (not for the customer):\nPrivate\n\nCustomer reply draft (not sent):\nHello.'), { reply: 'Hello.', internalNote: 'Private' });
  assert.deepEqual(store.splitTicketReply('An ordinary reply.'), { reply: 'An ordinary reply.', internalNote: '' });
});
test('opening an old ticket database adds reply fields without losing customer text or owner notes', () => {
  const path = join(dir, 'legacy-tickets.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE tickets (id TEXT PRIMARY KEY, channel TEXT, from_name TEXT, from_email TEXT, subject TEXT, body TEXT,
    received_at TEXT, status TEXT, reply TEXT);
    INSERT INTO tickets VALUES ('legacy', 'email', 'Buyer', 'buyer@example.com', 'Help', 'Help', '2026-11-10', 'handled', 'Hello.\nOwner to-do note: Private.');`);
  old.close();
  const upgraded = store.openDb(path), h = workspace();
  try {
    inWorkspace({ ...h.ws, db: upgraded }, actor, () => {
      const ticket = store.ticket('legacy')!;
      assert.equal(ticket.reply, 'Hello.'); assert.equal(ticket.internal_note, 'Private.');
      assert.equal(ticket.reply_stale, false); assert.equal(ticket.needs_follow_up, 0);
      assert.equal(store.db().prepare('SELECT reply FROM tickets WHERE id=?').get('legacy')!.reply, 'Hello.\nOwner to-do note: Private.');
    });
  } finally { upgraded.close(); }
});
test('new separate notes and notes pasted into edited drafts stay out of outgoing payloads', async () => {
  const h = workspace();
  h.run(() => inbound.saveInboxSettings({ support_address: 'help@shop.example', auto_run: false, auto_send: true }));
  for (const auto of [false, true]) {
    const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Help', body: 'Help' }).ticket.id);
    h.run(() => store.closeTicket(id, 'Hello.', { internalNote: 'Private owner task.' }));
    if (!auto) await h.run(() => inbound.sendReply(id, false, { action: 'save', reply: 'Thanks.\nInternal note: More private work.' }));
    await h.run(() => auto ? inbound.maybeSendReply(id) : inbound.sendReply(id));
    assert.doesNotMatch(JSON.stringify(mail.at(-1)), /Private|private|Internal note/);
    assert.match(h.run(() => store.ticket(id))!.internal_note!, /Private owner task/);
  }
  assert.equal(mail.length, 2);
});
test('every changed payment outcome marks the draft stale; manual send needs separate current confirmation', async () => {
  const h = workspace();
  h.run(() => inbound.saveInboxSettings({ support_address: 'help@shop.example', auto_run: false, auto_send: true }));
  for (const status of ['approved', 'declined', 'executed', 'failed'] as const) {
    const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Refund', body: 'Please refund' }).ticket.id);
    const entryId = h.run(() => store.recordProposal({ ticketId: id, tool: 'create_refund', kind: 'refund', params: {}, amount: 24, decision: 'allow', status: 'awaiting_approval', checks: [] }));
    h.run(() => store.closeTicket(id, 'Your refund was requested.'));
    assert.equal(h.run(() => store.ticket(id))!.reply_stale, false);
    h.run(() => store.updateLedger(entryId, { status }));
    assert.equal(h.run(() => store.ticket(id))!.reply_stale, true);
    await h.run(() => inbound.maybeSendReply(id));
    await assert.rejects(h.run(() => inbound.sendReply(id, true)), /review and confirm/);
    await h.run(() => inbound.sendReply(id, false, { action: 'save', reply: 'Edited wording.' }));
    assert.equal(h.run(() => store.ticket(id))!.reply_stale, true);
    const ticket = h.run(() => store.ticket(id))!;
    await assert.rejects(h.run(() => inbound.sendReply(id, false, { confirm_stale: true, payment_snapshot: 'old' })), /Payment status changed/);
    await h.run(() => inbound.sendReply(id, false, { confirm_stale: true, payment_snapshot: ticket.current_payment_snapshot }));
  }
  assert.equal(mail.length, 4);
});
test('legacy payment drafts are conservatively stale and handoffs never auto-send', async () => {
  const h = workspace();
  h.run(() => inbound.saveInboxSettings({ support_address: 'help@shop.example', auto_run: false, auto_send: true }));
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Help', body: 'Help' }).ticket.id);
  h.run(() => {
    store.recordProposal({ ticketId: id, tool: 'create_refund', kind: 'refund', params: {}, amount: 10, decision: 'allow', status: 'executed', checks: [] });
    store.db().prepare('UPDATE tickets SET reply=? WHERE id=?').run('An older draft.', id);
  });
  assert.equal(h.run(() => store.ticket(id))!.reply_stale, true);
  h.run(() => store.closeTicket(id, 'We will verify this request.', { internalNote: 'Owner must verify.', needsFollowUp: true }));
  await h.run(() => inbound.maybeSendReply(id));
  assert.equal(mail.length, 0);
});
test('update-reply uses a text-only request, preserves internal notes and cannot move money', async t => {
  const { anthropic } = await import('../server/llm.ts');
  const provider = config.ai.provider; config.ai.provider = 'anthropic';
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Refund', body: 'Refund please' }).ticket.id);
  const entryId = h.run(() => store.recordProposal({ ticketId: id, tool: 'create_refund', kind: 'refund', params: {}, amount: 24, decision: 'hold', status: 'awaiting_approval', checks: [] }));
  h.run(() => { store.closeTicket(id, 'Awaiting review.', { internalNote: 'Private owner note.' }); store.updateLedger(entryId, { status: 'executed', paypalRef: 'SANDBOX-REF' }); });
  const before = h.run(store.ledger);
  t.mock.method(anthropic().messages, 'parse', async (request: any) => {
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    const data = JSON.parse(request.messages[0].content);
    assert.equal(data.old_draft, 'Awaiting review.');
    assert.equal(data.current_ledger[0].status, 'executed');
    assert.equal(data.current_ledger[0].paypal_ref, 'SANDBOX-REF');
    assert.doesNotMatch(request.messages[0].content, /Private owner note/);
    return { parsed_output: { customer_reply: 'The refund was submitted to PayPal sandbox.' } };
  });
  try {
    const updated = await h.run(() => inbound.sendReply(id, false, { action: 'update' }));
    assert.equal(updated!.reply_stale, false);
    assert.equal(updated!.internal_note, 'Private owner note.');
    assert.equal(updated!.reply, 'The refund was submitted to PayPal sandbox.');
    assert.deepEqual(h.run(store.ledger), before);
    assert.equal(mail.length, 0);
  } finally { config.ai.provider = provider; }
});
test('approved payments are described as submitted, not waiting for the owner', async t => {
  const { anthropic } = await import('../server/llm.ts');
  const provider = config.ai.provider; config.ai.provider = 'anthropic';
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Refund', body: 'Refund please' }).ticket.id);
  const entryId = h.run(() => store.recordProposal({ ticketId: id, tool: 'create_refund', kind: 'refund', params: {}, amount: 86, decision: 'hold', status: 'awaiting_approval', checks: [] }));
  h.run(() => { store.closeTicket(id, 'Awaiting review.'); store.updateLedger(entryId, { status: 'approved', paypalRef: 'APPROVED-SANDBOX' }); });
  t.mock.method(anthropic().messages, 'parse', async (request: any) => {
    assert.match(request.system, /Both approved .* and executed .* mean successfully submitted to PayPal sandbox/);
    assert.equal(JSON.parse(request.messages[0].content).current_ledger[0].status, 'approved');
    assert.equal(request.tools, undefined);
    return { parsed_output: { customer_reply: 'Your refund was submitted to PayPal sandbox.' } };
  });
  try {
    const updated = await h.run(() => inbound.sendReply(id, false, { action: 'update' }));
    assert.equal(updated!.reply_stale, false);
    assert.doesNotMatch(updated!.reply!, /Awaiting review/);
  } finally { config.ai.provider = provider; }
});
test('a decision during reply rewriting still leaves the rewritten draft stale', async t => {
  const { anthropic } = await import('../server/llm.ts');
  const provider = config.ai.provider; config.ai.provider = 'anthropic';
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Refund', body: 'Refund please' }).ticket.id);
  const entryId = h.run(() => store.recordProposal({ ticketId: id, tool: 'create_refund', kind: 'refund', params: {}, amount: 24, decision: 'hold', status: 'awaiting_approval', checks: [] }));
  h.run(() => store.closeTicket(id, 'Awaiting review.'));
  t.mock.method(anthropic().messages, 'parse', async () => {
    h.run(() => store.updateLedger(entryId, { status: 'declined' }));
    return { parsed_output: { customer_reply: 'The refund is under review.' } };
  });
  try {
    const updated = await h.run(() => inbound.sendReply(id, false, { action: 'update' }));
    assert.equal(updated!.reply_stale, true);
  } finally { config.ai.provider = provider; }
});
test('Gemini update-reply also sends no tools', async t => {
  const { gemini } = await import('../server/llm.ts');
  const provider = config.ai.provider, key = process.env.GEMINI_API_KEY;
  config.ai.provider = 'gemini'; process.env.GEMINI_API_KEY = 'reply-test-key';
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Help', body: 'Help' }).ticket.id);
  h.run(() => store.closeTicket(id, 'Old draft.'));
  t.mock.method(gemini().models, 'generateContent', async (request: any) => {
    assert.equal(request.config.tools, undefined);
    assert.equal(request.config.toolConfig, undefined);
    return { text: JSON.stringify({ customer_reply: 'Updated draft.' }) };
  });
  try {
    const updated = await h.run(() => inbound.sendReply(id, false, { action: 'update' }));
    assert.equal(updated!.reply, 'Updated draft.');
    assert.equal(mail.length, 0); assert.equal(h.run(store.ledger).length, 0);
  } finally { config.ai.provider = provider; if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; }
});
test('agent output stores internal notes and handoff data separately', async t => {
  const { anthropic } = await import('../server/llm.ts');
  const { handleTicket } = await import('../server/agent/run.ts');
  const provider = config.ai.provider; config.ai.provider = 'anthropic';
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Help', body: 'Help' }).ticket.id);
  t.mock.method(anthropic().messages, 'create', async (request: any) => {
    assert.match(request.system, /Never promise returns/);
    return { content: [{ type: 'text', text: JSON.stringify({ customer_reply: 'Thanks for writing.', internal_note: 'Owner must verify.', needs_follow_up: true }) }] };
  });
  try {
    const events: import('../server/agent/run.ts').AgentEvent[] = [];
    await h.run(() => handleTicket(id, e => events.push(e)));
    const ticket = h.run(() => store.ticket(id))!;
    assert.equal(ticket.reply, 'Thanks for writing.');
    assert.equal(ticket.internal_note, 'Owner must verify.');
    assert.equal(ticket.needs_follow_up, 1);
    assert.deepEqual(events.filter(e => e.type === 'reply'), [{ type: 'reply', text: 'Thanks for writing.' }]);
  } finally { config.ai.provider = provider; }
});
test('an owner decision during a read-only agent tool does not make the draft look current', async t => {
  const { anthropic } = await import('../server/llm.ts');
  const { handleTicket } = await import('../server/agent/run.ts');
  const provider = config.ai.provider; config.ai.provider = 'anthropic';
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Help', body: 'Help' }).ticket.id);
  const entryId = h.run(() => store.recordProposal({ ticketId: id, tool: 'create_refund', kind: 'refund', params: {}, amount: 24, decision: 'hold', status: 'awaiting_approval', checks: [] }));
  let calls = 0;
  t.mock.method(anthropic().messages, 'create', async () => {
    if (!calls++) {
      h.run(() => store.updateLedger(entryId, { status: 'declined' }));
      return { content: [{ type: 'tool_use', id: 'read-orders', name: 'find_customer_orders', input: { email: 'buyer@example.com' } }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ customer_reply: 'Under review.', internal_note: '', needs_follow_up: false }) }] };
  });
  try {
    await h.run(() => handleTicket(id, () => {}));
    assert.equal(h.run(() => store.ticket(id))!.reply_stale, true);
  } finally { config.ai.provider = provider; }
});
test('payment-change handoff records follow-up without a model or money request', async t => {
  const { handleTicket } = await import('../server/agent/run.ts');
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'payee@example.com', subject: 'New PayPal email', body: 'Please change my payment address to new@example.com.' }).ticket.id);
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('Handoff must not call external APIs'); });
  await h.run(() => handleTicket(id, () => {}));
  assert.equal(h.run(() => store.ticket(id))!.needs_follow_up, 1);
  assert.match(h.run(() => store.ticket(id))!.internal_note!, /known channel/);
  assert.equal(h.run(store.ledger).length, 0);
});
test('malformed agent output cannot become a customer reply containing internal JSON fields', async t => {
  const { anthropic } = await import('../server/llm.ts');
  const { handleTicket } = await import('../server/agent/run.ts');
  const provider = config.ai.provider; config.ai.provider = 'anthropic';
  const h = workspace();
  const id = h.run(() => inbound.addMessage({ from_email: 'buyer@example.com', subject: 'Help', body: 'Help' }).ticket.id);
  t.mock.method(anthropic().messages, 'create', async () => ({ content: [{ type: 'text', text: 'Here is the result: {"customer_reply":"Hello", "internal_note":"Private"}' }] }));
  try {
    await assert.rejects(h.run(() => handleTicket(id, () => {})));
    assert.equal(h.run(() => store.ticket(id))!.reply, null);
    assert.equal(mail.length, 0);
  } finally { config.ai.provider = provider; }
});
test('outbound Resend payload carries custom From, Reply-To and thread headers', async t => {
  const { sendEmail } = await import('../server/email.ts');
  const old = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 'fake'; setEmailTransport();
  let payload: any, url = '', auth = '';
  t.mock.method(globalThis, 'fetch', async (u: any, options: any) => { url = String(u); auth = options.headers.Authorization; payload = JSON.parse(options.body); return Response.json({ id: 'sent' }); });
  try {
    await sendEmail({ to: 'buyer@example.com', subject: 'Re: Order', text: 'Reply', html: '<p>Reply</p>', tag: 'support-reply', from: '"Shop via Floorwalker" <fw@example.com>', replyTo: 'help@example.com', headers: [{ Name: 'In-Reply-To', Value: '<original>' }] });
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(auth, 'Bearer fake');
    assert.equal(payload.from, '"Shop via Floorwalker" <fw@example.com>'); assert.equal(payload.reply_to, 'help@example.com');
    assert.deepEqual(payload.headers, { 'In-Reply-To': '<original>' }); assert.deepEqual(payload.tags, [{ name: 'category', value: 'support-reply' }]);
  } finally { if (old === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = old; }
});
test('HTTP webhook verifies the signature over the raw body and enforces the 1 MB limit', async t => {
  const app = express(); app.use(inbound.resendInbound); app.use(express.json()); const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); }); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inbound/resend`;
  const h = workspace(); const body = JSON.stringify(event(payload(h.token)));
  assert.equal((await fetch(base, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await fetch(base, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...sign(body) } })).status, 200);
  assert.equal(h.run(() => store.tickets().length), 1);
  const big = JSON.stringify(event({ ...payload(h.token), html: 'x'.repeat(1100000) }));
  assert.equal((await fetch(base, { method: 'POST', body: big, headers: { 'Content-Type': 'application/json', ...sign(big) } })).status, 413);
});
test('POST /v1/messages uses agent authentication and persists idempotently', async t => {
  const h = workspace(); h.run(() => store.upsertAgent({ id: 'support', name: 'Support', role: 'Support', can_refund: 1, can_payout: 0 }));
  const { secret } = createKey({ wsId: h.ws.id, agentId: 'support', name: 'Test key', createdBy: 'Owner' });
  const app = express(); app.use(express.json()); app.use('/v1', v1); const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); }); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = (authorized: boolean) => fetch(base + '/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ from_email: 'buyer@example.com', subject: 'Order help', body: 'Please help', external_id: 'external-http-id' }) });
  assert.equal((await send(false)).status, 401); const first = await send(true); assert.equal(first.status, 200);
  const a = await first.json(), b = await (await send(true)).json(); assert.equal(a.ticket.id, b.ticket.id); assert.equal(b.duplicate, true); assert.equal(h.run(() => store.tickets().length), 1);
  const spec = await (await fetch(base + '/v1/openapi.json')).json(); assert.ok(spec.paths['/messages'].post.requestBody);
});
