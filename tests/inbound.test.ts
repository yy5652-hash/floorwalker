import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
const dir = mkdtempSync(join(tmpdir(), 'fw-inbound-'));
process.env.FLOORWALKER_CORE_DB = join(dir, 'core.db');
process.env.FLOORWALKER_DATA_DIR = dir;
process.env.FLOORWALKER_DB = ':memory:';
process.env.BETTER_AUTH_SECRET = 'inbound-test-secret-with-enough-characters';
process.env.FLOORWALKER_DEMO_POOL = '0';
process.env.POSTMARK_INBOUND_ADDRESS = 'hash@inbound.postmarkapp.com';
process.env.POSTMARK_INBOUND_USER = 'inbound-test';
process.env.POSTMARK_INBOUND_PASSWORD = 'test-password';
const { auth } = await import('../server/auth.ts');
const store = await import('../server/db.ts');
const { inWorkspace } = await import('../server/context.ts');
const { core, openWorkspace, registerWorkspace } = await import('../server/workspaces.ts');
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
  return { ws, run, token: address.split('+')[1].split('@')[0] };
}
const payload = (token: string, id = `message-${++sequence}`) => ({ MailboxHash: token, MessageID: id,
  FromFull: { Email: 'buyer@example.com', Name: 'A Customer' }, Subject: 'Help with order', TextBody: 'Original email', Date: '2026-11-03T10:00:00Z' });
beforeEach(() => { mail.length = 0; setEmailTransport(async e => { mail.push(e); }); inbound.setInboundRunner(); config.mailFrom = 'floorwalker@example.com'; });
after(() => { setEmailTransport(); core.close(); rmSync(dir, { recursive: true, force: true }); });

test('webhook Basic auth fails closed and accepts only configured credentials', () => {
  for (const value of [undefined, '', 'Bearer nope', 'Basic !!!!', `Basic ${Buffer.from('inbound-test:wrong').toString('base64')}`]) assert.equal(inbound.authorized(value), false);
  const correct = `Basic ${Buffer.from('inbound-test:test-password').toString('base64')}`;
  assert.equal(inbound.authorized(correct), true);
  delete process.env.POSTMARK_INBOUND_PASSWORD; assert.equal(inbound.authorized(correct), false); process.env.POSTMARK_INBOUND_PASSWORD = 'test-password';
});
test('routes by MailboxHash, de-duplicates MessageID, drops unknown and rotated addresses', () => {
  const a = workspace(), b = workspace();
  const p = { ...payload(a.token), StrippedTextReply: 'Newest reply', Headers: [{ Name: 'References', Value: '<older@example.com>' }], Attachments: [{ Name: 'photo.jpg', Content: 'NOT STORED' }] };
  const result = inbound.receivePostmark(p);
  assert.equal(a.run(() => store.tickets().length), 1); assert.equal(b.run(() => store.tickets().length), 0);
  const t = a.run(() => store.tickets()[0]);
  assert.equal(t.body, 'Newest reply'); assert.equal(t.from_name, 'A Customer'); assert.equal(t.from_email, 'buyer@example.com');
  assert.equal(Date.parse(t.received_at), Date.parse(p.Date)); assert.equal(t.thread_references, '<older@example.com>'); assert.match(t.attachment_note!, /1 attachment/);
  assert.ok(!JSON.stringify(t).includes('NOT STORED'));
  assert.equal(inbound.receivePostmark(p).duplicate, true);
  assert.equal(a.run(() => inbound.inboxSettings().received), true);
  assert.deepEqual(inbound.receivePostmark(payload('unknown')), { ok: true });
  const rotated = a.run(() => inbound.rotateAddress()); assert.notEqual(rotated.address?.split('+')[1].split('@')[0], a.token);
  assert.deepEqual(inbound.receivePostmark(payload(a.token)), { ok: true });
  assert.equal(a.run(() => store.tickets().length), 1); assert.ok('id' in result);
});
test('HTML fallback is plain text, empty stripped reply falls back to TextBody', () => {
  const h = workspace();
  inbound.receivePostmark({ ...payload(h.token), StrippedTextReply: '', TextBody: 'Full text' });
  inbound.receivePostmark({ ...payload(h.token), TextBody: '', HtmlBody: '<style>bad</style><p>Hello &amp; welcome</p><script>bad</script>' });
  const bodies = h.run(() => store.tickets().map(t => t.body));
  assert.equal(bodies[0], 'Full text'); assert.match(bodies[1], /Hello & welcome/); assert.doesNotMatch(bodies[1], /bad|<p>/);
});
test('skips automatic/bulk mail without storing its content, and records skipped deduplication', () => {
  const h = workspace();
  for (const headers of [[{ Name: 'Auto-Submitted', Value: 'auto-replied' }], [{ Name: 'Precedence', Value: 'list' }]]) {
    const p = { ...payload(h.token), Headers: headers }; assert.equal(inbound.receivePostmark(p).skipped, true); assert.equal(inbound.receivePostmark(p).duplicate, true);
  }
  assert.equal(inbound.receivePostmark({ ...payload(h.token), FromFull: { Email: 'mailer-daemon@example.com' } }).skipped, true);
  assert.equal(h.run(() => store.tickets().length), 0);
  const data = h.run(() => inbound.inboxSettings()); assert.equal(data.received, false); assert.equal(data.skipped.length, 3); assert.ok(!JSON.stringify(data.skipped).includes('Original email'));
});
test('forwarding confirmations require sender and subject; link host is allowlisted', () => {
  const h = workspace();
  inbound.receivePostmark({ ...payload(h.token), FromFull: { Email: 'forwarding-noreply@google.com' }, Subject: 'Gmail Forwarding Confirmation', TextBody: 'Confirmation code: 123456789\nhttps://evil.example/\nhttps://mail.google.com/mail/vf-abc', Headers: [{ Name: 'Auto-Submitted', Value: 'auto-generated' }] });
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
test('outbound Postmark payload carries custom From, Reply-To and thread headers', async t => {
  const { sendEmail } = await import('../server/email.ts');
  const old = process.env.POSTMARK_SERVER_TOKEN; process.env.POSTMARK_SERVER_TOKEN = 'fake'; setEmailTransport();
  let payload: any;
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => { payload = JSON.parse(options.body); return Response.json({ MessageID: 'sent' }); });
  try {
    await sendEmail({ to: 'buyer@example.com', subject: 'Re: Order', text: 'Reply', html: '<p>Reply</p>', tag: 'support-reply', from: '"Shop via Floorwalker" <fw@example.com>', replyTo: 'help@example.com', headers: [{ Name: 'In-Reply-To', Value: '<original>' }] });
    assert.equal(payload.From, '"Shop via Floorwalker" <fw@example.com>'); assert.equal(payload.ReplyTo, 'help@example.com'); assert.deepEqual(payload.Headers, [{ Name: 'In-Reply-To', Value: '<original>' }]);
  } finally { if (old === undefined) delete process.env.POSTMARK_SERVER_TOKEN; else process.env.POSTMARK_SERVER_TOKEN = old; }
});
test('HTTP webhook authenticates before parsing and enforces the 1 MB limit', async t => {
  const app = express(); app.use(inbound.postmark); const server = app.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); }); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const h = workspace(); const headers = { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from('inbound-test:test-password').toString('base64')}` };
  assert.equal((await fetch(base + '/api/inbound/postmark', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await fetch(base + '/api/inbound/postmark', { method: 'POST', body: JSON.stringify(payload(h.token)), headers })).status, 200);
  assert.equal((await fetch(base + '/api/inbound/postmark', { method: 'POST', body: JSON.stringify({ ...payload(h.token), HtmlBody: 'x'.repeat(1100000) }), headers })).status, 413);
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
