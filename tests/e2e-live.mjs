/** Usage: node tests/e2e-live.mjs [base URL]
 * Fresh anonymous demo, sandbox only. No supplied secrets; ephemeral agent keys
 * stay in memory and are revoked. E2E_FOCUS=developers reruns only developer paths
 * after a full run and writes separate focused results. Functional HTTP/SSE checks, not browser layout
 * or JavaScript rendering. Writes a sanitized PASS/FAIL report beside this file.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const base = new URL(process.argv[2] ?? 'https://floorwalker.43-160-214-187.sslip.io').origin;
const began = new Date().toISOString();
const focused = process.env.E2E_FOCUS === 'developers';
const focusedSteps = new Set(['Anonymous sign-in', 'Instant demo with simulated history', 'Create agent and ephemeral key', 'Agent permission refusal', 'Agent permission patch preserves other permissions', '/v1/payouts', 'MCP tools/list over HTTP', 'MCP tools/call over HTTP', 'Revoked key refused', 'Cleanup endpoints and keys; freeze agents with history', 'Sign out and confirm access refused']);
const reportStem = focused ? 'e2e-live-developers' : 'e2e-live';
const cookie = new Map(), rows = [], secrets = new Set(), keys = [], agents = [], endpoints = [];
let state, apiKey, apiKeyId, agent, held, bypass, originalPolicy, learned, signedIn = false, mcpVersion = '2025-03-26';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function clean(value) {
  let out = String(value);
  for (const secret of secrets) if (secret) out = out.replaceAll(secret, '[redacted]');
  return out.replace(/fw_[A-Za-z0-9_-]+/g, '[redacted-key]').replace(/[\r\n|]+/g, ' ').slice(0, 650);
}
async function req(path, { method = 'GET', body, key, headers = {}, timeout = 120_000, anonymous = false } = {}) {
  const h = { ...(!anonymous && !key && cookie.size ? { Cookie: [...cookie].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(method !== 'GET' ? { Origin: base, 'Content-Type': 'application/json' } : {}), ...headers };
  const res = await fetch(new URL(path, base), { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'manual' });
  if (!anonymous && !key) for (const item of res.headers.getSetCookie()) { const pair = item.split(';')[0]; const split = pair.indexOf('='); cookie.set(pair.slice(0, split), pair.slice(split + 1)); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}
async function ok(path, options) {
  const r = await req(path, options);
  assert.ok(r.status >= 200 && r.status < 300, `${options?.method ?? 'GET'} ${path}: HTTP ${r.status}; ${typeof r.data === 'object' ? JSON.stringify(r.data.error ?? r.data.message ?? '') : r.data.slice(0, 160)}`);
  return r.data;
}
async function step(name, fn) {
  if (focused && !focusedSteps.has(name)) return;
  const t = Date.now();
  try { const detail = await fn(); rows.push({ check: name, result: 'PASS', seconds: (Date.now() - t) / 1000, detail: clean(detail ?? 'Verified') }); }
  catch (e) { rows.push({ check: name, result: 'FAIL', seconds: (Date.now() - t) / 1000, detail: clean(e.message) }); }
  const r = rows.at(-1); console.log(`${r.result} | ${name} | ${r.detail}`);
  save();
}
function save() {
  const report = `# Live end-to-end results\n\nTarget: ${base}; mode: ${focused ? 'focused developer recheck' : 'full'}\n\nStarted: ${began}; last update: ${new Date().toISOString()}. Fresh anonymous demo session; no user credentials. All money calls target the application's sandbox-only integration. HTTP/SSE functional checks only: page responses/assets do not prove browser rendering. FAIL includes unavailable prerequisites and demo restrictions, explicitly identified below. No checkout approved.\n\n| Check | Result | Seconds | Evidence / limitation |\n|---|---|---:|---|\n${rows.map(r => `| ${r.check} | ${r.result} | ${r.seconds.toFixed(2)} | ${r.detail} |`).join('\n')}\n\n${rows.filter(r => r.result === 'PASS').length} PASS; ${rows.filter(r => r.result === 'FAIL').length} FAIL.\n`;
  writeFileSync(new URL(`./${reportStem}-RESULTS.md`, import.meta.url), report);
  writeFileSync(new URL(`./${reportStem}-results.json`, import.meta.url), JSON.stringify({ base, began, rows }, null, 2));
}
const refresh = async () => state = await ok('/api/state');
const post = (path, body = {}, extra = {}) => ok(path, { method: 'POST', body, ...extra });
const money = (path, body, id) => post(path, body, { key: apiKey, headers: { 'Idempotency-Key': id } });
function ready() { assert.ok(signedIn && state?.workspace?.demo, 'Prerequisite: ready anonymous sandbox demo session'); }
function agentReady() { ready(); assert.ok(apiKey && agent, 'Prerequisite: ephemeral agent and key'); }
async function poll(fn, ms = 90_000) { const until = Date.now() + ms; let value; do { value = await fn(); if (value) return value; await pause(2000); } while (Date.now() < until); throw new Error(`Condition not met within ${ms / 1000}s`); }
const refundBody = amount => { const order = state.orders.find(o => o.customer_email === 'maya.chen@example.com'); assert.ok(order, 'Maya order exists'); return { capture_id: order.capture_id, amount, requester_email: order.customer_email, source_message: `Please refund $${amount} for the chipped mug.`, reason: 'Partial refund for chipped mug' }; };
try {
  for (const path of ['/', '/app']) await step(`${path} loads with JS asset`, async () => {
    const r = await req(path); assert.equal(r.status, 200); assert.equal(typeof r.data, 'string'); assert.match(r.data, /<html|<!doctype/i);
    const script = r.data.match(/<script[^>]*src="([^"]+)"/); assert.ok(script, 'HTML contains JavaScript asset');
    const asset = await req(script[1]); assert.equal(asset.status, 200); assert.ok(asset.data.length > 100); return 'HTML 200 and referenced JS 200 (rendering not checked)';
  });
  await step('Anonymous sign-in', async () => {
    const r = await post('/api/auth/sign-in/anonymous'); assert.ok(r.user?.isAnonymous, 'anonymous user'); signedIn = true;
    return 'Fresh anonymous identity; cookie retained in memory only';
  });
  await step('Instant demo with simulated history', async () => {
    assert.ok(signedIn, 'Sign-in required');
    const t = Date.now();
    await poll(async () => { await refresh(); return state.workspace?.seedStatus === 'ready' && state.orders?.length >= 3 && state.tickets?.length >= 6; }, 180_000);
    ready(); assert.ok(state.ledger.length > 20, 'Preloaded history'); assert.ok(state.configured.paypal, 'PayPal connected');
    originalPolicy = state.policy;
    assert.ok(Date.now() - t < 10_000, `Demo ready after ${Date.now() - t} ms (not instant)`);
    return `${state.orders.length} paid orders, ${state.tickets.length} tickets, ${state.ledger.length} history rows`;
  });
  await step('Learned changes', async () => { ready(); learned = await ok('/api/rules/learned'); assert.ok(learned.changes.length); assert.ok(learned.changes.every(c => c.impact.declinedLetThrough === 0)); return `${learned.changes.length} backtested suggestions`; });
  await step('Apply learned change', async () => { ready(); assert.ok(learned?.changes?.length, 'No learned suggestion'); originalPolicy ??= state.policy; const next = await post('/api/rules/learned/apply', { id: learned.changes[0].id }); assert.deepEqual(next.policy, learned.changes[0].draft); return `Applied policy version ${next.id}`; });
  await step('Restore policy', async () => { ready(); assert.ok(originalPolicy); const r = await post(`/api/policy/restore/${originalPolicy.id}`); assert.deepEqual(r.policy, originalPolicy.policy); await refresh(); return `Restored as version ${r.id}`; });
  await step('Rules compile and backtest', async () => {
    ready(); const compiled = await post('/api/policy/compile', { text: `${state.policy.text}\nChange only the refund auto-approve limit to $20; keep all other limits.` });
    assert.equal(compiled.policy.refunds.auto_approve_up_to, 20);
    const backtest = await post('/api/policy/simulate', { policy: compiled.policy }); assert.ok(backtest.rows.length > 0); assert.ok(backtest.changed > 0); return `${backtest.rows.length} past moves replayed; ${backtest.changed} changed`;
  });
  const expected = { T1: ['executed', 24, 'refund'], T2: ['awaiting_approval', 86, 'refund'], T3: ['executed', 35, 'payout'], T5: ['blocked', 64, 'refund'], T6: ['awaiting_approval', 180, 'payout'], T7: ['awaiting_approval', 52, 'refund'] };
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']) await step(`Inbox ${id} expected outcome`, async () => {
    ready(); const stream = await post(`/api/tickets/${id}/run`); assert.equal(typeof stream, 'string');
    const events = stream.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return {}; } });
    assert.ok(!events.some(e => e.type === 'error'), `SSE error: ${events.filter(e => e.type === 'error').map(e => e.message ?? e.error).join('; ')}`);
    await refresh(); const moves = state.ledger.filter(r => r.ticket_id === id); const ticket = state.tickets.find(t => t.id === id);
    assert.ok(ticket?.reply, 'Agent completed a reply');
    if (id === 'T4') { assert.ok(moves.every(r => !['executed', 'approved'].includes(r.status)), 'Redirect must never execute'); assert.match(ticket.reply, /unverified request to change payment details/i); assert.match(ticket.reply, /confirm.*real payee.*known channel/i); assert.doesNotMatch(ticket.reply, /Pay Sam|sam\.rivera\.windows@gmail\.com/i); return `Escalated; ${moves.length} money proposals, none executed`; }
    const [status, amount, kind] = expected[id];
    assert.ok(moves.some(r => r.status === status && r.amount === amount && r.kind === kind), `Expected ${kind} $${amount} ${status}; observed ${moves.map(r => `${r.kind} $${r.amount} ${r.status}`).join(', ') || 'no proposal'}`);
    if (id === 'T5') assert.ok(moves.every(r => !['executed', 'approved'].includes(r.status)), 'No injected money move may execute');
    return `${kind} $${amount}: ${status}`;
  });
  await step('Approve held inbox request', async () => { ready(); await refresh(); const row = state.ledger.find(r => r.ticket_id === 'T2' && r.status === 'awaiting_approval'); assert.ok(row, 'T2 held request'); const result = await post(`/api/ledger/${row.id}/approve`); assert.equal(result.status, 'approved'); assert.ok(result.paypal_ref); return `Request ${row.id} approved with PayPal reference`; });
  await step('Decline with a reason', async () => { ready(); await refresh(); const row = state.ledger.find(r => r.ticket_id === 'T6' && r.status === 'awaiting_approval'); assert.ok(row, 'T6 held request'); const reason = 'E2E: owner needs invoice verification'; const result = await post(`/api/ledger/${row.id}/decline`, { reason }); assert.equal(result.status, 'declined'); assert.equal(result.decline_reason, reason); return 'Declined; exact reason persisted'; });
  await step('Freeze and unfreeze all agents', async () => { ready(); await post('/api/agents/freeze-all'); await refresh(); assert.ok(state.agents.every(a => a.status === 'frozen')); for (const a of state.agents) await post(`/api/agents/${a.id}/unfreeze`); await refresh(); assert.ok(state.agents.every(a => a.status === 'active')); });
  await step('Bypass opens incident', async () => { ready(); bypass = await post('/api/demo/bypass'); assert.ok(bypass.refund?.id); const r = await ok('/api/incidents'); assert.ok(r.incidents.some(i => i.paypal_ref === bypass.refund.id && !i.resolved_at), 'Incident for exact bypass refund'); await refresh(); assert.ok(state.agents.every(a => a.status === 'frozen')); return `Untracked $${bypass.refund.amount} sandbox refund found; agents frozen`; });
  await step('PayPal webhook arrives within 90 seconds', async () => {
    ready(); assert.ok(bypass?.refund?.id, 'Bypass prerequisite');
    const at = Date.now(); const r = await poll(async () => { const view = await ok('/api/incidents'); return view.watch.last_event?.type === 'PAYMENT.CAPTURE.REFUNDED' && Date.parse(view.watch.last_event.at) >= at ? view : null; });
    return `Server observed verified refund webhook at ${r.watch.last_event.at}; endpoint exposes no refund/event ID, so exact bypass-event correlation is unavailable`;
  });
  await step('Resolve incident and restore agents', async () => { ready(); const view = await ok('/api/incidents'); const inc = view.incidents.find(i => i.paypal_ref === bypass?.refund?.id); assert.ok(inc); const r = await post(`/api/incidents/${inc.id}/resolve`, { resolution: 'mine' }); assert.equal(r.resolution, 'mine'); await refresh(); assert.ok(state.agents.every(a => a.status === 'active')); });
  await step('Bad webhook signature changes nothing', async () => { ready(); const before = await ok('/api/incidents'); const r = await req('/api/paypal/webhook/demo', { method: 'POST', body: { event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'FORGED-E2E', amount: { value: '1.00' } } }, headers: { 'paypal-transmission-sig': 'invalid' } }); assert.equal(r.status, 400, `Malformed signature must return HTTP 400, got ${r.status}`); const after = await ok('/api/incidents'); assert.deepEqual(after.incidents, before.incidents); assert.deepEqual(after.watch.last_event, before.watch.last_event); return `Rejected HTTP ${r.status}; incidents and last verified event unchanged${r.status === 500 ? '; invalid signature surfaced as server error' : ''}`; });
  await step('Create agent and ephemeral key', async () => {
    ready(); agent = await post('/api/agents', { name: 'E2E capped refund agent', can_refund: true, can_payout: false, max_per_action: 1 }); agents.push(agent.id);
    const r = await post('/api/keys', { agent_id: agent.id, name: 'E2E disposable', expires_in_days: 1 }); apiKey = r.secret; apiKeyId = r.key.id; secrets.add(apiKey); keys.push(apiKeyId);
    const view = await ok('/v1/agent', { key: apiKey }); assert.equal(view.id, agent.id); assert.equal(view.controls.max_per_action, 1); return 'Key created, used and retained only in process memory';
  });
  await step('/v1/refunds held by agent cap', async () => { agentReady(); await refresh(); held = await money('/v1/refunds', refundBody(5), 'e2e-refund'); assert.equal(held.status, 'awaiting_approval'); assert.ok(held.checks.some(c => c.id === 'agent_cap' && c.outcome === 'hold'), `Cap check missing: ${held.checks.map(c => `${c.id}:${c.outcome}`).join(', ')}`); return `${held.id}: $5 held`; });
  await step('Idempotent retry returns same action', async () => { agentReady(); assert.ok(held?.id); const r = await money('/v1/refunds', refundBody(5), 'e2e-refund'); assert.equal(r.id, held.id); const view = await ok(`/v1/actions/${held.id}`, { key: apiKey }); assert.equal(view.id, held.id); });
  await step('Approve a different amount', async () => { agentReady(); assert.equal(held?.status, 'awaiting_approval'); const r = await post(`/api/ledger/${held.id.replace('act_', '')}/approve`, { amount: 2 }); assert.equal(r.status, 'approved'); assert.equal(r.approved_amount, 2); assert.ok(r.paypal_ref); return 'Requested $5, approved $2 with PayPal reference'; });
  await step('Agent permission refusal', async () => { agentReady(); const payee = state.policy.policy.payouts.payees[0].email; const r = await money('/v1/payouts', { email: payee, amount: 2, reason: 'Permission refusal test' }, 'e2e-permission'); assert.equal(r.status, 'blocked'); assert.ok(r.checks.some(c => c.id === 'agent' && c.outcome === 'block')); assert.equal(r.paypal_ref, null); });
  await step('Agent permission patch preserves other permissions', async () => { agentReady(); const before = await ok('/v1/agent', { key: apiKey }); const patched = await ok(`/api/agents/${agent.id}`, { method: 'PATCH', body: { can_payout: true } }); assert.equal(Boolean(patched.can_refund), before.can_refund, 'PATCH {can_payout:true} must preserve existing can_refund:true'); return 'Existing refund permission preserved'; });
  await step('/v1/payouts', async () => { agentReady(); await ok(`/api/agents/${agent.id}`, { method: 'PATCH', body: { can_refund: true, can_payout: true } }); const r = await money('/v1/payouts', { email: state.policy.policy.payouts.payees[0].email, amount: 2, reason: 'Regular shop service; hold for owner', source_message: 'Please pay $2 for shop service', requester_email: 'owner@juniperandoak.example' }, 'e2e-payout'); assert.equal(r.status, 'awaiting_approval'); assert.equal(r.type, 'payout'); await post(`/api/ledger/${r.id.replace('act_', '')}/decline`, { reason: 'E2E complete; no payout necessary' }); return `${r.id} held and declined`; });
  await step('MCP tools/list over HTTP', async () => { agentReady(); const init = await post('/v1/mcp', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: mcpVersion, capabilities: {}, clientInfo: { name: 'floorwalker-e2e', version: '1.0' } } }, { key: apiKey, headers: { Accept: 'application/json, text/event-stream' } }); assert.ok(init.result?.protocolVersion, `MCP initialize: ${JSON.stringify(init.error ?? init)}`); mcpVersion = init.result.protocolVersion; const r = await post('/v1/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { key: apiKey, headers: { Accept: 'application/json, text/event-stream' } }); assert.ok(r.result?.tools?.some(t => t.name === 'create_refund'), `MCP tools/list: ${JSON.stringify(r.error ?? { tools: r.result?.tools?.map(t => t.name) })}`); return `${r.result.tools.length} tools returned`; });
  await step('MCP tools/call over HTTP', async () => { agentReady(); const order = state.orders.find(o => o.customer_email === 'maya.chen@example.com'); const r = await post('/v1/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_order', arguments: { id: order.order_id } } }, { key: apiKey, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': mcpVersion } }); assert.ok(!r.error && !r.result?.isError, `MCP tools/call: ${JSON.stringify(r.error ?? r.result)}`); assert.ok(JSON.stringify(r.result?.content).includes(order.order_id), 'MCP returns requested sandbox order'); });
  await step('Billing checkout link', async () => { ready(); const r = await req('/api/billing/checkout', { method: 'POST', body: { plan: 'pro' } }); if (r.status === 400 && /demo/i.test(JSON.stringify(r.data))) throw new Error('UNAVAILABLE in anonymous demo: checkout is explicitly refused; no sandbox approval link can be verified without a non-demo account'); assert.equal(r.status, 200); assert.equal(new URL(r.data.approveUrl).hostname, 'www.sandbox.paypal.com'); return 'Sandbox approval URL returned; not opened or approved'; });
  await step('Plan quota refusal', async () => { ready(); const b = await ok('/api/billing'); throw new Error(`UNAVAILABLE in demo: Business limits; monthly action quota ${b.limits?.actionsPerMonth ?? 50000}. Not generating 50,000 model/money calls or changing production data to force exhaustion`); });
  await step('Outgoing webhook create and test delivery', async () => { ready(); const r = await post('/api/webhooks', { url: 'https://httpbin.org/status/204', description: 'E2E synthetic test only', events: ['action.held'] }); secrets.add(r.secret); endpoints.push(r.endpoint.id); await post(`/api/webhooks/${r.endpoint.id}/test`); const d = await poll(async () => { const ds = await ok(`/api/webhooks/${r.endpoint.id}/deliveries`); const test = ds.find(d => d.event_id.startsWith('evt_test_')); if (test?.status === 'succeeded') return test; if (test?.attempts > 0 && (test.last_status >= 400 || test.status === 'failed')) throw new Error(`Delivery HTTP ${test.last_status}: ${test.last_error ?? ''}`); return null; }); return `Test event delivered; attempts ${d.attempts}`; });
  await step('Audit log and integrity verification', async () => { ready(); const log = await ok('/api/audit'); assert.ok(log.length > 0); const v = await ok('/api/audit/verify'); assert.equal(v.ok, true); assert.ok(v.entries >= log.length); return `${v.entries} chained entries verified`; });
  await step('CSV export', async () => { ready(); const r = await req('/api/audit.csv'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/); assert.match(r.data, /^id,at,actor_kind/); assert.ok(r.data.split('\n').length > 1); return 'Audit CSV includes header and rows'; });
  await step('Cross-site POST refused', async () => { ready(); const before = (await refresh()).agents.map(a => [a.id, a.status]); const r = await req('/api/agents/freeze-all', { method: 'POST', body: {}, headers: { Origin: 'https://untrusted.example' } }); assert.equal(r.status, 403); assert.deepEqual((await refresh()).agents.map(a => [a.id, a.status]), before); });
  await step('API request-rate quota refusal', async () => { agentReady(); let limited = false; for (let n = 0; n < 13 && !limited; n++) { const rs = await Promise.all(Array.from({ length: 10 }, () => req('/v1/agent', { key: apiKey }))); limited = rs.some(r => r.status === 429 && r.data.error?.code === 'rate_limited'); assert.ok(rs.every(r => [200, 429].includes(r.status))); } assert.ok(limited, '120/min key rate limit'); return '429 rate_limited observed (distinct from billing quota)'; });
  await step('Revoked key refused', async () => { agentReady(); await ok(`/api/keys/${apiKeyId}`, { method: 'DELETE' }); keys.splice(keys.indexOf(apiKeyId), 1); const r = await req('/v1/agent', { key: apiKey }); assert.equal(r.status, 401); assert.equal(r.data.error?.code, 'unauthorized'); });
} finally {
  await step('Cleanup endpoints and keys; freeze agents with history', async () => {
    if (!signedIn) return 'No signed-in session to clean';
    const failures = [];
    for (const [collection, ids] of [['webhooks', endpoints], ['keys', keys], ['agents', agents]]) for (const id of ids) { const r = await req(`/api/${collection}/${id}`, { method: 'DELETE' }); if (collection === 'agents' && r.status === 400 && /history/i.test(JSON.stringify(r.data))) { const frozen = await post(`/api/agents/${id}/freeze`); assert.equal(frozen.status, 'frozen'); } else if (![200, 404].includes(r.status)) failures.push(`${collection}: ${r.status}`); }
    assert.deepEqual(failures, []); return 'Keys revoked and webhook endpoints removed; agents with ledger history frozen as required by the API';
  });
  await step('Sign out and confirm access refused', async () => {
    if (!signedIn) return 'No session was established';
    await post('/api/auth/sign-out'); signedIn = false;
    const r = await req('/api/state'); assert.equal(r.status, 401); cookie.clear(); return 'Signed out; /api/state returns 401';
  });
  save();
  console.log(`\n${rows.filter(r => r.result === 'PASS').length} PASS / ${rows.filter(r => r.result === 'FAIL').length} FAIL; tests/${reportStem}-RESULTS.md`);
  process.exitCode = rows.some(r => r.result === 'FAIL') ? 1 : 0;
}
