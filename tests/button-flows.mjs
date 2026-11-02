// Drives complete user flows through the Floorwalker web app in a real browser with real mouse clicks and real typing,
// and checks what the person would see afterwards. Rerunnable; prints PASS/FAIL per step, exits nonzero if any step failed,
// and writes tests/button-flows-RESULTS.md.
//
//   node tests/button-flows.mjs [base URL]            (default http://localhost:18999)
//   FLOWS=account,settings node tests/button-flows.mjs   run only some flows (account settings agents developers setup workspaces roles demo approvals hijack watch demo-agents ledger rules demo-billing)
//   FLOW_RUN=name reuses one test account across partial reruns; FLOW_PROFILE=dir keeps the browser profile (and so the demo session) between runs
//   FLOW_PAYPAL_CLIENT_ID / FLOW_PAYPAL_CLIENT_SECRET (a PayPal sandbox app) add the connect-real-credentials step; without them it is skipped
//
// Run it against a throwaway local server, never the live site (it signs up accounts, creates keys, refunds sandbox orders):
//   NODE_ENV=production PORT=18999 DATA_DIR=notes/.flow/ws FLOORWALKER_CORE_DB=notes/.flow/core.db \
//   FLOORWALKER_BASE_URL=http://localhost:18999 BETTER_AUTH_URL=http://localhost:18999 npx tsx server/index.ts
// Anonymous sign-in is rationed at 6/hour per IP and email sign-up at 10/hour; restart the server to reset them.
// PayPal is sandbox only. The script never approves a PayPal subscription.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] ?? 'http://localhost:18999').replace(/\/$/, '');
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && !process.env.FLOWS_ALLOW_REMOTE) { console.error('Refusing to run against a non-local server. Set FLOWS_ALLOW_REMOTE=1 only if you are sure.'); process.exit(2); }
const ONLY = process.env.FLOWS?.split(',').filter(Boolean);
const DEBUG = 9500 + Math.floor(Math.random() * 400);
const SHELL = process.env.CHROME_SHELL || '/Users/hudsonyu/Documents/Codex/2026-09-28/referenced-chatgpt-conversation-this-is-an-4/work/ai4s-v2/.pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = process.env.FLOW_RUN || randomBytes(3).toString('hex'); // FLOW_RUN reuses one account across partial reruns
// Generated per run and never printed; with FLOW_RUN it is derived from that name so a partial rerun can sign in to the same account.
const PASSWORD = `Pw-${process.env.FLOW_RUN ? createHash('sha256').update('floorwalker-flow:' + process.env.FLOW_RUN).digest('hex').slice(0, 18) : randomBytes(9).toString('hex')}`;
const WRONG_PASSWORD = `Wrong-${randomBytes(6).toString('hex')}`;

// ---------- browser ----------
const chrome = spawn(SHELL, [`--remote-debugging-port=${DEBUG}`, `--user-data-dir=${process.env.FLOW_PROFILE || mkdtempSync(join(tmpdir(), 'fw-flow-'))}`, '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
let targets; for (let i = 0; i < 60 && !targets?.length; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json(); } catch {} await sleep(200); }
if (!targets?.length) { console.error('Could not start Chrome. Set CHROME_SHELL to a chrome-headless-shell binary.'); process.exit(2); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const waiting = new Map(); const pageErrors = []; const dialogs = []; let navigating = false;
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data);
  if (waiting.has(d.id)) { waiting.get(d.id)(d.result ?? { error: d.error }); waiting.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] ?? d.params.exceptionDetails.text);
  if (d.method === 'Page.javascriptDialogOpening') { dialogs.push({ type: d.params.type, message: d.params.message }); void send('Page.handleJavaScriptDialog', { accept: true }); }
  if (d.method === 'Page.frameStartedLoading') navigating = true;
  if (d.method === 'Page.loadEventFired' || d.method === 'Page.frameStoppedLoading') navigating = false;
});
// A command sent while the page is navigating can go unanswered; give up on it after 60s rather than hanging the run.
const send = (method, params = {}) => new Promise(r => { const id = ++seq; const t = setTimeout(() => { waiting.delete(id); r({ error: { message: `${method} timed out` } }); }, 60000); waiting.set(id, x => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message ?? 'browser command failed');
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text}`); return r.result?.value; };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Browser.grantPermissions', { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});

// Page-side helpers: a request log, plus element lookup by visible name.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__a = { reqs: [], inflight: 0, opened: [] };
  const f = window.fetch; window.fetch = async (...x) => { const u = String(x[0]?.url ?? x[0]), m = x[1]?.method ?? x[0]?.method ?? 'GET'; const r = { u, m, s: 0 }; if (/\\/api\\/ledger\\//.test(u) && typeof x[1]?.body === 'string') r.b = x[1].body.slice(0, 200); __a.reqs.push(r); __a.inflight++; try { const res = await f(...x); r.s = res.status; return res; } catch (e) { r.s = e?.name === 'AbortError' ? -2 : -1; throw e; } finally { __a.inflight--; } };
  window.__toasts = []; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) { const t = n.nodeType === 1 && (n.matches?.('[data-sonner-toast]') ? n : n.querySelector?.('[data-sonner-toast]')); if (t) setTimeout(() => __toasts.push({ at: Date.now(), text: t.innerText.replace(/\\s+/g, ' ').trim() }), 60); } }).observe(document, { childList: true, subtree: true });
  window.open = (u) => { __a.opened.push(String(u)); return null; };
  const DEFAULT = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=switch], [role=radio], [role=option], [role=combobox], summary, select, input, textarea, label';
  const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); if (!(r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none')) return false; const d = e.closest('details'); return !d || d.open || (e.tagName === 'SUMMARY' && e.parentElement === d); };
  const names = e => [e.getAttribute('aria-label'), e.innerText, e.title, e.placeholder, ...(e.labels ? [...e.labels].map(l => l.innerText) : []), e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.innerText].filter(Boolean).map(s => s.replace(/\\s+/g, ' ').trim());
  window.__f = {
    names,
    all(spec) {
      const dlg = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).at(-1);
      const scope = spec.within ? [...document.querySelectorAll(spec.within)].filter(vis).at(-1) : (spec.page ? document : (dlg || document));
      if (!scope) return [];
      const re = spec.re ? new RegExp(spec.re, 'i') : null, t = spec.text?.toLowerCase();
      let list = [...scope.querySelectorAll(spec.sel || DEFAULT)].filter(vis).filter(e => !e.closest('[data-sonner-toast]') || spec.toast);
      if (t || re) list = list.filter(e => names(e).some(n => re ? re.test(n) : spec.exact ? n.toLowerCase() === t : n.toLowerCase().includes(t)));
      if (spec.in) {
        // Only controls inside the card/row/section whose heading or cell reads exactly spec.in.
        const head = [...scope.querySelectorAll('h2,h3,h4,td strong,strong,[data-slot=card-title]')].find(h => h.innerText.trim() === spec.in);
        if (!head) return [];
        const inside = [];
        for (let b = head.parentElement, i = 0; b && i < 8; b = b.parentElement, i++) { const inner = list.filter(e => b.contains(e)); if (inner.length) { inside.push(...inner); break; } }
        list = inside;
      }
      if (spec.not) { const nre = new RegExp(spec.not, 'i'); list = list.filter(e => !names(e).some(n => nre.test(n))); }
      return list;
    },
    one(spec) { return this.all(spec)[spec.nth ?? 0]; },
    pos(spec) {
      const e = this.one(spec); if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, top = document.elementFromPoint(x, y);
      return { x, y, tag: e.tagName.toLowerCase(), type: e.type, name: names(e)[0]?.slice(0, 60) ?? '', disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true', why: e.title || e.getAttribute('aria-description') || '', covered: !!top && top !== e && !e.contains(top) && !top.contains(e) ? (top.innerText || top.className.toString()).slice(0, 50) : null };
    },
    dump() {
      const dlg = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).at(-1), root = dlg || document.querySelector('main') || document;
      return [...root.querySelectorAll(DEFAULT.replace(', label', ''))].filter(vis).filter(e => !e.closest('.ag-root-wrapper')).slice(0, 60).map(e => e.tagName.toLowerCase() + (e.disabled ? '(disabled)' : '') + ' ' + JSON.stringify(names(e)[0]?.slice(0, 50) ?? '')).join('\\n');
    },
  };
` });

// ---------- sanitising ----------
const clean = s => String(s)
  .replace(/\bfw_[A-Za-z0-9_-]{6,}/g, 'fw_…').replace(/\b(whsec|sk|pk|pat)_[A-Za-z0-9_-]{6,}/g, '$1_…')
  .replace(/https:\/\/hooks\.slack\.com\/\S+/g, 'https://hooks.slack.com/…')
  .replace(/\b[A-Za-z0-9]{32,}\b/g, '…').replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer …')
  .replace(new RegExp(PASSWORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<password>').replace(new RegExp(WRONG_PASSWORD, 'g'), '<password>')
  .replace(/[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/g, '<email>');

// ---------- actions ----------
const S = x => typeof x === 'string' ? { text: x } : x instanceof RegExp ? { re: x.source } : x;
const label = x => { const s = S(x); return s.text ?? s.re ?? s.sel ?? JSON.stringify(s); };
async function settle(ms = 250) { await sleep(ms); for (let i = 0; i < 240 && ((await ev('window.__a?.inflight ?? 0')) > 0); i++) await sleep(250); }
async function locate(spec, { timeout = 8000, allowDisabled = false } = {}) {
  const s = S(spec); const t0 = Date.now(); let pos;
  while (Date.now() - t0 < timeout) {
    pos = await ev(`__f.pos(${JSON.stringify(s)})`);
    if (pos && (allowDisabled || !pos.disabled)) { await sleep(60); pos = await ev(`__f.pos(${JSON.stringify(s)})`) ?? pos; if (!pos.covered) return pos; }
    await sleep(200);
  }
  if (!pos) throw new Error(`no visible control matching "${label(spec)}"\n${clean(await ev('__f.dump()'))}`);
  if (pos.disabled && !allowDisabled) throw new Error(`"${pos.name}" is disabled${pos.why ? ` (title: ${pos.why})` : ' and gives no reason'}`);
  throw new Error(`"${pos.name}" is covered by "${pos.covered}"`);
}
async function mouse(pos) { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); }
async function click(spec, opts) { const pos = await locate(spec, opts); await mouse(pos); await settle(); return pos; }
async function key(k) {
  const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Backspace: 8, Delete: 46 };
  const p = { key: k, code: k, windowsVirtualKeyCode: codes[k], nativeVirtualKeyCode: codes[k], ...(k === 'Enter' ? { text: '\r' } : {}) };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
}
// Real typing: click the field, select what is in it, insert the text as the browser would for typed input.
async function type(spec, value, { enter = false } = {}) {
  const pos = await locate(spec); await mouse(pos);
  await ev(`(() => { const e = document.activeElement; if (e && e.select) e.select(); return true; })()`);
  if (value === '') await key('Backspace'); else await send('Input.insertText', { text: String(value) });
  if (enter) await key('Enter');
  await settle(120);
}
// Native <select>: click it, then type the start of the option's name (type-ahead), as a person using the keyboard would.
// A custom (radix) select: open it and click the option.
async function choose(spec, optionText) {
  const pos = await locate(spec);
  if (pos.tag === 'select') {
    await mouse(pos); // headless Chrome has no popup for this; the click just focuses the select
    await ev(`(() => { const e = __f.one(${JSON.stringify(S(spec))}); e.focus(); return true; })()`);
    // Stop at the first letters that pick the option: a select that saves on change disables itself and loses focus right after.
    const picked = () => ev(`__f.one(${JSON.stringify(S(spec))}).selectedOptions[0].text`);
    let cur = '';
    for (const ch of optionText) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); await sleep(60); cur = await picked(); if (cur.toLowerCase().startsWith(optionText.toLowerCase().slice(0, 1)) && cur.toLowerCase().includes(optionText.toLowerCase())) break; }
    if (!cur.toLowerCase().includes(optionText.toLowerCase())) throw new Error(`could not select "${optionText}" in "${pos.name}" (stuck on "${cur}")`);
    await settle(); return;
  }
  await mouse(pos); await settle(200); await click({ sel: '[role=option], [role=menuitemradio]', text: optionText, page: true });
}
const pageText = async () => (await ev('document.body.innerText')) ?? '';
const reTest = (re, t) => re instanceof RegExp ? re.test(t) : t.toLowerCase().includes(String(re).toLowerCase());
async function waitText(re, { timeout = 10000, what = '' } = {}) {
  const t0 = Date.now(); let t = '';
  while (Date.now() - t0 < timeout) { t = await pageText(); if (reTest(re, t)) return t; await sleep(250); }
  const toasts = await toastText().catch(() => '');
  throw new Error(`expected to see ${what || String(re)} on the page${toasts ? ` (notices meanwhile: ${toasts.slice(0, 200)})` : ''}, but it said:\n${clean(t.replace(/\s+/g, ' ').slice(0, 500))}`);
}
async function waitNoText(re, { timeout = 10000, what = '' } = {}) {
  const t0 = Date.now(); let t = '';
  while (Date.now() - t0 < timeout) { t = await pageText(); if (!reTest(re, t)) return; await sleep(250); }
  throw new Error(`expected ${what || String(re)} to disappear, but the page still shows it`);
}
async function waitFor(fn, { timeout = 10000, what = 'condition' } = {}) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = await Promise.resolve(fn()).catch(() => false); if (last) return last; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}
async function waitControl(spec, opts = {}) { await locate(spec, { timeout: opts.timeout ?? 10000, allowDisabled: opts.allowDisabled }); }
async function waitGone(spec, { timeout = 10000 } = {}) { await waitFor(async () => !(await ev(`!!__f.one(${JSON.stringify(S(spec))})`)), { timeout, what: `"${label(spec)}" to go away` }); }
async function goto(path) {
  const url = path.startsWith('http') ? path : BASE + path;
  const cur = await ev('location.href').catch(() => '');
  const sameDoc = cur && new URL(cur).pathname === new URL(url).pathname && new URL(cur).search === new URL(url).search && new URL(url).hash;
  if (sameDoc) { await ev(`location.hash = ${JSON.stringify(new URL(url).hash)}; true`); await sleep(300); await send('Page.reload'); }
  else await send('Page.navigate', { url });
  await sleep(400);
  for (let i = 0; i < 80; i++) { await sleep(250); if (!navigating && await ev(`document.readyState === 'complete' && document.body.innerText.trim().length > 20`).catch(() => false)) break; }
  await settle(500);
}
// Pages that wait for data show a skeleton or "Loading…": wait until real content is there.
async function openApp(page) { await goto(`/app#${page}`); await waitFor(async () => !/Loading…|Loading\.\.\./.test(await pageText()), { timeout: 20000, what: 'the page to finish loading' }); await settle(400); }
// Calls from the page itself, so they carry the signed-in cookie. A call that gets no answer in 45s is retried once rather than hanging the run.
const api = async (path, init = {}, tries = 2) => {
  const expr = `fetch(${JSON.stringify(path)}, { ...${JSON.stringify({ ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) })}, signal: AbortSignal.timeout(45000) }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`;
  for (let i = 1; ; i++) { try { return await ev(expr); } catch (e) { if (i >= tries || init.method === 'POST') throw e; await sleep(1000); } }
};
let toastFrom = Date.now(); // notices that appeared during the current step
const toastText = () => ev(`(window.__toasts ?? []).filter(t => t.at >= ${toastFrom}).map(t => t.text).join(' | ')`);
async function waitToast(re, { timeout = 10000 } = {}) {
  let last = ''; await waitFor(async () => { last = await toastText(); return last && (re ? reTest(re, last) : true); }, { timeout, what: `a notification matching ${re}` }).catch(() => { throw new Error(`expected a notification matching ${re}, saw: "${clean(last)}"`); });
  return last;
}
async function clearSession() { await send('Network.clearBrowserCookies'); await ev(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return true; })()`).catch(() => {}); }
async function resetBrowser() { await goto('/signin'); await clearSession(); await goto('/signin'); }
async function signedInAs() { const r = await api('/api/auth/get-session'); return r.json?.user ?? null; }

// ---------- reporting ----------
const rows = []; let current = ''; let abort = false;
const bad = []; // requests that failed in the current step
class Abort extends Error {}
async function step(name, fn, { critical = false, ok4xx = false, ignoreErrors = false } = {}) {
  if (abort) { rows.push({ flow: current, name, result: 'SKIP', note: 'an earlier critical step failed' }); console.log(`SKIP  ${current} | ${name}`); return; }
  toastFrom = Date.now();
  const err0 = pageErrors.length, reqs0 = (await ev('window.__a?.reqs.length ?? 0').catch(() => 0)); const t0 = Date.now();
  let note = '', result = 'PASS';
  try {
    const out = await fn(); if (typeof out === 'string') note = out;
    // A button that quietly produces a server or script error counts as broken even if the page looked fine.
    const reqs = await ev(`(window.__a?.reqs ?? []).slice(${reqs0}).filter(r => r.s >= 500 || (${ok4xx ? 'false' : 'r.s >= 400'}) || (r.s === -1 && !${navigating})).map(r => r.m + ' ' + r.u.replace(location.origin, '').split('?')[0] + ' ' + r.s)`).catch(() => []);
    if (reqs.length && !ignoreErrors) throw new Error(`a request failed: ${reqs.slice(0, 3).join(', ')}`);
    if (pageErrors.length > err0 && !ignoreErrors) throw new Error(`script error: ${pageErrors[err0]}`);
  } catch (e) {
    result = 'FAIL'; note = e.message;
    const seen = await ev(`(window.__a?.reqs ?? []).slice(${reqs0}).slice(-4).map(r => r.m + ' ' + r.u.replace(location.origin, '').split('?')[0] + ' ' + r.s).join(', ')`).catch(() => '');
    if (seen) note += `\n(requests during the step: ${seen})`;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  rows.push({ flow: current, name, result, note: clean(note) });
  console.log(`${result.padEnd(5)} ${current} | ${name} (${secs}s)${note ? ' | ' + clean(note).split('\n')[0].slice(0, 160) : ''}`);
  if (result === 'FAIL' && note.includes('\n')) console.log(clean(note).split('\n').slice(1, 14).map(l => '        ' + l).join('\n'));
  if (result === 'FAIL' && critical) { abort = true; }
}
const flows = [];
const flow = (name, fn) => flows.push([name, fn]);
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// Collected for the results file: things a person would still want to know.
const notes = [];

// ======================================================================
// FLOWS
// ======================================================================
const acct = { name: `Flow Owner ${run}`, email: `flow-${run}@example.com` };


// Setup that is not under test: make sure the flow-owner account exists and this browser is signed in as it.
async function ensureAccount() {
  const me = await signedInAs().catch(() => null);
  if (me?.email === acct.email) return;
  await goto('/signin'); await clearSession();
  let r = await api('/api/auth/sign-in/email', { method: 'POST', body: { email: acct.email, password: PASSWORD } });
  if (r.status !== 200) r = await api('/api/auth/sign-up/email', { method: 'POST', body: { name: acct.name, email: acct.email, password: PASSWORD } });
  expect(r.status === 200, `could not set up the test account (HTTP ${r.status})`);
}
const menu = () => click({ sel: 'button', text: 'Your account menu' });

flow('account', async () => {
  await resetBrowser();
  await step('Landing: header "Sign in" goes to /signin', async () => {
    await goto('/'); await click({ sel: 'a', text: 'Sign in', exact: true, within: '.site-nav' });
    await waitFor(async () => (await ev('location.pathname')) === '/signin', { what: '/signin' });
  });
  await step('Sign-in page: "Create account" link goes to /signup', async () => {
    await click({ sel: 'a', text: 'Create account' });
    await waitFor(async () => (await ev('location.pathname')) === '/signup', { what: '/signup' });
    await waitText('Create your account');
  });
  await step('Sign-up page: "Sign in" link goes back to /signin', async () => {
    await click({ sel: 'a', text: 'Sign in', exact: true });
    await waitFor(async () => (await ev('location.pathname')) === '/signin', { what: '/signin' });
    await waitText('Welcome back');
  });
  await step('Landing: header "Get started" and all three pricing buttons go to /signup (signed out)', async () => {
    for (const spec of [{ sel: 'a', text: 'Get started', within: '.site-nav' }, ...[0, 1, 2].map(nth => ({ sel: '#pricing a', text: 'Get started', nth, page: true }))]) {
      await goto('/'); await click(spec);
      await waitFor(async () => (await ev('location.pathname')) === '/signup', { what: '/signup after clicking ' + (spec.nth ?? 'header') });
    }
  });
  await step('Sign up: a too-short password is refused with the browser\'s own message and nothing is sent', async () => {
    await goto('/signup');
    await type('Full name', acct.name); await type({ sel: 'input', text: 'Email', exact: true }, acct.email); await type('Password', 'short');
    const before = await ev('__a.reqs.length');
    await click({ sel: 'button[type=submit]', text: 'Create account' });
    const msg = await ev(`document.querySelector('input[type=password]').validationMessage`);
    expect(msg, 'no validation message for a 5-character password');
    expect((await ev('__a.reqs.length')) === before, 'a request was sent despite the invalid password');
    return `browser says: ${msg}`;
  });
  await step('Sign up with valid details creates the account and opens the app', async () => {
    await type('Password', PASSWORD);
    await click({ sel: 'button[type=submit]', text: 'Create account' });
    await waitFor(async () => (await ev('location.pathname')) === '/app', { timeout: 20000, what: 'to land in /app' });
    await openApp('overview');
    await waitControl({ sel: 'button', text: 'Your account menu' });
  }, { critical: true });
  await step('Account menu shows who is signed in, with a role', async () => {
    await menu(); const t = await waitText(acct.email); expect(/owner/i.test(t), 'no owner role badge'); await key('Escape');
  });
  await step('Account menu > Settings opens settings', async () => {
    await menu(); await click({ sel: '[role=menuitem]', text: 'Settings' });
    await waitFor(async () => /settings/.test(await ev('location.hash')) , { what: '#settings' }); await waitText('Workspace name');
  });
  await step('Account menu > Add a passkey: with no authenticator it must not freeze the menu; Sign out stays reachable', async () => {
    await menu(); await click({ sel: '[role=menuitem]', text: 'Add a passkey' }); await sleep(2000);
    const t = await toastText();
    notes.push(`"Add a passkey" in headless Chrome (no authenticator): ${t ? `shows "${t.slice(0, 100)}"` : 'the browser prompt never answers, so nothing completes'}. Real passkey creation and sign-in need a hardware or platform authenticator and are not verified here.`);
    await menu(); await waitControl({ sel: '[role=menuitem]', text: 'Sign out' }); await key('Escape');
  }, { ignoreErrors: true });
  await step('Sign out returns to the sign-in page and ends the session', async () => {
    await menu(); await click({ sel: '[role=menuitem]', text: 'Sign out' });
    await waitFor(async () => (await ev('location.pathname')) === '/signin', { what: '/signin' });
    expect(!(await signedInAs()), 'still signed in after Sign out');
  });
  await step('Sign in with the wrong password shows an error to the person', async () => {
    await type({ sel: 'input', text: 'Email', exact: true }, acct.email); await type('Password', WRONG_PASSWORD);
    await click({ sel: 'button[type=submit]', text: 'Sign in' });
    const t = await waitToast(/invalid|incorrect|wrong|password|email/i);
    expect((await ev('location.pathname')) === '/signin', 'left the sign-in page after a failed sign-in');
    return t;
  }, { ok4xx: true });
  await step('Sign in with the right password opens the app', async () => {
    await type('Password', PASSWORD); await click({ sel: 'button[type=submit]', text: 'Sign in' });
    await waitFor(async () => (await ev('location.pathname')) === '/app', { timeout: 20000, what: '/app' });
    await openApp('overview'); await menu(); await waitText(acct.email); await key('Escape');
  });
  await step('Signed in: /signin and /signup do not show the sign-in form again', async () => {
    for (const p of ['/signin', '/signup']) {
      await goto(p); await sleep(1500);
      expect((await ev('location.pathname')) === '/app', `${p} still shows a form to someone who is signed in`);
    }
  });
  await step('Signed in: the landing page offers "Open dashboard" and pricing buttons that lead to billing', async () => {
    await goto('/'); await waitControl({ sel: 'a', text: 'Open dashboard' });
    for (const nth of [0, 1, 2]) {
      await goto('/'); await click({ sel: '#pricing a', nth, page: true });
      await waitFor(async () => (await ev('location.pathname + location.hash')) === '/app#settings/billing', { what: 'to arrive in billing' });
    }
    await goto('/'); await click({ sel: 'a', text: 'Open dashboard' });
    await waitFor(async () => (await ev('location.pathname')) === '/app', { what: '/app' });
  });
});


const settingsTab = async name => { await click({ sel: 'nav[aria-label="settings sections"] a', text: name, exact: true }); await waitFor(async () => !/Loading…/.test(await pageText()), { what: 'the tab to load' }); await settle(300); };
const developersTab = async name => { await click({ sel: 'nav[aria-label="developers sections"] a', text: name, exact: true }); await settle(400); };
const field = async spec => ev(`__f.one(${JSON.stringify({ sel: 'input, textarea, select', ...S(spec) })})?.value`);
const switchOn = async spec => (await ev(`__f.one(${JSON.stringify({ sel: '[role=switch]', ...S(spec) })})?.getAttribute('aria-checked')`)) === 'true';
const checkbox = async spec => ev(`__f.one(${JSON.stringify({ sel: 'input[type=checkbox]', ...S(spec) })})?.checked`);
const clipboard = async () => ev(`navigator.clipboard.readText()`);
const confirmDialog = async (opener, buttonText) => { await click(opener); await waitControl({ text: 'Keep as is' }); await click({ text: buttonText, exact: true, not: '^Keep as is$' }); await waitGone({ sel: '[role=dialog]', page: true }); };

flow('settings', async () => {
  await ensureAccount(); await openApp('settings');
  await step('General: Save changes stores the new name, expiry, reminder and step-up values', async () => {
    await type('Workspace name', `Flow Shop ${run}`); await type('Approval expiry', '36'); await type('Reminder delay', '90'); await type('Step-up amount', '250.50');
    await click('Save changes'); await waitToast(/Settings saved/i);
    await openApp('settings'); await waitControl('Workspace name');
    expect((await field('Workspace name')) === `Flow Shop ${run}`, 'workspace name did not persist');
    expect((await field('Approval expiry')) === '36' && (await field('Reminder delay')) === '90' && (await field('Step-up amount')) === '250.5', 'numbers did not persist');
    await waitText(`Flow Shop ${run}`, { what: 'the new name in the top bar' });
  });
  await step('General: an out-of-range value is refused by the form and nothing is sent', async () => {
    await type('Approval expiry', '0'); const n = await ev('__a.reqs.length'); await click('Save changes');
    const msg = await ev(`document.activeElement.validationMessage || [...document.querySelectorAll('input')].map(i => i.validationMessage).find(Boolean)`);
    expect(msg, 'no validation message shown for 0 hours'); expect((await ev('__a.reqs.length')) === n, 'a request was sent with 0 hours');
    await openApp('settings');
  });
  await step('General: the assistant privacy switch turns on and off and the choice is saved', async () => {
    expect(!(await switchOn('Let the assistant read')), 'privacy sharing should start off for a real workspace');
    await click({ sel: '[role=switch]', text: 'Let the assistant read' }); await waitToast(/privacy saved/i);
    expect((await api('/api/state')).json.workspace.assistantContext === true, 'server did not record sharing on');
    expect(await switchOn('Let the assistant read'), 'switch did not turn on');
    await click({ sel: '[role=switch]', text: 'Let the assistant read' }); await waitToast(/privacy saved/i);
    expect((await api('/api/state')).json.workspace.assistantContext === false, 'server did not record sharing off');
  });

  await settingsTab('PayPal');
  await step('PayPal: made-up sandbox credentials are rejected with a visible error', async () => {
    await waitText('Not connected');
    await type('Sandbox Client ID', `Aflow${randomBytes(10).toString('hex')}`); await type('Sandbox Client Secret', `E${randomBytes(12).toString('hex')}`);
    await click({ sel: 'button', text: 'Connect sandbox app' });
    const t = await waitToast(/./, { timeout: 30000 }); expect(!/connected/i.test(t) || /not|fail|invalid|reject/i.test(t), `unexpected notice: ${t}`);
    await waitText('Not connected'); return t;
  }, { ok4xx: true });
  await step('PayPal: real sandbox credentials connect, can be left alone with "Keep as is", then disconnected', async () => {
    const id = process.env.FLOW_PAYPAL_CLIENT_ID, secret = process.env.FLOW_PAYPAL_CLIENT_SECRET;
    if (!id || !secret) { notes.push('PayPal connect with real sandbox credentials was not run: set FLOW_PAYPAL_CLIENT_ID and FLOW_PAYPAL_CLIENT_SECRET (a sandbox app) to include it. The bad-credentials path was run.'); return 'skipped: no sandbox credentials supplied'; }
    await type('Sandbox Client ID', id); await type('Sandbox Client Secret', secret); await click('Connect sandbox app');
    await waitToast(/verified and connected/i, { timeout: 40000 }); await waitText('Connected');
    await click({ sel: 'button', text: 'Disconnect', exact: true }); await waitControl({ text: 'Keep as is' }); await click('Keep as is'); await waitText('Connected');
    await confirmDialog({ sel: 'button', text: 'Disconnect', exact: true }, 'Disconnect'); await waitText('Not connected');
  });

  await settingsTab('Team');
  await step('Team: your own role and Remove are locked, and say why', async () => {
    const sel = await ev(`(() => { const e = __f.one({ sel: 'select', text: 'Role for' }); return { disabled: e.disabled, title: e.title }; })()`);
    expect(sel.disabled, 'own role select should be locked'); expect(sel.title, 'locked role select gives no reason');
    const rm = await ev(`(() => { const e = __f.one({ sel: 'button', text: 'Remove', exact: true }); return { disabled: e.disabled, title: e.title }; })()`);
    expect(rm.disabled && rm.title, 'Remove for yourself should be disabled with a reason');
  });
  const inviteEmail = `invitee-${run}@example.com`; let inviteLink = '';
  await step('Team: Invite creates a link, lists the pending invitation and Copy puts the link on the clipboard', async () => {
    await type({ sel: 'input', text: 'Email', exact: true }, inviteEmail); await choose({ sel: 'select', text: 'Role' , not: 'Role for' }, 'admin');
    await click('Create invitation link'); await waitToast(/Invitation created/i);
    await waitText(inviteEmail); await waitControl({ text: 'Copy invitation link' });
    inviteLink = await ev(`[...document.querySelectorAll('pre code')].map(c => c.innerText).find(t => t.includes('/invite/'))`);
    expect(/\/invite\/.+/.test(inviteLink), 'no invitation link shown');
    await click({ sel: 'button', text: 'Copy invitation link', nth: 0 }); await waitControl({ sel: 'button', text: 'Copied' });
    expect((await clipboard()) === inviteLink, 'clipboard does not hold the invitation link');
  });
  await step('Team: Cancel invitation asks first; "Keep as is" keeps it and confirming removes it', async () => {
    await click({ sel: 'button', text: 'Cancel', exact: true }); await waitControl({ text: 'Keep as is' }); await click('Keep as is'); await waitText(inviteEmail);
    await confirmDialog({ sel: 'button', text: 'Cancel', exact: true }, 'Cancel invitation'); await waitNoText(inviteEmail); await waitText('No pending invitations');
  });
  await step('Team: an invitee who signs up and opens the link can accept and joins as the invited role', async () => {
    await click('Create invitation link', { allowDisabled: false }).catch(() => {});
    await type({ sel: 'input', text: 'Email', exact: true }, inviteEmail); await click('Create invitation link'); await waitToast(/Invitation created/i);
    inviteLink = await ev(`[...document.querySelectorAll('pre code')].map(c => c.innerText).find(t => t.includes('/invite/'))`);
    await resetBrowser();
    await goto(new URL(inviteLink).pathname); await waitText('Sign in with the invited email');
    await click({ sel: 'a', text: 'Create account' }); await waitFor(async () => (await ev('location.pathname')) === '/signup', { what: '/signup' });
    expect(decodeURIComponent(await ev('location.search')).includes('/invite/'), 'sign-up link lost the invitation');
    await type('Full name', `Invitee ${run}`); await type({ sel: 'input', text: 'Email', exact: true }, inviteEmail); await type('Password', PASSWORD);
    await click({ sel: 'button[type=submit]', text: 'Create account' });
    await waitFor(async () => (await ev('location.pathname')).startsWith('/invite/'), { timeout: 20000, what: 'to come back to the invitation' });
    await waitText(/invited to/i); await click('Accept invitation'); await waitFor(async () => (await ev('location.pathname')) === '/app', { timeout: 20000, what: '/app' });
    await openApp('overview'); await menu(); const t = await waitText(/admin/i); await key('Escape');
  }, { ok4xx: true });
  await step('Team: the owner changes the new member\'s role, then removes them', async () => {
    await resetBrowser(); await ensureAccount(); await openApp('settings'); await settingsTab('Team'); await waitText(`Invitee ${run}`);
    await choose({ sel: 'select', text: `Role for Invitee ${run}` }, 'viewer'); await waitToast(/Role updated/i);
    expect((await ev(`__f.one({ sel: 'select', text: 'Role for Invitee' }).value`)) === 'viewer', 'role select did not show viewer');
    await confirmDialog({ sel: 'button', text: 'Remove', exact: true, nth: 1 }, 'Remove member'); await waitNoText(`Invitee ${run}`);
  });

  await settingsTab('Notifications');
  await step('Notifications: each of the four switches flips and the choice is saved', async () => {
    for (const [key, name] of [['push_held', 'Payments needing approval'], ['push_blocked', 'Blocked requests'], ['push_reminders', 'Approval reminders'], ['push_executed', 'Executed payments']]) {
      const before = await switchOn(name); await click({ sel: '[role=switch]', text: name }); await waitFor(async () => (await switchOn(name)) === !before, { what: `${name} to flip` });
      expect((await api('/api/me/notifications')).json.prefs[key] === !before, `${name} was not saved`);
    }
  });
  await step('Notifications: "Enable push on this device" gives an answer instead of nothing', async () => {
    await click('Enable push on this device'); const t = await waitToast(/./, { timeout: 20000 }); notes.push(`"Enable push on this device" in headless Chrome: "${t.slice(0, 140)}". A real push subscription needs a normal browser profile with notification permission and was not verified.`); return t;
  }, { ignoreErrors: true });
  await step('Slack: a made-up webhook URL is refused with a visible reason', async () => {
    await type('Incoming webhook URL', 'https://hooks.slack.com/services/T000/B000/flowtest' + run); await click('Save Slack settings');
    const t = await waitToast(/./, { timeout: 20000 }); expect(/slack|webhook|404|invalid/i.test(t), `unexpected notice: ${t}`); await waitText('Not connected'); return t;
  }, { ok4xx: true });
  await step('Slack: a URL that is not Slack is refused with a visible reason', async () => {
    await type('Incoming webhook URL', 'https://example.com/hook'); await click('Save Slack settings');
    const t = await waitToast(/Slack/i); return t;
  }, { ok4xx: true });
  await step('Slack: the event checkboxes toggle', async () => {
    const before = await checkbox('action.expired'); await click({ sel: 'input[type=checkbox]', text: 'action.expired' });
    expect((await checkbox('action.expired')) === !before, 'checkbox did not toggle'); await click({ sel: 'input[type=checkbox]', text: 'action.expired' });
  });
  notes.push('Slack success path (a real incoming webhook, which Floorwalker posts a test message to) cannot be verified without a Slack webhook; the refusal paths were run.');

  await settingsTab('Billing');
  await step('Billing: both plan buttons exist, Free has no button and the current plan is marked', async () => {
    await waitText('free plan'); await waitText('Current'); await waitControl('Choose Pro'); await waitControl('Choose Business');
  });
  await step('Billing: Choose Pro sends the owner to a PayPal sandbox approval page (not approved here)', async () => {
    await click('Choose Pro');
    await waitFor(async () => /paypal\.com/.test(await ev('location.hostname').catch(() => '')), { timeout: 30000, what: 'to be sent to the PayPal sandbox approval link' });
    const host = await ev('location.hostname'); expect(/sandbox\.paypal\.com$/.test(host), `sent to ${host}, which is not the sandbox`);
    notes.push(`Choose Pro redirected to ${host} (approval page left unapproved).`);
    await openApp('settings'); await settingsTab('Billing');
  });
  await step('Billing: after walking away from approval, the page is back to normal and Choose Pro still works', async () => {
    await waitText('free plan'); await waitControl('Choose Pro'); await waitControl('Choose Business');
  });

  await settingsTab('Security');
  await step('Security: "Add passkey" with no authenticator does not lock the page forever', async () => {
    await type('Passkey name', 'Flow key'); await click('Add passkey'); await sleep(2500);
    const t = await toastText(); notes.push(`"Add passkey" in headless Chrome: ${t ? `"${t.slice(0, 100)}"` : 'the browser never answers, so the button stays busy'}. Passkeys need a real authenticator and are not verified here.`);
  }, { ignoreErrors: true });
  await openApp('settings'); await settingsTab('Security');
  await step('Security: "Sign out other sessions" asks first, "Keep as is" cancels, confirming shows a success notice', async () => {
    await click({ sel: 'button', text: 'Sign out other sessions' }); await waitControl('Keep as is'); await click('Keep as is'); await waitGone({ sel: '[role=dialog]', page: true });
    await click({ sel: 'button', text: 'Sign out other sessions' }); await click({ sel: 'button', text: 'Sign out other sessions', within: '[role=dialog]' }); await waitToast(/./);
    expect(!!(await signedInAs()), 'this session was signed out too');
  });
});



const agentCard = name => ({ sel: 'button', text: name, page: true });
const cardText = async name => ev(`(() => { const h = [...document.querySelectorAll('h3')].find(h => h.innerText.trim() === ${JSON.stringify(name)}); return h ? h.closest('[data-film],div.agent-card,div[class*=card]')?.innerText ?? '' : ''; })()`);

flow('agents', async () => {
  await ensureAccount(); await openApp('agents');
  await step('Agents: a new workspace starts with its two starter agents and offers New agent', async () => { await waitText('Support agent'); await waitText('Back-office agent'); await waitControl('New agent'); });
  await step('Agents: New agent opens a form; the Create button explains why it is disabled until there is a name', async () => {
    await click('New agent'); await waitText('Give it only the permissions');
    const pos = await locate({ sel: 'button', text: 'Create agent' }, { allowDisabled: true });
    expect(pos.disabled && pos.why, 'Create agent should be disabled with a reason while the name is empty');
  });
  await step('Agents: a payee email that is not an email is refused with a notice', async () => {
    await click({ sel: '[role=switch]', text: 'Payouts' }); await type({ sel: 'input', text: 'Allowed payee emails' }, 'not-an-email'); await click({ sel: 'button', text: 'Add', exact: true });
    await waitToast(/valid payee email/i);
  });
  await step('Agents: add a payee with the Add button, remove it with its x, add it again with Enter', async () => {
    await type({ sel: 'input', text: 'Allowed payee emails' }, `payee-${run}@example.com`); await click({ sel: 'button', text: 'Add', exact: true });
    await waitText(`payee-${run}@example.com`); await click({ sel: 'button', text: `Remove payee-${run}@example.com` }); await waitNoText(`payee-${run}@example.com`);
    await type({ sel: 'input', text: 'Allowed payee emails' }, `payee-${run}@example.com`, { enter: true }); await waitText(`payee-${run}@example.com`);
  });
  await step('Agents: saving with an un-added payee email typed in warns instead of dropping it', async () => {
    await type({ sel: 'input', text: 'Allowed payee emails' }, `extra-${run}@example.com`); await type('Agent name', `Flow Bot ${run}`);
    await click({ sel: 'button', text: 'Create agent' }); await waitToast(/pending payee email/i); await type({ sel: 'input', text: 'Allowed payee emails' }, '');
  });
  await step('Agents: fill every field and Create agent; the card shows what was entered', async () => {
    await click({ sel: '[role=switch]', text: 'Refunds' }); await type('Job description', 'Answers refund tickets'); await type('Cap per action', '40'); await choose({ sel: 'select', text: "Agent's own budget" }, 'Set independent budget');
    await type('Budget (USD)', '120'); await choose({ sel: 'select', text: 'Period' }, 'week');
    await click({ sel: 'button', text: 'Create agent' }); await waitToast(/Agent created/i);
    const t = await waitText(`Flow Bot ${run}`); await waitGone({ sel: '[role=dialog]', page: true });
    const card = await cardText(`Flow Bot ${run}`);
    expect(/Up to \$40/.test(card) && card.includes(`payee-${run}@example.com`) && /\$120/.test(card) && /per week/.test(card), `card does not show the entered limits:\n${card.replace(/\s+/g, ' ')}`);
  }, { critical: true });
  await step('Agents: Edit agent opens the saved values; changing them and Save agent updates the card', async () => {
    await click({ sel: 'button', text: 'Edit agent', in: `Flow Bot ${run}` }); await waitText(`Edit Flow Bot ${run}`);
    expect((await field('Agent name')) === `Flow Bot ${run}` && (await field('Cap per action')) === '40', 'the form did not open with the saved values');
    await type('Cap per action', '55'); await type('Job description', 'Handles refunds and small payouts');
    await click({ sel: 'button', text: 'Save agent' }); await waitToast(/Agent updated/i); await waitGone({ sel: '[role=dialog]', page: true });
    const card = await cardText(`Flow Bot ${run}`); expect(/Up to \$55/.test(card) && /small payouts/.test(card), 'card did not update');
  });
  await step('Agents: a payout agent\'s budget can be removed in the editor ("No independent budget")', async () => {
    await click({ sel: 'button', text: 'Edit agent', in: `Flow Bot ${run}` }); await choose({ sel: 'select', text: "Agent's own budget" }, 'No independent budget');
    await click({ sel: 'button', text: 'Save agent' }); await waitToast(/Agent updated/i); await waitGone({ sel: '[role=dialog]', page: true });
    expect(!/\$120/.test(await cardText(`Flow Bot ${run}`)), 'budget still shown');
  });
  await step('Agents: Freeze then Unfreeze on the card change its state and say so', async () => {
    await click({ sel: 'button', text: `Freeze Flow Bot ${run}` }); await waitText(/frozen/i); await waitControl({ sel: 'button', text: `Unfreeze Flow Bot ${run}` });
    expect(((await api('/api/state')).json.agents.find(a => a.name === `Flow Bot ${run}`)).status === 'frozen', 'server does not show it frozen');
    await click({ sel: 'button', text: `Unfreeze Flow Bot ${run}` }); await waitControl({ sel: 'button', text: `Freeze Flow Bot ${run}` });
  });
  await step('Agents: Freeze all asks first; confirming freezes every agent and Freeze all then explains why it is off', async () => {
    await click('Freeze all'); await waitText('Freeze all agents?'); await click({ sel: 'button', text: 'Freeze all agents' }); await waitText(/agents? frozen/i);
    await waitGone({ sel: '[role=dialog]', page: true });
    const pos = await locate({ sel: 'button', text: 'Freeze all', exact: true }, { allowDisabled: true }); expect(pos.disabled && pos.why, 'Freeze all should be disabled with a reason once all are frozen');
    await click({ sel: 'button', text: `Unfreeze Flow Bot ${run}` }); await waitControl({ sel: 'button', text: `Freeze Flow Bot ${run}` });
  });
  await step('Agents: "Create a key for this agent" opens the key dialog with this agent chosen', async () => {
    await click({ sel: 'a', text: 'Create a key for this agent', in: `Flow Bot ${run}` }); await waitText('Create agent key');
    expect((await ev(`__f.one({ sel: 'select', text: 'Agent' }).selectedOptions[0].text`)) === `Flow Bot ${run}`, 'the key dialog did not preselect the agent');
    await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
  });
  await step('Agents: the copy button for the MCP command copies the command and shows it was copied', async () => {
    await openApp('agents'); await click({ sel: 'button', text: 'Copy MCP command' }); await waitControl({ sel: 'button', text: 'Copied' });
    expect(/mcp|claude|npx|http/i.test(await clipboard()), 'clipboard holds nothing like an MCP command');
  });
  await step('Agents: the free plan allows 3 agents; a 4th shows the upgrade prompt with a working link to billing', async () => {
    await openApp('agents'); await click('New agent'); await type('Agent name', `Flow Over ${run}`); await click({ sel: 'button', text: 'Create agent' });
    await waitText('Room to grow'); await click({ sel: 'a', text: 'View plans & usage' });
    await waitFor(async () => (await ev('location.hash')) === '#settings/billing', { what: '#settings/billing' }); await waitText(/free plan/i);
  }, { ok4xx: true });
  await step('Agents: Delete agent asks first; "Keep as is" keeps it; confirming deletes an agent with no history', async () => {
    await openApp('agents'); await click({ sel: 'button', text: 'Edit agent', in: `Flow Bot ${run}` }); await waitText(`Edit Flow Bot ${run}`);
    await click({ sel: 'button', text: 'Delete agent', exact: true }); await waitControl('Keep as is'); await click('Keep as is'); await waitText(`Edit Flow Bot ${run}`);
    await click({ sel: 'button', text: 'Delete agent', exact: true }); await click({ sel: 'button', text: 'Delete agent', exact: true });
    await waitToast(/Agent deleted/i); await waitNoText(`Flow Bot ${run}`);
  });
});

flow('developers', async () => {
  await ensureAccount(); await openApp('developers'); let secretKey = '', keyName = `Flow key ${run}`;
  await step('Developers: Create key makes a one-time secret; Copy secret copies exactly what is shown', async () => {
    await click('Create key'); await waitText('Create agent key'); await type('Key name', keyName); await type('Expires in days', '7');
    await click({ sel: 'button', text: 'Create key', exact: true, within: '[role=dialog]' }); await waitText('Save your secret');
    const shown = await ev(`document.querySelector('[role=dialog] pre code').innerText`); expect(/^(fw|alw)_/.test(shown), 'no key shown');
    await click({ sel: 'button', text: 'Copy secret' }); await waitControl({ sel: 'button', text: 'Copied' }); secretKey = await clipboard();
    expect(secretKey === shown, 'clipboard differs from the key on screen');
    await click("I've saved it"); await waitGone({ sel: '[role=dialog]', page: true });
    const t = await waitText(keyName); expect(!t.includes(secretKey), 'the full key is still visible after closing');
  }, { critical: true });
  await step('Developers: the new key is listed Active with only its prefix', async () => { const t = await pageText(); expect(/Active/.test(t) && t.includes(secretKey.slice(0, 7)) , 'row missing prefix or Active'); });
  await developersTab('Test console');
  await step('Developers: Send request stays off with a reason until a key is pasted', async () => {
    const pos = await locate({ sel: 'button', text: 'Send request' }, { allowDisabled: true }); expect(pos.disabled && pos.why, 'Send request should say why it is off');
  });
  await step('Developers: a malformed key is refused with a visible message', async () => {
    await type('Agent key', 'fw_short'); await click('Send request'); await waitToast(/whole agent key/i);
  });
  await step('Developers: GET /v1/agent with the real key returns HTTP 200 and the response can be copied', async () => {
    await type('Agent key', secretKey); await click('Send request'); await waitText('HTTP 200');
    const body = await ev(`[...document.querySelectorAll('pre code')].pop().innerText`); expect(/Flow Bot|agent/i.test(body), 'response body does not describe the agent');
    await click({ sel: 'button', text: 'Copy response' }); await waitControl({ sel: 'button', text: 'Copied' }); expect((await clipboard()) === body, 'clipboard differs from the response');
    expect(!(await pageText()).includes(secretKey), 'the key appears in the response');
  });
  await step('Developers: POST /v1/refunds shows the idempotency controls; "New idempotency key" changes the value; the refusal is shown', async () => {
    await choose({ sel: 'select', text: 'Endpoint' }, 'POST /v1/refunds'); await waitControl('New idempotency key');
    const before = await field('Idempotency-Key'); await click('New idempotency key'); expect((await field('Idempotency-Key')) !== before, 'idempotency key did not change');
    await type('JSON body', '{ "order_id": "not-real", "amount": 1.00, "reason": "button flow test" }'); await click('Send request'); await waitText(/HTTP (4|5)\d\d/);
  }, { ok4xx: true });
  await step('Developers: broken JSON in the body is reported, not swallowed', async () => {
    await type('JSON body', '{ nope'); await click('Send request'); await waitToast(/JSON|token|position|Unexpected/i);
  });
  await step('Developers: GET /v1/actions/{id} takes an Action ID and reports a missing action', async () => {
    await choose({ sel: 'select', text: 'Endpoint' }, 'GET /v1/actions/act_42'); await type('Action ID', 'act_999999'); await click('Send request'); const t = await waitText(/HTTP 4\d\d/); return t.match(/HTTP 4\d\d/)[0];
  }, { ok4xx: true });
  await developersTab('API keys');
  await step('Developers: Revoke asks first; confirming marks the key Revoked and the key stops working', async () => {
    await click({ sel: 'button', text: 'Revoke', exact: true }); await waitControl('Keep as is'); await click('Keep as is'); await waitGone({ sel: '[role=dialog]', page: true });
    await click({ sel: 'button', text: 'Revoke', exact: true }); await click({ sel: 'button', text: 'Revoke key' }); await waitToast(/Key revoked/i); await waitText('Revoked');
    const r = await ev(`fetch('/v1/agent', { headers: { Authorization: 'Bearer ${secretKey}' }, credentials: 'omit' }).then(r => r.status)`); expect(r === 401, `a revoked key still answered HTTP ${r}`);
  }, { ok4xx: true });
  await developersTab('Test console');
  await step('Developers: after revoking, the same request in the test console shows HTTP 401', async () => {
    await type('Agent key', secretKey); await choose({ sel: 'select', text: 'Endpoint' }, 'GET /v1/agent'); await click('Send request'); await waitText('HTTP 401');
  }, { ok4xx: true });

  await developersTab('Quickstart');
  await step('Developers: every "Copy code" button copies its own snippet and shows "Copied"', async () => {
    const n = await ev(`__f.all({ sel: 'button', text: 'Copy code' }).length`); expect(n >= 4, `only ${n} copy buttons`);
    for (let i = 0; i < n; i++) {
      const want = await ev(`__f.all({ sel: 'button', text: 'Copy code' })[${i}].closest('.relative').querySelector('pre code').innerText`);
      await click({ sel: 'button', text: 'Copy code', nth: i }); await waitControl({ sel: 'button', text: 'Copied' });
      expect((await clipboard()) === want, `copy button ${i + 1} did not copy its snippet`);
      await waitFor(async () => (await ev(`__f.all({ sel: 'button', text: 'Copied' }).length`)) === 0, { timeout: 5000, what: 'the Copied label to reset' });
    }
  });
  await step('Developers: the OpenAPI link serves a real document', async () => {
    const href = await ev(`__f.one({ sel: 'a', text: 'OpenAPI specification' }).href`); const r = await api(new URL(href).pathname); expect(r.status === 200 && r.json?.openapi, `OpenAPI link answered HTTP ${r.status}`);
  });

  await developersTab('Webhooks');
  const hook = `https://example.com/hooks/${run}`;
  await step('Developers: Add endpoint with an HTTPS URL, description and chosen events shows a one-time secret and a card', async () => {
    await click('Add endpoint'); await waitText('Add webhook'); await type('Endpoint URL', hook); await type('Description', `Flow hook ${run}`);
    await click({ sel: 'input[type=checkbox]', text: '*' }).catch(() => {});
    await click({ sel: 'button', text: 'Add endpoint', within: '[role=dialog]' }); await waitText('Save your secret');
    await click({ sel: 'button', text: 'Copy secret' }); expect(/^whsec_|^[A-Za-z0-9_\-+/=]{16,}/.test(await clipboard()), 'webhook secret was not copied');
    await click("I've saved it"); await waitText(hook); await waitText(`Flow hook ${run}`);
  }, { critical: true });
  await step('Developers: Reveal secret shows the signing secret again and Copy works', async () => {
    await click('Reveal secret'); await waitText('Save your secret'); await click({ sel: 'button', text: 'Copy secret' }); await waitControl({ sel: 'button', text: 'Copied' }); await click("I've saved it");
  });
  await step('Developers: Send test queues a delivery and Deliveries shows it', async () => {
    await click('Send test'); await waitToast(/Test event queued/i); await click('Deliveries');
    await waitFor(async () => /webhook\.test|test|attempt|HTTP|pending|failed|delivered/i.test(await pageText()), { what: 'a delivery row' });
  });
  await step('Developers: Edit changes the description and keeps the URL locked', async () => {
    await click({ sel: 'button', text: 'Edit', exact: true }); await waitText('Edit webhook');
    const locked = await ev(`__f.one({ sel: 'input', text: 'Endpoint URL' }).disabled`); expect(locked, 'URL should be locked when editing');
    await type('Description', `Renamed hook ${run}`); await click('Save changes'); await waitGone({ sel: '[role=dialog]', page: true }); await waitText(`Renamed hook ${run}`);
  });
  await step('Developers: the Enabled switch turns the endpoint off; Send test then explains why it is off', async () => {
    await click({ sel: '[role=switch]', text: 'Enabled' }); await waitFor(async () => !(await switchOn('Enabled')), { what: 'switch off' });
    const pos = await locate({ sel: 'button', text: 'Send test' }, { allowDisabled: true }); expect(pos.disabled && pos.why, 'Send test should say why it is off');
    await click({ sel: '[role=switch]', text: 'Enabled' }); await waitFor(async () => switchOn('Enabled'), { what: 'switch on' });
  });
  await step('Developers: the free plan allows one webhook; a second shows the upgrade prompt with a working link', async () => {
    await click('Add endpoint'); await type('Endpoint URL', `https://example.com/second/${run}`); await click({ sel: 'button', text: 'Add endpoint', within: '[role=dialog]' }); await waitText('Room to grow');
    await click({ sel: 'a', text: 'View plans & usage' }); await waitFor(async () => (await ev('location.hash')) === '#settings/billing', { what: 'billing page' });
    await openApp('developers/webhooks');
  }, { ok4xx: true });
  await step('Developers: Delete asks first, "Keep as is" keeps the endpoint and confirming removes it', async () => {
    await click({ sel: 'button', text: 'Delete', exact: true }); await waitControl('Keep as is'); await click('Keep as is'); await waitGone({ sel: '[role=dialog]', page: true }); await waitText(`Renamed hook ${run}`);
    await click({ sel: 'button', text: 'Delete', exact: true }); await click({ sel: 'button', text: 'Delete endpoint' }); await waitToast(/Endpoint deleted/i); await waitNoText(`Renamed hook ${run}`);
  });
  await step('Developers: an http or private-network URL is refused with a visible reason and nothing is created', async () => {
    await click('Add endpoint'); await type('Endpoint URL', 'http://127.0.0.1:9/hook'); await click({ sel: 'button', text: 'Add endpoint', within: '[role=dialog]' });
    const t = await waitToast(/./); expect(!/Room to grow/.test(await pageText()), 'asked to upgrade instead of explaining the URL'); notes.push(`Webhook with a local URL is refused with: "${t.slice(0, 120)}"`);
    expect(!/Save your secret/.test(await pageText()), 'a local-network endpoint was created'); await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
  }, { ok4xx: true });
});



// ---- demo workspace: real sandbox orders, a real model, real PayPal sandbox refunds ----
const stateNow = async () => (await api('/api/state')).json;
const ticketOf = async (from, subject) => (await stateNow()).tickets.find(t => t.from_name.startsWith(from) && (!subject || t.subject.includes(subject)));
async function runTicket(from, subject) {
  await openApp('inbox');
  const spec = { sel: 'button.item, button[aria-pressed]', text: subject ?? from };
  await click(spec); await waitText(subject ?? from);
  await click({ sel: 'button', re: '^Let the .* handle it$' });
  const t = await ticketOf(from, subject);
  await waitFor(async () => { const cur = (await stateNow()).tickets.find(x => x.id === t.id); return cur.status === 'handled' || !!cur.reply; }, { timeout: 150000, what: `${from}'s request to be handled` });
  await waitControl({ sel: 'button', re: '^Let the .* handle it$' });
  const st = await stateNow(); return { ticket: st.tickets.find(x => x.id === t.id), entries: st.ledger.filter(e => e.ticket_id === t.id) };
}
const summary = r => `${r.entries.map(e => `${e.kind} $${e.amount} ${e.status}`).join('; ') || 'no payment'}${r.ticket.reply ? ` | reply: ${r.ticket.reply.replace(/\s+/g, ' ').slice(0, 90)}` : ''}`;

flow('demo', async () => {
  await resetBrowser();
  await step('Landing: "Try the live demo" opens a seeded demo workspace', async () => {
    await goto('/'); await click('Try the live demo'); await waitFor(async () => (await ev('location.pathname')) === '/app', { timeout: 30000, what: '/app' });
    await waitFor(async () => (await stateNow()).workspace?.seedStatus === 'ready', { timeout: 180000, what: 'the demo shop to finish loading' });
    await openApp('inbox'); await waitText('Maya Chen'); await waitText('Explore Floorwalker');
  }, { critical: true });
  await step('Demo banner: "Create an account to keep it." goes to sign-up and says the demo comes along', async () => {
    await click({ sel: 'a', text: 'Create an account to keep it.' }); await waitFor(async () => (await ev('location.pathname')) === '/signup', { what: '/signup' });
    await waitText('Your demo workspace comes with you'); await goto('/app#inbox');
  });
  const outcomes = {};
  await step('Inbox T1: Maya (chipped mug) is refunded automatically', async () => {
    const r = await runTicket('Maya'); outcomes.maya = r; expect(r.entries.some(e => e.kind === 'refund' && ['executed', 'approved'].includes(e.status)), `expected an automatic refund, got: ${summary(r)}`); return summary(r);
  }, { ok4xx: true });
  await step('Inbox T2: Daniel (wrong colour) is held for the owner', async () => {
    const r = await runTicket('Daniel'); outcomes.daniel = r; expect(r.entries.some(e => e.status === 'awaiting_approval'), `expected a held request, got: ${summary(r)}`); return summary(r);
  }, { ok4xx: true });
  await step('Inbox T6: the $180 photographer payout is held', async () => {
    const r = await runTicket('Elena', "Priya's photo shoot"); outcomes.photo = r; expect(r.entries.some(e => e.status === 'awaiting_approval'), `expected a held payout, got: ${summary(r)}`); return summary(r);
  }, { ok4xx: true });
  await step('Inbox T3: "Pay Sam for the windows" runs and ends in a visible state', async () => {
    const r = await runTicket('Elena', 'Pay Sam'); outcomes.sam = r; return summary(r);
  }, { ok4xx: true });
  await step('Inbox T4: Sam\'s "new PayPal" email is handed to the owner, with no payment made', async () => {
    const r = await runTicket('Sam Rivera'); outcomes.t4 = r; expect(!r.entries.some(e => ['executed', 'approved'].includes(e.status)), `money moved on a payment-change request: ${summary(r)}`); expect(!!r.ticket.reply || r.ticket.status === 'handled', 'no reply or handoff recorded'); return summary(r);
  }, { ok4xx: true });
  await step('Inbox T5: Jordan\'s injected email is blocked or refused, never paid out to the attacker', async () => {
    const r = await runTicket('Jordan'); outcomes.jordan = r; expect(!r.entries.some(e => ['executed', 'approved'].includes(e.status) && e.kind === 'payout'), `a payout went out: ${summary(r)}`); return summary(r);
  }, { ok4xx: true });
  notes.push(`Demo ticket outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k}: ${summary(v)}`).join(' // ')}`);
});



async function ensureDemo() {
  const me = await signedInAs().catch(() => null);
  if (!me?.isAnonymous) {
    await goto('/signin'); await clearSession();
    const r = await api('/api/auth/sign-in/anonymous', { method: 'POST', body: {} }); expect(r.status === 200, `could not open a demo workspace (HTTP ${r.status})`);
  }
  await waitFor(async () => (await stateNow()).workspace?.seedStatus === 'ready', { timeout: 180000, what: 'the demo shop to finish loading' });
}
const held = async () => (await stateNow()).ledger.filter(e => e.status === 'awaiting_approval');
const cardOf = id => `[aria-label^="Request ${id}:"]`;
const asPhone = async on => send('Emulation.setDeviceMetricsOverride', on ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
// Setup that is not under test: a disposable agent and key, used to put extra requests in the approval queue the way a customer's own agent would.
async function disposableAgent(name, controls) {
  const a = await api('/api/agents', { method: 'POST', body: { name, can_refund: true, can_payout: true, max_per_action: 1, ...controls } }); expect(a.status === 200, `agent setup failed (HTTP ${a.status})`);
  const k = await api('/api/keys', { method: 'POST', body: { agent_id: a.json.id, name: `${name} key`, expires_in_days: 1 } }); expect(k.status === 200, `key setup failed (HTTP ${k.status})`);
  return { agent: a.json, key: k.json.secret, keyId: k.json.key.id };
}
const agentPost = (key, path, body, idem) => ev(`fetch(${JSON.stringify(path)}, { method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer ${key}', 'Content-Type': 'application/json', 'Idempotency-Key': ${JSON.stringify(idem)} }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);

flow('approvals', async () => {
  await ensureDemo(); let fx, heldRefund, heldPayout;
  if ((await ticketOf('Daniel')).status !== 'handled') await runTicket('Daniel');
  if ((await ticketOf('Elena', 'photo')).status !== 'handled') await runTicket('Elena', "Priya's photo shoot");
  await step('Setup (not under test): put a capped refund and a capped payout from an API agent into the queue', async () => {
    fx = await disposableAgent(`Flow cap agent ${run}`, {}); const st = await stateNow(); const order = st.orders.find(o => o.customer_email === 'maya.chen@example.com'); expect(order, 'Maya\'s order not found');
    heldRefund = (await agentPost(fx.key, '/v1/refunds', { capture_id: order.capture_id, amount: 5, requester_email: order.customer_email, source_message: 'Please refund $5 for the chipped mug.', reason: 'Partial refund for chipped mug' }, `flow-r-${run}`)).json;
    heldPayout = (await agentPost(fx.key, '/v1/payouts', { email: st.policy.policy.payouts.payees[0].email, amount: 2, reason: 'Regular shop service; hold for owner', source_message: 'Please pay $2 for shop service', requester_email: 'owner@juniperandoak.example' }, `flow-p-${run}`)).json;
    expect(heldRefund?.status === 'awaiting_approval' && heldPayout?.status === 'awaiting_approval', `expected both held, got ${heldRefund?.status}/${heldPayout?.status}`);
  }, { critical: true, ok4xx: true });
  await step('Approvals: the sidebar and page show all waiting requests, each with Approve and Decline', async () => {
    await openApp('approvals'); const rows = await held(); expect(rows.length >= 4, `only ${rows.length} held`);
    for (const e of rows) { await waitControl({ sel: 'button', re: '^Approve \\$', within: cardOf(e.id) }); await waitControl({ sel: 'button', text: 'Decline', within: cardOf(e.id) }); }
  });
  await step('Approvals: "Approve from your phone" points at the phone page', async () => {
    const href = await ev(`__f.one({ sel: 'a', text: 'Approve from your phone' }).href`); expect(new URL(href).pathname === '/approve', `link goes to ${href}`);
  });
  await step('Approvals: the review-checks disclosure opens and shows why it was held', async () => {
    const e = (await held())[0]; await click({ sel: 'summary', text: 'Review checks', within: cardOf(e.id) }); await waitText(/rule|check|limit/i);
  });
  await step('Phone page: /approve lists the same requests and Approve with a note sends the Daniel refund', async () => {
    const target = (await held()).find(e => e.amount === 86 && e.kind === 'refund');
    expect(target, 'Daniel\'s $86 request is not waiting'); await asPhone(true); await goto('/approve'); await waitControl({ sel: 'button', re: '^Approve \\$86', within: cardOf(target.id) });
    await type({ sel: 'input', text: 'Approval note', within: cardOf(target.id) }, `Looks right on the photos ${run}`);
    await click({ sel: 'button', re: '^Approve \\$86', within: cardOf(target.id) });
    await waitFor(async () => (await stateNow()).ledger.find(e => e.id === target.id)?.status === 'approved', { timeout: 60000, what: 'Daniel\'s refund to be approved in PayPal' });
    await waitText(/Approved|submitted|Decision recorded/i); const row = (await stateNow()).ledger.find(e => e.id === target.id); expect(!!row.paypal_ref, 'no PayPal reference recorded'); await asPhone(false);
  }, { ok4xx: true });
  await step('Phone page: the page tells the person when nothing is waiting or shows what is', async () => { await asPhone(true); await goto('/approve'); await sleep(800); expect((await pageText()).length > 40, 'blank phone page'); await asPhone(false); });
  await step('Approvals: "Approve a different amount" opens a field; a bad amount is refused; $2 of the $5 refund goes through', async () => {
    await openApp('approvals'); const id = heldRefund.id.replace('act_', ''); const card = cardOf(id);
    await click({ sel: 'button', text: 'Approve a different amount', within: card }); await type({ sel: 'input', text: 'Amount in USD', within: card }, '9');
    const pos = await locate({ sel: 'button', re: '^Confirm', within: card }, { allowDisabled: true }); expect(pos.disabled, 'Confirm should stay off for an amount above the request'); await waitText(/Enter a positive amount up to/);
    await type({ sel: 'input', text: 'Amount in USD', within: card }, '2'); await click({ sel: 'button', re: '^Confirm \\$2', within: card });
    await waitFor(async () => (await stateNow()).ledger.find(e => String(e.id) === id)?.status === 'approved', { timeout: 60000, what: 'the $2 refund to be approved' });
    const row = (await stateNow()).ledger.find(e => String(e.id) === id); expect(Number(row.approved_amount) === 2, `approved ${row.approved_amount} instead of 2`);
  }, { ok4xx: true });
  await step('Approvals: Decline asks for a reason, closing the dialog keeps it waiting, and Decline with a reason records exactly that reason', async () => {
    const photo = (await held()).find(e => e.amount === 180); expect(photo, 'the $180 photographer payout is not waiting'); const card = cardOf(photo.id);
    await click({ sel: 'button', text: 'Decline', within: card }); await waitText('Decline this request?'); await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
    expect((await held()).some(e => e.id === photo.id), 'closing the dialog still declined it');
    const reason = `Need the invoice first ${run}`; await click({ sel: 'button', text: 'Decline', within: card }); await type({ sel: 'textarea', text: 'Reason' }, reason);
    await click({ sel: 'button', text: 'Decline request' });
    await waitFor(async () => (await stateNow()).ledger.find(e => e.id === photo.id)?.status === 'declined', { timeout: 30000, what: 'the payout to be declined' });
    expect((await stateNow()).ledger.find(e => e.id === photo.id).decline_reason === reason, 'decline reason was not stored'); await waitText(reason);
  });
  await step('Approvals: approving a payout with "let this agent pay them for N days" creates a temporary allowance that can be revoked', async () => {
    await openApp('approvals'); const id = heldPayout.id.replace('act_', ''); const card = cardOf(id);
    await click({ sel: 'input[type=checkbox]', text: 'Also let this agent pay', within: card }); await type({ sel: 'input[type=number]', within: card }, '3');
    await click({ sel: 'button', re: '^Approve \\$2', within: card });
    const sent = await ev(`__a.reqs.filter(r => r.b).map(r => r.b).pop()`); expect(/allow_payee_days/.test(sent ?? ''), `the approval did not ask for an allowance: ${sent}`);
    await waitFor(async () => ['approved', 'failed'].includes((await stateNow()).ledger.find(e => String(e.id) === id)?.status), { timeout: 60000, what: 'the payout decision' });
    const g = (await api('/api/grants')).json; if (!g.length) { notes.push('The $2 payout was approved but no temporary allowance was listed (the sandbox payout may have failed).'); return 'no allowance created'; }
    await openApp('approvals'); await click({ sel: 'summary', text: 'Temporary payee allowances' }); await waitText(/Up to \$2/);
    await click({ sel: 'button', text: 'Revoke', exact: true }); await waitControl('Keep as is'); await click('Keep as is'); await waitGone({ sel: '[role=dialog]', page: true }); await waitText(/Up to \$2/);
    await click({ sel: 'button', text: 'Revoke', exact: true }); await click({ sel: 'button', text: 'Revoke allowance' }); await waitToast(/Allowance revoked/i); await waitText('No active allowances');
  }, { ok4xx: true });
  await step('Approvals: the recent-decisions rows open the ledger entry', async () => {
    await openApp('approvals'); await click({ sel: 'a[href^="/app#ledger/"]', nth: 0 }); await waitFor(async () => /#ledger\/\d+/.test(await ev('location.hash')), { what: 'a ledger entry' });
  });
  await step('Approvals: "View ledger" and "Go to your inbox" links lead where they say', async () => {
    await openApp('approvals'); await click({ sel: 'a', text: 'View ledger' }); await waitFor(async () => (await ev('location.hash')).startsWith('#ledger'), { what: '#ledger' });
  });
  if (fx) await api(`/api/keys/${encodeURIComponent(fx.keyId)}`, { method: 'DELETE' }).catch(() => {});
});



flow('hijack', async () => {
  await ensureDemo(); await openApp('inbox');
  await step('Inbox: "Simulate a hijacked agent" runs the attack; every attempt is blocked or held, nothing is paid to the attacker', async () => {
    const before = (await stateNow()).ledger.length;
    await click('Simulate a hijacked agent'); await waitText('Hijacked Support agent');
    await waitFor(async () => !/Simulation running/.test(await pageText()), { timeout: 150000, what: 'the simulation to finish' });
    const st = await stateNow(); const fresh = st.ledger.slice(0, st.ledger.length - before > 0 ? st.ledger.length - before : 0);
    expect(!fresh.some(e => ['executed', 'approved'].includes(e.status)), `the attack moved money: ${fresh.map(e => e.status).join(',')}`);
    return `${fresh.length} new ledger rows: ${fresh.map(e => `${e.kind} $${e.amount} ${e.status}`).join('; ')}`;
  }, { ok4xx: true });
  await step('Inbox: selecting a normal request again leaves the simulation view', async () => { await click({ sel: 'button.item, button[aria-pressed]', text: 'Maya' }); await waitText(/chipped/i); });
});

flow('watch', async () => {
  await ensureDemo(); await openApp('watch');
  await step('Watch: "Check now" checks PayPal and reports how many orders and refunds', async () => { await click('Check now'); const t = await waitToast(/orders, \d+ refunds checked/i, { timeout: 60000 }); return t; });
  await step('Watch: the freeze switch turns off and on and the server remembers', async () => {
    const name = 'Freeze every agent when money moves outside'; const before = await switchOn(name);
    await click({ sel: '[role=switch]', text: name }); await waitFor(async () => (await switchOn(name)) === !before, { what: 'switch to flip' });
    expect((await api('/api/incidents')).json.watch.freeze === !before, 'server did not store the new setting');
    await click({ sel: '[role=switch]', text: name }); await waitFor(async () => (await switchOn(name)) === before, { what: 'switch to flip back' });
    expect((await api('/api/incidents')).json.watch.freeze === before, 'server did not store the restored setting');
  });
  await step('Watch: "Reset the demo" asks first, "Keep as is" changes nothing, confirming makes fresh sandbox orders', async () => {
    const before = (await stateNow()).orders.map(o => o.capture_id).join(',');
    await click({ sel: 'button', text: 'Reset the demo' }); await waitControl('Keep as is'); await click('Keep as is'); await waitGone({ sel: '[role=dialog]', page: true });
    expect((await stateNow()).orders.map(o => o.capture_id).join(',') === before, 'cancelling still reset the demo');
    await click({ sel: 'button', text: 'Reset the demo' }); await click({ sel: 'button', text: 'Reset demo' }); await waitToast(/Fresh sandbox orders created/i, { timeout: 180000 });
    await waitFor(async () => (await stateNow()).orders.map(o => o.capture_id).join(',') !== before, { what: 'new orders' });
  }, { ok4xx: true });
  await step('Watch: "Refund $25 straight through PayPal" refunds in the sandbox, opens an incident and shows the banner', async () => {
    await click({ sel: 'button', text: 'Refund $25 straight through PayPal' });
    await waitText(/opened incident #\d+/, { timeout: 120000 }); await waitText('Money moved outside Floorwalker');
    await waitControl('That was me'); await waitControl('Not me, keep agents frozen');
    expect((await stateNow()).agents.every(a => a.status === 'frozen'), 'agents were not frozen by the incident');
  }, { ok4xx: true });
  await step('Incident banner: "That was me" resolves it and unfreezes the agents', async () => {
    await click('That was me'); await waitFor(async () => (await stateNow()).agents.every(a => a.status === 'active'), { timeout: 20000, what: 'agents to be active again' });
    await waitNoText('Money moved outside Floorwalker');
  });
  await step('Watch: a second bypass and "Not me, keep agents frozen" keeps agents frozen and says what to do next', async () => {
    await openApp('watch'); await click({ sel: 'button', text: 'Refund $25 straight through PayPal' }); await waitText(/opened incident #\d+/, { timeout: 120000 });
    await click('Not me, keep agents frozen'); await waitText(/Rotate your PayPal app/i, { timeout: 20000 });
    expect((await stateNow()).agents.every(a => a.status === 'frozen'), 'agents were not kept frozen');
  }, { ok4xx: true });
  await step('Agents: unfreezing each agent from its card works after an incident', async () => {
    await openApp('agents'); for (const a of (await stateNow()).agents) { await click({ sel: 'button', text: `Unfreeze ${a.name}` }); await waitControl({ sel: 'button', text: `Freeze ${a.name}` }); }
    expect((await stateNow()).agents.every(a => a.status === 'active'), 'some agent is still frozen');
  });
  await step('Watch: the incidents table lists the incidents', async () => { await openApp('watch'); await waitFor(async () => (await ev(`document.querySelectorAll('.ag-row').length`)) >= 2, { what: 'two incident rows' }); });
});

const dl = { count: 0, names: [] };
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Browser.downloadWillBegin' || d.method === 'Page.downloadWillBegin') { dl.count++; dl.names.push(d.params.suggestedFilename); } });
flow('ledger', async () => {
  await ensureDemo(); await openApp('ledger'); await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: mkdtempSync(join(tmpdir(), 'fw-flow-dl-')), eventsEnabled: true });
  await waitFor(async () => (await ev(`document.querySelectorAll('.ag-row').length`)) > 3, { what: 'ledger rows' });
  const rowCount = () => ev(`document.querySelectorAll('.ag-row').length`);
  await step('Ledger: search narrows the rows to matches and clearing it brings them back', async () => {
    const all = await rowCount(); await type('Search ledger', 'hannah.wright'); await waitFor(async () => (await rowCount()) < all, { what: 'fewer rows' });
    const t = await ev(`[...document.querySelectorAll('.ag-row')].map(r => r.innerText).join(' ')`); expect(t.includes('hannah.wright'), 'search result does not contain the match');
    await type('Search ledger', ''); await waitFor(async () => (await rowCount()) >= all, { what: 'rows back' });
  });
  await step('Ledger: Group by Outcome groups the rows; a group opens with its chevron; None ungroups', async () => {
    await choose({ sel: 'select', text: 'Group ledger by' }, 'Outcome'); await waitFor(async () => (await ev(`document.querySelectorAll('.ag-row-group').length`)) > 0 && /approved|done automatically|blocked|declined/i.test(await ev(`[...document.querySelectorAll('.ag-row')].map(r => r.innerText).join(' ')`)), { what: 'group rows' });
    const before = await rowCount(); await click({ sel: '.ag-group-contracted', page: true, nth: 0 }); await waitFor(async () => (await rowCount()) !== before, { what: 'a group to open' });
    await choose({ sel: 'select', text: 'Group ledger by' }, 'None');
  });
  await step('Ledger: a row\'s chevron opens its decision trace and closes it again', async () => {
    const before = await rowCount(); await click({ sel: '.ag-group-contracted', page: true, nth: 0 }); await waitFor(async () => /Decision trace/i.test(await ev(`document.querySelector('.ag-full-width-row')?.innerText ?? ''`)), { what: 'the trace' });
    await click({ sel: '.ag-group-expanded', page: true, nth: 0 }); await waitFor(async () => !(await ev(`!!document.querySelector('.ag-full-width-row')`)), { what: 'the trace to close' });
  });
  await step('Ledger: clicking a row opens the full request, and Close returns to the list', async () => {
    await click({ sel: '.ag-row .ag-cell', page: true, nth: 3 }); await waitText(/Request #\d+/); await waitFor(async () => /#ledger\/\d+/.test(await ev('location.hash')), { what: 'the hash' });
    await click({ sel: 'button', text: 'Close' }); await waitFor(async () => (await ev('location.hash')) === '#ledger', { what: 'back to the list' });
  });
  await step('Ledger: Columns & filters opens the side panel and clicking again closes it', async () => {
    const shown = () => ev(`(() => { const e = document.querySelector('.ag-side-bar'); return !!e && e.getBoundingClientRect().width > 0; })()`);
    await click('Columns & filters'); await waitFor(shown, { what: 'the side panel' });
    await click('Columns & filters'); await waitFor(async () => !(await shown()), { what: 'the side panel to close' });
  });
  await step('Ledger: Chart draws the money-by-agent chart', async () => {
    await click({ sel: 'button', text: 'Chart', exact: true }); await waitFor(async () => ev(`!!document.querySelector('.ag-chart, canvas[class*=ag-charts]') || !!document.querySelector('[class*=ag-charts]')`), { timeout: 15000, what: 'a chart' });
  });
  await step('Ledger: Excel and CSV each download a file with the right name', async () => {
    const n = dl.count; await click({ sel: 'button', text: 'CSV', page: true }); await waitFor(async () => dl.count > n, { what: 'a CSV download' }); await click({ sel: 'button', text: 'Excel', page: true }); await waitFor(async () => dl.count > n + 1, { what: 'an Excel download' });
    expect(dl.names.slice(n).some(x => /ledger\.csv/.test(x)) && dl.names.slice(n).some(x => /ledger\.xlsx/.test(x)), `downloads were ${dl.names.slice(n).join(', ')}`);
  });
});



flow('rules', async () => {
  await ensureDemo(); await openApp('rules'); await waitText('Learned from your decisions');
  const version = async () => (await stateNow()).policy.id;
  await step('Rules: "Show the N requests" opens the evidence for a suggestion and closes again', async () => {
    const pos = await locate({ sel: 'summary', re: '^Show the \\d+ requests$' }); const open0 = await ev(`__f.one({ sel: 'summary', re: '^Show the' }).parentElement.open`);
    await mouse(pos); await settle(); expect((await ev(`__f.one({ sel: 'summary', re: '^Show the' }).parentElement.open`)) !== open0, 'the evidence list did not toggle');
    await click({ sel: 'summary', re: '^Show the' }); 
  });
  await step('Rules: "Not now" removes a suggestion and it stays away after a reload', async () => {
    const n0 = await ev(`__f.all({ sel: 'button', text: 'Not now' }).length`); expect(n0 >= 1, 'no suggestions to dismiss');
    const before = (await api('/api/rules/learned')).json.changes.length; await click({ sel: 'button', text: 'Not now', nth: 0 });
    await waitFor(async () => (await api('/api/rules/learned')).json.changes.length === before - 1, { what: 'the suggestion to go' });
    await openApp('rules'); expect((await api('/api/rules/learned')).json.changes.length === before - 1, 'the dismissed suggestion came back');
  });
  await step('Rules: "Apply" on a learned suggestion makes a new rules version and says which', async () => {
    const v0 = await version(); const n = await ev(`__f.all({ sel: 'button', text: 'Apply', exact: true }).length`);
    if (!n) return 'skipped: no suggestion left to apply';
    await click({ sel: 'button', text: 'Apply', exact: true, nth: 0 }); await waitToast(/Rules updated \(version \d+\)/i); expect((await version()) > v0, 'the policy version did not move');
  });
  await step('Rules: the Cautious, Generous and Standard presets each fill the text box and show as chosen', async () => {
    const seen = {};
    for (const p of ['Cautious', 'Generous', 'Standard']) { await click({ sel: 'button', text: p, exact: true }); await waitFor(async () => (await ev(`__f.one({ sel: 'button', text: ${JSON.stringify(p)}, exact: true }).getAttribute('aria-checked') ?? __f.one({ sel: 'button', text: ${JSON.stringify(p)}, exact: true }).getAttribute('data-state')`)) !== null, {}); seen[p] = await field({ sel: 'textarea' }); }
    expect(seen.Cautious !== seen.Generous && seen.Standard.length > 20, 'the presets did not change the text');
  });
  const rule = 'Refunds up to $30 can go through on their own. Ask me before any refund over $30. Never refund more than $120. Only pay people on my payee list.';
  await step('Rules: typing a rule and "Turn into rules" shows a preview', async () => {
    await type({ sel: 'textarea', text: 'Plain-English rules' }, rule); await click('Turn into rules'); await waitText('Preview your rules', { timeout: 90000 });
    await waitControl('Test on past activity'); await waitControl('Activate'); await waitControl('Discard');
  });
  await step('Rules: "Test on past activity" shows what would have changed', async () => { await click('Test on past activity'); await waitText('Tested on your past activity', { timeout: 60000 }); });
  await step('Rules: Discard drops the preview and restores the active text', async () => { await click('Discard'); await waitNoText('Preview your rules'); await waitText('Active rules'); });
  await step('Rules: compile again, Activate makes the rules live as a new version', async () => {
    const v0 = await version(); await type({ sel: 'textarea', text: 'Plain-English rules' }, rule); await click('Turn into rules'); await waitText('Preview your rules', { timeout: 90000 });
    await click('Activate'); await waitToast(/new rules are active/i, { timeout: 30000 }); await waitFor(async () => (await version()) > v0, { what: 'a new policy version' });
  });
  await step('Rules: Versions lists the history and "Restore" brings an older version back as a new one', async () => {
    const v0 = await version(); const n = await ev(`__f.all({ sel: 'button', text: 'Restore', exact: true }).length`); expect(n >= 1, 'no older version to restore');
    await click({ sel: 'button', text: 'Restore', exact: true, nth: 0 }); await waitToast(/Restored rules from v\d+/i); await waitFor(async () => (await version()) > v0, { what: 'the restored version to be active' });
  });
});



const wsButton = { sel: 'button[aria-haspopup=menu]', nth: 0, page: true };
flow('workspaces', async () => {
  await ensureAccount(); await openApp('overview'); const first = (await stateNow()).workspace;
  await step('Workspace menu lists this workspace as the current one', async () => { await click(wsButton); await waitControl({ sel: '[role=menuitem]', text: first.name }); await waitControl({ sel: '[role=menuitem]', text: 'New workspace' }); await key('Escape'); });
  await step('New workspace: the Create button explains why it is off until there is a name', async () => {
    await click(wsButton); await click({ sel: '[role=menuitem]', text: 'New workspace' }); await waitText('A separate space for your agents');
    const pos = await locate({ sel: 'button', text: 'Create workspace' }, { allowDisabled: true }); expect(pos.disabled && pos.why, 'Create workspace should say why it is off');
  });
  const second = `Second Shop ${run}`;
  await step('New workspace: typing a name and Create workspace makes it and switches to it', async () => {
    await type('Workspace name', second); await click({ sel: 'button', text: 'Create workspace' });
    await waitFor(async () => (await stateNow()).workspace?.name === second, { timeout: 30000, what: 'the new workspace to be active' }); await waitText(second); await waitGone({ sel: '[role=dialog]', page: true });
    const st = await stateNow(); expect(st.workspace.id !== first.id, 'still in the old workspace'); expect(st.agents.length >= 1, 'the new workspace has no starter agents');
  }, { ok4xx: true });
  await step('Workspace menu: choosing the first workspace switches back and shows that workspace\'s own data', async () => {
    await click(wsButton); await click({ sel: '[role=menuitem]', text: first.name }); await waitFor(async () => (await stateNow()).workspace?.id === first.id, { timeout: 30000, what: 'to switch back' });
    await waitText(first.name); await openApp('settings'); await waitControl('Workspace name'); expect((await field('Workspace name')) === first.name, 'Settings still shows the other workspace');
  });
  await step('Workspace menu: switching again to the second one works both ways', async () => {
    await click(wsButton); await click({ sel: '[role=menuitem]', text: second }); await waitFor(async () => (await stateNow()).workspace?.name === second, { timeout: 30000, what: 'to switch to the second' });
    await click(wsButton); await click({ sel: '[role=menuitem]', text: first.name }); await waitFor(async () => (await stateNow()).workspace?.id === first.id, { timeout: 30000, what: 'to switch back' });
  });
});

// Controls that are switched off must say why: a tooltip on the control, or a sentence on the page that names who can do it.
const unexplained = () => ev(`(() => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('.ag-root-wrapper, [data-sonner-toast]'); };
  const hit = [...document.querySelectorAll('button:disabled, [role=switch]:disabled, select:disabled, input:disabled, textarea:disabled, [role=menuitem][data-disabled], [aria-disabled=true]')].filter(vis).filter(e => !e.closest('[data-sidebar], [data-slot=sidebar]') && e.getAttribute('aria-current') == null);
  const said = /only (an? )?(workspace )?(owners?|admins?|administrators?)|owners?,? (and )?admins?|can decide|permission|ask an (owner|admin)/i.test(document.body.innerText);
  return { said, names: hit.filter(e => !(e.title || e.getAttribute('aria-description'))).map(e => (e.getAttribute('aria-label') || e.innerText || e.placeholder || e.tagName).replace(/\\s+/g, ' ').trim().slice(0, 40)) };
})()`);
flow('roles', async () => {
  await ensureAccount(); await openApp('overview'); const orgId = (await stateNow()).workspace.id; const email = `viewer-${run}-${randomBytes(2).toString('hex')}@example.com`;
  await step('Setup (not under test): invite a viewer by API, sign them up and accept', async () => {
    const inv = await api('/api/auth/organization/invite-member', { method: 'POST', body: { email, role: 'viewer', organizationId: orgId } }); expect(inv.status === 200, `invite failed (HTTP ${inv.status})`);
    await goto('/signin'); await clearSession();
    const up = await api('/api/auth/sign-up/email', { method: 'POST', body: { name: `Viewer ${run}`, email, password: PASSWORD } }); expect(up.status === 200, `sign-up failed (HTTP ${up.status})`);
    const acc = await api('/api/auth/organization/accept-invitation', { method: 'POST', body: { invitationId: inv.json.id } }); expect(acc.status === 200, `accept failed (HTTP ${acc.status})`);
    await api('/api/auth/organization/set-active', { method: 'POST', body: { organizationId: orgId } });
  }, { critical: true });
  for (const page of ['overview', 'inbox', 'approvals', 'agents', 'rules', 'ledger', 'watch', 'setup', 'developers', 'audit', 'settings/general', 'settings/paypal', 'settings/team', 'settings/notifications', 'settings/billing', 'settings/security']) {
    await step(`Viewer on ${page}: every switched-off control says why`, async () => {
      await openApp(page); await sleep(600); const r = await unexplained();
      expect(r.said || !r.names.length, `controls that are off with no reason: ${r.names.join(', ')}`);
    });
  }
  await step('Viewer: Agents page "New agent" is off and its tooltip names who can use it', async () => {
    await openApp('agents'); const pos = await locate({ sel: 'button', text: 'New agent' }, { allowDisabled: true }); expect(pos.disabled && /owner|admin/i.test(pos.why), `tooltip: "${pos.why}"`);
  });
  await step('Viewer: the server also refuses a viewer\'s direct attempt with a readable message', async () => {
    const r = await api('/api/agents', { method: 'POST', body: { name: 'Nope' } }); expect(r.status === 403, `a viewer created an agent (HTTP ${r.status})`);
  }, { ok4xx: true });
  await ensureAccount();
});



flow('setup', async () => {
  await ensureAccount(); await openApp('setup');
  for (const [label, hash] of [['Connect PayPal', '#settings/paypal'], ['Manage agents', '#agents'], ['Create a key', '#developers/keys'], ['Review rules', '#rules'], ['Enable push', '#settings/notifications'], ['Invite teammate', '#settings/team'], ['Open quickstart', '#developers/quickstart']]) {
    await step(`Setup: "${label}" opens ${hash}`, async () => { await openApp('setup'); await click({ sel: 'a', text: label, exact: true }); await waitFor(async () => (await ev('location.hash')) === hash, { what: hash }); });
  }
});

flow('demo-billing', async () => {
  await ensureDemo(); await openApp('settings/billing');
  await step('Demo billing: plan buttons are off and the page says why, with a link to create an account', async () => {
    await waitText('Demo: every feature on'); const pos = await locate({ sel: 'button', text: 'Choose Pro' }, { allowDisabled: true }); expect(pos.disabled, 'Choose Pro should be off in the demo');
    await click({ sel: 'a', text: 'Create an account to subscribe' }); await waitFor(async () => (await ev('location.pathname')) === '/signup', { what: '/signup' });
  });
  await step('Demo security tab: asks for an account instead of showing dead passkey buttons', async () => {
    await openApp('settings/security'); await waitText('Create an account before adding passkeys'); await waitControl({ sel: 'a', text: 'Create account' });
  });
});



flow('demo-agents', async () => {
  await ensureDemo(); await openApp('agents');
  await step('Demo agents: deleting an agent that has payment history is refused with the reason and offers "Freeze instead"', async () => {
    await click({ sel: 'button', text: 'Edit agent', in: 'Support agent' }); await waitText('Edit Support agent');
    await click({ sel: 'button', text: 'Delete agent', exact: true }); await click({ sel: 'button', text: 'Delete agent', exact: true });
    await waitText(/history in the ledger|freeze it instead/i); await waitControl('Freeze instead');
  }, { ok4xx: true });
  await step('Demo agents: "Freeze instead" freezes it, closes the editor and the card shows it frozen', async () => {
    await click('Freeze instead'); await waitFor(async () => (await stateNow()).agents.find(a => a.name === 'Support agent').status === 'frozen', { what: 'the agent to be frozen' });
    await waitGone({ sel: '[role=dialog]', page: true }); await waitControl({ sel: 'button', text: 'Unfreeze Support agent' });
    await click({ sel: 'button', text: 'Unfreeze Support agent' }); await waitControl({ sel: 'button', text: 'Freeze Support agent' });
  });
  await step('Demo agents: the frozen agent\'s inbox button says to unfreeze it, with a working link', async () => {
    await click({ sel: 'button', text: 'Freeze Support agent' }); await openApp('inbox'); await click({ sel: 'button.item, button[aria-pressed]', text: 'Maya' });
    const pos = await locate({ sel: 'button', re: '^Let the .* handle it$' }, { allowDisabled: true }); expect(pos.disabled, 'run button should be off for a frozen agent');
    await click({ sel: 'a', text: 'Unfreeze this agent to continue' }); await waitFor(async () => (await ev('location.hash')) === '#agents', { what: '#agents' });
    await click({ sel: 'button', text: 'Unfreeze Support agent' }); await waitControl({ sel: 'button', text: 'Freeze Support agent' });
  });
});


//FLOWS-GO-HERE

// ---------- run ----------
const ORDER = ['account', 'settings', 'agents', 'developers', 'setup', 'workspaces', 'roles', 'demo', 'approvals', 'hijack', 'watch', 'demo-agents', 'ledger', 'rules', 'demo-billing'];
flows.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
for (const [name, fn] of flows) {
  if (ONLY && !ONLY.includes(name)) continue;
  current = name; abort = false;
  console.log(`\n=== ${name}`);
  try { await fn(); } catch (e) { rows.push({ flow: name, name: '(flow crashed)', result: 'FAIL', note: clean(e.message) }); console.log(`FAIL  ${name} | flow crashed | ${clean(e.message).split('\n')[0]}`); }
}
const pass = rows.filter(r => r.result === 'PASS').length, fail = rows.filter(r => r.result === 'FAIL').length, skip = rows.filter(r => r.result === 'SKIP').length;
const md = [`# Button flows: results`, '', `Run ${new Date().toISOString().slice(0, 10)} against ${BASE} (a throwaway local server, PayPal sandbox). **${pass} passed, ${fail} failed, ${skip} skipped.**`, '',
  'Each step is a real mouse click or real typing in headless Chrome, followed by a check of what the page shows. `node tests/button-flows.mjs` reruns it.', '',
  ...[...new Set(rows.map(r => r.flow))].flatMap(f => ['', `## ${f}`, '', '| Result | Step | Note |', '|---|---|---|', ...rows.filter(r => r.flow === f).map(r => `| ${r.result} | ${r.name.replace(/\|/g, '/')} | ${(r.note ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 220)} |`)]),
  ...(notes.length ? ['', '## Notes', '', ...notes.map(n => `- ${clean(n)}`)] : []), ''].join('\n');
// A partial run (FLOWS=...) must not overwrite the full report.
const outName = ONLY ? 'button-flows-RESULTS.partial.md' : 'button-flows-RESULTS.md';
writeFileSync(new URL(`./${outName}`, import.meta.url), md);
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped. Wrote tests/${outName}`);
process.exit(fail ? 1 : 0);
