/** Fresh real shop, HTTP only except the shared PayPal sandbox order creator.
 * node --import tsx tests/e2e-merchant.mjs http://localhost:18999
 * No credentials, codes, cookies or capability URLs are written to the report.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const target = new URL(process.argv[2] ?? 'http://localhost:18999');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password)
  throw new Error('Refusing a non-local target');
const base = target.origin, began = new Date().toISOString(), rows = [], cookies = new Map();
const outbox = process.env.FLOW_OUTBOX ?? 'notes/.next/outbox.jsonl';
const email = `merchant-${randomUUID()}@example.com`, buyer = `buyer-${randomUUID()}@example.com`, buyer2 = `buyer-${randomUUID()}@example.com`;
let workspace, order, order2, key, keyId, agent, held, approveUrl, heldAmount, smallAmount, inbox;
const creds = { clientId: process.env.FLOW_PAYPAL_CLIENT_ID, clientSecret: process.env.FLOW_PAYPAL_CLIENT_SECRET };
function check(condition, message) { assert.ok(condition, message); }
function save() {
  writeFileSync(new URL('./e2e-merchant-RESULTS.md', import.meta.url), `# Fresh merchant end-to-end results\n\nTarget: ${base}\nStarted: ${began}\nUpdated: ${new Date().toISOString()}\n\nHTTP functional checks with real PayPal sandbox refunds. Shop and ledger remain for inspection.\n\n| Step | Result | Seconds | Evidence |\n|---|---|---:|---|\n${rows.map(r => `| ${r.name} | ${r.result} | ${r.seconds.toFixed(2)} | ${r.detail} |`).join('\n')}\n\n${rows.filter(r => r.result === 'PASS').length} PASS; ${rows.filter(r => r.result === 'FAIL').length} FAIL.\n`);
}
async function step(name, fn) {
  const start = Date.now();
  // Only our fixed messages are reported, never upstream errors or response bodies.
  try { await fn(); rows.push({ name, result: 'PASS', seconds: (Date.now() - start) / 1000, detail: 'Verified' }); }
  catch { rows.push({ name, result: 'FAIL', seconds: (Date.now() - start) / 1000, detail: 'Prerequisite unavailable or assertion failed; inspect the local server privately.' }); }
  console.log(`${rows.at(-1).result} | ${name}`); save();
}
async function request(path, { method = 'GET', body, bearer, basic, form } = {}) {
  const url = new URL(path, base);
  check(url.origin === base, 'Refusing a request outside the local server');
  const headers = { Origin: base, ...(bearer ? { Authorization: `Bearer ${bearer}` } : basic ? { Authorization: `Basic ${basic}` } : { Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') }) };
  if (body !== undefined) headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(120000) });
  if (!bearer && !basic) for (const value of res.headers.getSetCookie()) { const pair = value.split(';')[0], i = pair.indexOf('='); cookies.set(pair.slice(0,i), pair.slice(i+1)); }
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function ok(path, options) { const r = await request(path, options); check(r.status >= 200 && r.status < 300, 'HTTP request failed'); return r.data; }
const post = (path, body, options = {}) => ok(path, { method: 'POST', body, ...options });
async function poll(fn) {
  const end = Date.now() + 90000;
  do { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 1000)); } while (Date.now() < end);
  throw new Error('Timed out waiting for local evidence');
}
function mail() { try { return readFileSync(outbox, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } }
const refund = amount => ({ capture_id: order.captureId, amount, requester_email: buyer, source_message: `Please refund $${amount} of my order.`, reason: 'Customer requested a partial refund' });
await step('Sign up with an outbox email code and name the shop', async () => {
  await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
  const message = await poll(() => mail().find(m => m.to === email && m.tag === 'code'));
  const otp = /^\d{6}/.exec(message.text)?.[0]; check(otp, 'No code');
  const login = await post('/api/auth/sign-in/email-otp', { email, otp }); check(login.created === true, 'Expected brand-new account');
  const state = await ok('/api/state'); workspace = state.workspace;
  check(workspace && !workspace.demo, 'Expected a real workspace');
  await post('/api/auth/organization/update', { organizationId: workspace.id, data: { name: 'Fresh Merchant Shop' } });
  check((await ok('/api/state')).workspace.name === 'Fresh Merchant Shop', 'Shop name was not saved');
});
await step('Connect the PayPal sandbox app through Settings', async () => {
  check(workspace && creds.clientId && creds.clientSecret, 'Sandbox credentials required');
  await post('/api/settings/paypal', { client_id: creds.clientId, client_secret: creds.clientSecret });
  check((await ok('/api/state')).workspace.paypal.connected, 'Connection not saved');
});
await step('Create a paid order on the same sandbox app', async () => {
  check(workspace && creds.clientId && creds.clientSecret, 'Sandbox credentials required');
  const state = await ok('/api/state');
  const policy = state.policy.policy.refunds;
  heldAmount = Math.min(policy.auto_approve_up_to + 10, policy.hard_limit, 200);
  smallAmount = Math.min(5, policy.auto_approve_up_to);
  check(heldAmount > policy.auto_approve_up_to && smallAmount > 0 && heldAmount + smallAmount <= policy.budget.amount, 'Starter limits incompatible with the flow');
  const { inWorkspace } = await import('../server/context.ts');
  const { createPaidCustomerOrder } = await import('../server/paypal/api.ts');
  order = await inWorkspace({ id: workspace.id, name: 'Fresh Merchant Shop', paypal: creds, demo: false, db: null }, { kind: 'system', id: 'merchant-test', name: 'Merchant test' }, () => createPaidCustomerOrder({ customer: { name: 'Fresh Customer', email: buyer }, items: [{ name: 'Test item', sku: 'FLOW-1', unit: heldAmount + smallAmount + 20, quantity: 1 }], shipping: 0, invoiceId: `FLOW-${randomUUID()}` }));
  check(order.captureId && order.amount > heldAmount + smallAmount, 'Paid capture missing');
  // A second customer: the shop's rules ask about a customer's second refund within a month, so the small refund is theirs.
  order2 = await inWorkspace({ id: workspace.id, name: 'Fresh Merchant Shop', paypal: creds, demo: false, db: null }, { kind: 'system', id: 'merchant-test', name: 'Merchant test' }, () => createPaidCustomerOrder({ customer: { name: 'Second Customer', email: buyer2 }, items: [{ name: 'Test item', sku: 'FLOW-2', unit: smallAmount + 10, quantity: 1 }], shipping: 0, invoiceId: `FLOW-${randomUUID()}` }));
  check(order2.captureId, 'Second paid capture missing');
});
await step('Customer email arrives through Postmark and appears in the inbox', async () => {
  check(order && workspace, 'Order prerequisite'); inbox = await ok('/api/inbox/settings');
  check(inbox.address && !inbox.auto_run, 'Forwarding is not configured or auto-run is enabled');
  const token = inbox.address.split('@')[0].split('+')[1]; check(token, 'Mailbox token missing');
  check(process.env.POSTMARK_INBOUND_USER && process.env.POSTMARK_INBOUND_PASSWORD, 'Inbound credentials required');
  const basic = Buffer.from(`${process.env.POSTMARK_INBOUND_USER}:${process.env.POSTMARK_INBOUND_PASSWORD}`).toString('base64');
  const r = await post('/api/inbound/postmark', { MailboxHash: token, MessageID: randomUUID(), FromFull: { Email: buyer, Name: 'Fresh Customer' }, Subject: `Refund order ${order.orderId}`, TextBody: `Please refund $${heldAmount} on order ${order.orderId}. Capture ${order.captureId}.`, Date: new Date().toISOString() }, { basic });
  check(r.id, 'No inbound ticket');
  const ticket = (await ok('/api/state')).tickets.find(t => t.id === r.id);
  check(ticket?.from_email === buyer && ticket.status === 'open' && !ticket.reply, 'Email did not wait in inbox');
});
await step('Create an agent and key; request a refund above the limit', async () => {
  check(order, 'Paid order prerequisite');
  agent = await post('/api/agents', { name: 'Merchant flow agent', can_refund: true, can_payout: false });
  const created = await post('/api/keys', { agent_id: agent.id, name: 'Merchant flow key' }); key = created.secret; keyId = created.key.id;
  check(key, 'Key missing'); held = await post('/v1/refunds', refund(heldAmount), { bearer: key });
  check(held.status === 'awaiting_approval', 'Refund was not held');
});
await step('Approval email GET is inert; POST executes with a PayPal refund id', async () => {
  check(held && workspace, 'Held request prerequisite');
  const message = await poll(() => mail().find(m => m.to === email && m.tag === 'request-held' && m.text.includes(`Approve $${heldAmount.toFixed(2)}:`)));
  approveUrl = message.text.split(`Approve $${heldAmount.toFixed(2)}: `)[1]?.split('\n')[0]; check(approveUrl, 'Approval link missing');
  const before = await ok(`/v1/actions/${held.id}`, { bearer: key });
  const page = await ok(approveUrl); check(typeof page === 'string' && page.includes('<form'), 'Confirmation page missing');
  const after = await ok(`/v1/actions/${held.id}`, { bearer: key });
  check(before.status === 'awaiting_approval' && after.status === before.status && !after.paypal_ref, 'GET changed the action');
  const token = new URL(approveUrl).searchParams.get('t'); check(token, 'Action token missing');
  await post('/email/act', { t: token }, { form: true });
  const result = await poll(async () => { const a = await ok(`/v1/actions/${held.id}`, { bearer: key }); return ['approved','executed'].includes(a.status) && a.paypal_ref ? a : null; });
  const row = (await ok('/api/state')).ledger.find(r => r.id === Number(held.id.replace('act_', '')));
  check(row?.paypal_ref === result.paypal_ref && ['approved','executed'].includes(row.status), 'Ledger execution missing');
});
await step('A second refund under the limit executes automatically', async () => {
  check(key && order && approveUrl, 'Approval prerequisite');
  const result = await post('/v1/refunds', { capture_id: order2.captureId, amount: smallAmount, requester_email: buyer2, source_message: `One cup in my order arrived chipped. Please refund $${smallAmount} for it.`, reason: 'Customer reports one chipped cup on a delivered order' }, { bearer: key });
  check(result.status === 'executed' && result.paypal_ref, 'Small refund did not execute');
});
await step('Revoke the test agent key', async () => {
  check(keyId, 'Key prerequisite'); await ok(`/api/keys/${keyId}`, { method: 'DELETE' });
  check((await request('/v1/agent', { bearer: key })).status === 401, 'Revocation failed');
});
process.exitCode = rows.some(r => r.result === 'FAIL') ? 1 : 0;
