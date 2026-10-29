// Records one live run of the demo against the running app (npm run dev) and the PayPal sandbox:
//   node film/record.mjs [http://localhost:3000]  ->  film/data/run.json
// Every inbox item, the approval, the hijacked-agent simulation and a rules compile are run for real. For each step the
// file keeps the app state before and after, and every streamed event with its arrival time, so the film can replay the
// run exactly as it happened.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://localhost:3000';

// The run happens in a fresh demo workspace: sign in as a demo visitor and keep the session cookie.
const signIn = await fetch(`${BASE}/api/auth/sign-in/anonymous`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{}' });
if (!signIn.ok) throw new Error(`demo sign-in: ${signIn.status} ${await signIn.text()}`);
const COOKIE = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const H = { Cookie: COOKIE, Origin: BASE };

const get = async (path) => (await fetch(`${BASE}${path}`, { headers: H })).json();
const state = () => get('/api/state');
const post = async (path, body) => {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${data.error}`);
  return { ms: Date.now() - t0, data };
};

async function stream(path) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: H });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  const events = [];
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) events.push({ t: (Date.now() - t0) / 1000, event: JSON.parse(line) });
    }
  }
  return events;
}

const run = { recordedAt: new Date().toISOString(), steps: [] };
const step = async (id, fn) => {
  const before = await state();
  const out = await fn();
  const after = await state();
  run.steps.push({ id, before, after, ...out });
  const guards = (out.events || []).filter(e => e.event.type === 'guard').map(e => `${e.event.decision} $${e.event.amount}`);
  console.log(id, guards.join(', ') || (out.response ? 'ok' : ''), out.events ? `${out.events.at(-1)?.t.toFixed(1)} s` : '');
};

// The demo workspace seeds itself (paid sandbox orders, the inbox) right after sign-in.
for (let i = 0; ; i++) {
  const s = await state();
  if (s.workspace?.seedStatus === 'ready') break;
  if (String(s.workspace?.seedStatus).startsWith('failed') || i > 60) throw new Error(`demo seed: ${s.workspace?.seedStatus}`);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('demo workspace ready:', (await state()).workspace.name);
// The same order as the film: Daniel's held refund is approved right after it is held.
for (const t of ['T1', 'T2', 'approve', 'T3', 'T4', 'T5', 'T6']) {
  if (t !== 'approve') { await step(t, async () => ({ events: await stream(`/api/tickets/${t}/run`) })); continue; }
  const held = (await state()).ledger.filter(l => l.status === 'awaiting_approval' && l.tool === 'create_refund');
  if (held.length) await step('approve', async () => ({ ledgerId: held[0].id, response: (await post(`/api/ledger/${held[0].id}/approve`)).data }));
}
await step('attack', async () => ({ events: await stream('/api/attack') }));
await step('freeze', async () => ({ response: (await post('/api/agents/support/freeze')).data }));

// What Floorwalker learned from the owner's earlier decisions, and the owner accepting the refund-limit change.
await step('learned', async () => ({ response: await get('/api/rules/learned') }));
await step('learnApply', async () => {
  const before = await get('/api/rules/learned');
  const change = before.changes.find((c) => c.id.startsWith('refunds.auto_approve_up_to'));
  const r = await post('/api/rules/learned/apply', { id: change.id });
  return { change: change.id, ms: r.ms, response: r.data, learned: await get('/api/rules/learned') };
});

// A refund made straight through the PayPal API, skipping Floorwalker; the sweep catches it and the owner says it was her.
await step('bypass', async () => {
  const r = await post('/api/demo/bypass');
  return { ms: r.ms, response: r.data, incidents: await get('/api/incidents') };
});
await step('resolve', async () => {
  const open = (await state()).incidents[0];
  const r = await post(`/api/incidents/${open.id}/resolve`, { resolution: 'mine' });
  return { response: r.data, incidents: await get('/api/incidents') };
});

// An outside agent: the owner adds a help-desk bot with its own limits and gives it a key, and the bot asks for a
// refund over the API. The key's secret is used here and never written to the recording.
let botKey;
await step('agent', async () => {
  const agent = (await post('/api/agents', { name: 'Help-desk bot', role: 'Answers tickets in the help desk', can_refund: true, max_per_action: 30, budget: 100, budget_period: 'week' })).data;
  const made = (await post('/api/keys', { agent_id: agent.id, name: 'Help desk (production)' })).data;
  botKey = made.secret;
  return { response: { agent, keys: await get('/api/keys') } };
});
await step('api', async () => {
  const maya = (await state()).orders.find((o) => o.customer_email.startsWith('maya'));
  const request = {
    capture_id: maya.capture_id,
    amount: 40,
    reason: 'Customer reports the second mug and the saucer are cracked too.',
    requester_email: maya.customer_email,
    source_message: 'Hi again, the second mug has a hairline crack as well, and so does the saucer. Could you refund $40 for those? Thanks, Maya',
  };
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/refunds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'helpdesk-ticket-4471' },
    body: JSON.stringify(request),
  });
  return { request, status: r.status, ms: Date.now() - t0, response: await r.json() };
});

await step('audit', async () => ({ response: { log: await get('/api/audit?limit=100'), verify: await get('/api/audit/verify') } }));

mkdirSync(join(HERE, 'data'), { recursive: true });
writeFileSync(join(HERE, 'data/run.json'), JSON.stringify(run, null, 1));
console.log('wrote film/data/run.json');
