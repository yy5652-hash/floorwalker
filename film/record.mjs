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
const state = async () => (await fetch(`${BASE}/api/state`)).json();
const post = async (path, body) => {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${data.error}`);
  return { ms: Date.now() - t0, data };
};

async function stream(path) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, { method: 'POST' });
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

console.log('reset:', (await post('/api/demo/reset')).data.log.join(' | '));
// The same order as the film: Daniel's held refund is approved right after it is held.
for (const t of ['T1', 'T2', 'approve', 'T3', 'T4', 'T5', 'T6']) {
  if (t !== 'approve') { await step(t, async () => ({ events: await stream(`/api/tickets/${t}/run`) })); continue; }
  const held = (await state()).ledger.filter(l => l.status === 'awaiting_approval' && l.tool === 'create_refund');
  if (held.length) await step('approve', async () => ({ ledgerId: held[0].id, response: (await post(`/api/ledger/${held[0].id}/approve`)).data }));
}
await step('attack', async () => ({ events: await stream('/api/attack') }));
const s = await state();
const text = s.policy.text.replace('the agent can refund up to $40 on its own', 'the agent can refund up to $30 on its own').replace('Anything above $40 asks me', 'Anything above $30 asks me');
await step('compile', async () => { const r = await post('/api/policy/compile', { text }); return { text, ms: r.ms, response: r.data }; });

mkdirSync(join(HERE, 'data'), { recursive: true });
writeFileSync(join(HERE, 'data/run.json'), JSON.stringify(run, null, 1));
console.log('wrote film/data/run.json');
