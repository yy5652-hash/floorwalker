// Drives complete user flows through the Floorwalker web app in a real browser with real mouse clicks and real typing,
// and checks what the person would see afterwards. Rerunnable; prints PASS/FAIL per step, exits nonzero if any step failed,
// and writes tests/button-flows-RESULTS.md.
//
//   node tests/button-flows.mjs [base URL]            (default http://localhost:18999)
//   FLOWS=account,settings node tests/button-flows.mjs   run only some flows (account settings agents developers setup workspaces roles demo approvals trust hijack watch demo-agents ledger rules inbox demo-billing landing mobile pages)
//   FLOW_COOKIES=file keeps the browser cookies between runs (so the demo workspace is reused); FLOW_RUN=name reuses one test account across partial reruns; FLOW_PROFILE=dir keeps the browser profile (and so the demo session) between runs
//   FLOW_PAYPAL_CLIENT_ID / FLOW_PAYPAL_CLIENT_SECRET (a PayPal sandbox app) add the connect-real-credentials step; without them it is skipped
//
// Run it against a throwaway local server, never the live site (it signs up accounts, creates keys, refunds sandbox orders):
//   NODE_ENV=production PORT=18999 DATA_DIR=notes/.flow/ws FLOORWALKER_CORE_DB=notes/.flow/core.db \
//   FLOORWALKER_BASE_URL=http://localhost:18999 BETTER_AUTH_URL=http://localhost:18999 npx tsx server/index.ts
// Anonymous sign-in is rationed at 6/hour per IP and email sign-up at 10/hour; restart the server to reset them.
// PayPal is sandbox only. The script never approves a PayPal subscription.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
// Console errors and warnings, with the page they came from. The AG Grid licence banner is a known missing key, not a defect.
const consoleMsgs = []; const IGNORE_CONSOLE = /licen[sc]e|\*{6}|unlocked for trial/i;
const consoleErrorsSince = n => consoleMsgs.slice(n).filter(m => !IGNORE_CONSOLE.test(m.text));
let consoleWhere = '';
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data);
  if (waiting.has(d.id)) { waiting.get(d.id)(d.result ?? { error: d.error }); waiting.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] ?? d.params.exceptionDetails.text);
  if (d.method === 'Page.javascriptDialogOpening') { dialogs.push({ type: d.params.type, message: d.params.message }); void send('Page.handleJavaScriptDialog', { accept: true }); }
  if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(d.params.type)) consoleMsgs.push({ type: d.params.type, where: consoleWhere, text: d.params.args.map(a => a.value ?? a.description ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 300) });
  if (d.method === 'Log.entryAdded' && ['error', 'warning'].includes(d.params.entry.level)) consoleMsgs.push({ type: d.params.entry.level, where: consoleWhere, text: `${d.params.entry.text} ${d.params.entry.url ?? ''}`.replace(/\s+/g, ' ').slice(0, 300) });
  if (d.method === 'Page.frameStartedLoading') navigating = true;
  if (d.method === 'Page.loadEventFired' || d.method === 'Page.frameStoppedLoading') navigating = false;
});
// A command sent while the page is navigating can go unanswered; give up on it after 60s rather than hanging the run.
const send = (method, params = {}) => new Promise(r => { const id = ++seq; const t = setTimeout(() => { waiting.delete(id); r({ error: { message: `${method} timed out` } }); }, 60000); waiting.set(id, x => { clearTimeout(t); r(x); }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error) throw new Error(r.error.message ?? 'browser command failed');
  if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text}`); return r.result?.value; };
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
// FLOW_COOKIES=file keeps the browser's cookies between runs (headless Chrome drops session cookies on exit), so an iterating run reuses the same demo workspace.
if (process.env.FLOW_COOKIES && existsSync(process.env.FLOW_COOKIES)) await send('Network.setCookies', { cookies: JSON.parse(readFileSync(process.env.FLOW_COOKIES, 'utf8')) });
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
  const url = path.startsWith('http') ? path : BASE + path; consoleWhere = path;
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
async function signedInAs() { if ((await ev('location.origin').catch(() => '')) !== BASE) await goto('/signin'); const r = await api('/api/auth/get-session'); return r.json?.user ?? null; }

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
  await step('Billing: the usage meter shows this month\'s actions against the plan limit, matching the server', async () => {
    const u = (await api('/api/billing/usage')).json; await waitText('Actions this month');
    const bar = await ev(`(() => { const b = document.querySelector('[role=progressbar][aria-label="Actions this month usage"]'); return b && { now: b.getAttribute('aria-valuenow'), max: b.getAttribute('aria-valuemax'), text: b.getAttribute('aria-valuetext') }; })()`);
    expect(bar && Number(bar.max) === u.monthlyLimit && Number(bar.now) === Math.min(u.actionsUsed, u.monthlyLimit), `the meter shows ${JSON.stringify(bar)} but the server says ${u.actionsUsed} of ${u.monthlyLimit}`);
    const t = await pageText(); expect(new RegExp(`${u.planName} plan`, 'i').test(t) && /Resets/.test(t), 'the meter does not name the plan or when it resets'); expect(/No per-action overage/.test(t), 'the meter does not say there is no overage');
    return `${u.actionsUsed} / ${u.monthlyLimit}`;
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



// The trust control inside an agent card: which level is chosen, the small-amount limit, and the preview line under it.
const trustOf = name => ev(`(() => { const h = [...document.querySelectorAll('h3')].find(h => h.innerText.trim() === ${JSON.stringify(name)}); const c = h?.closest('.agent-card'); if (!c) return null;
  return { level: c.querySelector('input[type=radio]:checked')?.value, amount: c.querySelector('.trust-save input')?.value, preview: c.querySelector('.trust-preview')?.innerText.replace(/\\s+/g, ' ').trim(), levels: [...c.querySelectorAll('.trust-levels small')].map(s => s.innerText.replace(/\\s+/g, ' ').trim()) }; })()`);
// Open a <details> by clicking its summary, but only when it is closed (its state can survive a refresh).
const openSummary = async spec => { const s = { sel: 'summary', ...spec }; if (!(await ev(`__f.one(${JSON.stringify(s)})?.parentElement.open`))) await click(s); };
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
    const card = await cardText(`Flow Bot ${run}`); const tr = await trustOf(`Flow Bot ${run}`);
    expect(tr?.level === 'small' && tr.amount === '40', `the trust control does not show the $40 cap: ${JSON.stringify(tr)}`);
    expect(/\$120/.test(card) && /per week/.test(card), `card does not show the budget:\n${card.replace(/\s+/g, ' ')}`);
    await openSummary({ text: 'Permissions & activity', in: `Flow Bot ${run}` });
    expect((await cardText(`Flow Bot ${run}`)).includes(`payee-${run}@example.com`), 'the allowed payee is not listed under Permissions & activity');
  }, { critical: true });
  await step('Agents: Edit agent opens the saved values; changing them and Save agent updates the card', async () => {
    await click({ sel: 'button', text: 'Edit agent', in: `Flow Bot ${run}` }); await waitText(`Edit Flow Bot ${run}`);
    expect((await field('Agent name')) === `Flow Bot ${run}` && (await field('Cap per action')) === '40', 'the form did not open with the saved values');
    await type('Cap per action', '55'); await type('Job description', 'Handles refunds and small payouts');
    await click({ sel: 'button', text: 'Save agent' }); await waitToast(/Agent updated/i); await waitGone({ sel: '[role=dialog]', page: true });
    const card = await cardText(`Flow Bot ${run}`); const t = await trustOf(`Flow Bot ${run}`);
    expect(t?.level === 'small' && t.amount === '55' && /small payouts/.test(card), `card did not update: ${JSON.stringify(t)}`);
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
    await openSummary({ text: 'Permissions & activity', in: `Flow Bot ${run}` });
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
// Setup that is not under test: a disposable agent and key, used to put extra requests in the approval queue the way a customer's own agent would.
async function disposableAgent(name, controls) {
  const a = await api('/api/agents', { method: 'POST', body: { name, can_refund: true, can_payout: true, max_per_action: 1, ...controls } }); expect(a.status === 200, `agent setup failed (HTTP ${a.status})`);
  const k = await api('/api/keys', { method: 'POST', body: { agent_id: a.json.id, name: `${name} key`, expires_in_days: 1 } }); expect(k.status === 200, `key setup failed (HTTP ${k.status})`);
  return { agent: a.json, key: k.json.secret, keyId: k.json.key.id };
}
const agentPost = (key, path, body, idem) => ev(`fetch(${JSON.stringify(path)}, { method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer ${key}', 'Content-Type': 'application/json', 'Idempotency-Key': ${JSON.stringify(idem)} }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))`);

const cardOf = id => `[aria-label^="Request ${id}:"]`;
const viewport = (w, h, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
const asPhone = async on => on ? viewport(390, 844, true) : viewport(1440, 900);
// The approvals page shows one request at a time; pick it from the queue (or, on a phone, with the Next button) by id.
const selectReq = async id => {
  const queued = await ev(`!!__f.one(${JSON.stringify({ sel: '.approval-queue button', re: `#${id}$` })})`);
  if (queued) await click({ sel: '.approval-queue button', re: `#${id}$` });
  else for (let i = 0; i < 12 && !(await ev(`!!document.querySelector(${JSON.stringify(`[aria-label^="Request ${id}:"]`)})`)); i++) await click({ sel: 'button', text: 'Next request' });
  await waitControl({ sel: 'button', re: '^Approve \\$', within: cardOf(id) });
};
const selectedReq = () => ev(`document.querySelector('[data-film=approval]')?.getAttribute('aria-label').match(/Request (\\d+):/)?.[1]`);
// A real key press: keydown reaches the page's listeners the way the keyboard does, and a printable key types into a focused field.
async function press(k, { ctrl = false, code } = {}) {
  const base = { key: k, code: code ?? (k.length === 1 ? 'Key' + k.toUpperCase() : k), modifiers: ctrl ? 2 : 0, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 };
  await send('Input.dispatchKeyEvent', { type: ctrl ? 'rawKeyDown' : 'keyDown', ...base, ...(ctrl ? {} : { text: k }) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }); await settle(300);
}
const ledgerRow = async id => (await stateNow()).ledger.find(e => String(e.id) === String(id));
const decided = async id => waitFor(async () => ['approved', 'declined', 'failed'].includes((await ledgerRow(id))?.status), { timeout: 90000, what: `request #${id} to be decided` });
// Setup that is not under test: a refund from the disposable agent that its $1 cap holds for the owner.
const heldRefundFor = async (fx, order, amount, tag) => {
  const r = (await agentPost(fx.key, '/v1/refunds', { capture_id: order.capture_id, amount, requester_email: order.customer_email, source_message: `Please refund $${amount} for my order.`, reason: `Partial refund ${tag}` }, `flow-${tag}-${run}`)).json;
  expect(r?.status === 'awaiting_approval', `expected a held refund, got ${r?.status}`); return r.id.replace('act_', '');
};

flow('approvals', async () => {
  await ensureDemo(); let fx, fx2, heldRefund, heldPayout; const ids = {};
  if ((await ticketOf('Daniel')).status !== 'handled') await runTicket('Daniel');
  if ((await ticketOf('Elena', 'photo')).status !== 'handled') await runTicket('Elena', "Priya's photo shoot");
  await step('Setup (not under test): put capped refunds and a capped payout from an API agent into the queue', async () => {
    fx = await disposableAgent(`Flow cap agent ${run}`, {}); const st = await stateNow(); const orders = st.orders.filter(o => o.capture_id && !o.customer_name.startsWith('Tessa')); expect(orders.length >= 3, 'the demo shop has fewer than three orders'); // Tessa's order stays untouched for the learned-rule step
    ids.key = await heldRefundFor(fx, orders[0], 3, 'k'); ids.palette = await heldRefundFor(fx, orders[1], 4, 'pal'); ids.other = await heldRefundFor(fx, orders[2 % orders.length], 5, 'o'); ids.phone = await heldRefundFor(fx, orders[0], 6, 'ph'); ids.spare = await heldRefundFor(fx, orders[1], 7, 'sp');
    heldRefund = { id: `act_${ids.other}` };
    // A $50 refund from an agent with no cap of its own waits only because the shop's $40 limit is lower: the case the learned "up to $60" suggestion covers.
    fx2 = await disposableAgent(`Flow learn agent ${run}`, { max_per_action: null });
    const refunded = o => st.ledger.filter(e => e.kind === 'refund' && e.counterparty === o.customer_email && ['executed', 'approved'].includes(e.status)).length;
    const fresh = [...orders].sort((a, b) => refunded(a) - refunded(b)); // the shop allows one refund per customer per 30 days, so start with the customer who has had none
    for (const o of fresh) { const r = (await agentPost(fx2.key, '/v1/refunds', { capture_id: o.capture_id, amount: 50, requester_email: o.customer_email, source_message: 'Please refund $50 for my order.', reason: `Larger refund ${o.customer_email}` }, `flow-ln-${o.capture_id}-${run}`)).json; if (r?.status === 'awaiting_approval') { ids.learn = r.id.replace('act_', ''); break; } }
    // $39 is inside the shop's $40 limit, so it waits only if something else (the weekly budget) holds it: the case the learned "raise the budget" suggestion covers.
    for (const o of fresh) { const r = (await agentPost(fx2.key, '/v1/refunds', { capture_id: o.capture_id, amount: 39, requester_email: o.customer_email, source_message: 'Please refund $39 for my order.', reason: `Refund inside the limit ${o.customer_email}` }, `flow-ln2-${o.capture_id}-${run}`)).json; if (r?.status === 'awaiting_approval') ids.learn2 = r.id.replace('act_', ''); if (r?.status) { if (r.status !== 'awaiting_approval') notes.push(`A $39 refund from an uncapped agent was ${r.status} (inside the limit and budget), so it did not wait for the owner.`); break; } }
    heldPayout = (await agentPost(fx.key, '/v1/payouts', { email: st.policy.policy.payouts.payees[0].email, amount: 2, reason: 'Regular shop service; hold for owner', source_message: 'Please pay $2 for shop service', requester_email: 'owner@juniperandoak.example' }, `flow-p-${run}`)).json;
    expect(heldPayout?.status === 'awaiting_approval', `expected the payout held, got ${heldPayout?.status}`);
    return `refunds #${ids.key} #${ids.palette} #${ids.other} #${ids.phone}, payout ${heldPayout.id}`;
  }, { critical: true, ok4xx: true });
  await viewport(1280, 720);
  await step('Approvals: a split view with every waiting request in the queue and one request open on the right', async () => {
    await openApp('approvals'); const rows = await held(); expect(rows.length >= 6, `only ${rows.length} held`);
    await waitControl({ sel: 'button', re: '^Approve \\$' });
    const n = await ev(`document.querySelectorAll('.approval-queue button').length`); expect(n === rows.length, `the queue lists ${n} requests but ${rows.length} are waiting`);
    expect((await ev(`document.querySelector('.approval-queue-heading h2').innerText`)).includes(String(rows.length)), 'the heading does not show the number waiting');
    expect((await ev(`document.querySelectorAll('[data-film=approval]').length`)) === 1, 'more than one request is open at once');
    const q = await ev(`(() => { const a = document.querySelector('.approval-queue').getBoundingClientRect(), b = document.querySelector('[data-film=approval]').getBoundingClientRect(); return a.right <= b.left + 1; })()`); expect(q, 'the queue is not to the left of the request');
  });
  await step('Approvals at 1280x720: all four evidence rows and the Approve button are inside the screen without scrolling', async () => {
    await openApp('approvals'); await waitControl({ sel: 'button', re: '^Approve \\$' });
    const fit = await ev(`(() => { const r = e => { const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom) }; }; const btn = document.querySelector('[data-film=approve]');
      return { y: scrollY, H: innerHeight, rows: [...document.querySelectorAll('.approval-evidence > div')].map(r), titles: [...document.querySelectorAll('.approval-evidence dt')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()), btn: btn && r(btn) }; })()`);
    expect(fit.rows.length === 4, `${fit.rows.length} evidence rows, expected 4 (${fit.titles.join(' / ')})`);
    const out = fit.rows.filter(r => r.t < 0 || r.b > fit.H); expect(!out.length, `evidence rows outside the ${fit.H}px screen: ${JSON.stringify(fit.rows)} (${fit.titles.join(' / ')})`);
    expect(fit.btn && fit.btn.t >= 0 && fit.btn.b <= fit.H, `the Approve button is at ${JSON.stringify(fit.btn)}, outside the ${fit.H}px screen`);
    return `evidence rows end at ${Math.max(...fit.rows.map(r => r.b))}px, Approve button at ${fit.btn.t}-${fit.btn.b}px of ${fit.H}px`;
  });
  await step('Approvals: choosing each queue entry opens that request with Approve and Decline', async () => {
    for (const e of await held()) { await selectReq(e.id); expect((await selectedReq()) === String(e.id), `request #${e.id} did not open`); await waitControl({ sel: 'button', text: 'Decline', within: cardOf(e.id) }); }
  });
  await step('Approvals: "Approve from your phone" opens a dialog with a QR code and a link to /approve', async () => {
    await click({ sel: 'button', text: 'Approve from your phone' }); await waitText('Scan the code');
    const info = await ev(`(() => { const img = document.querySelector('[role=dialog] img'); const a = document.querySelector('[role=dialog] a[href]'); return { src: img?.src.slice(0, 22), w: img?.naturalWidth, alt: img?.alt, path: a && new URL(a.href).pathname }; })()`);
    expect(/^data:image\/png/.test(info.src ?? '') && info.w > 50, `no QR image: ${JSON.stringify(info)}`); expect(info.path === '/approve', `link goes to ${info.path}`);
    await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
  });
  await step('Approvals: the review-checks disclosure opens and shows why it was held', async () => {
    const e = (await held())[0]; await selectReq(e.id); await openSummary({ text: 'Review checks', within: cardOf(e.id) }); await waitText(/Recorded rule outcome/);
  });
  await step('Approvals: J moves to the next request and K back; K at the top stays put', async () => {
    const order = (await held()).map(e => String(e.id)); const queue = await ev(`[...document.querySelectorAll('.approval-queue button')].map(b => b.innerText.match(/#(\\d+)/)[1])`);
    await selectReq(queue[0]); await press('k'); expect((await selectedReq()) === queue[0], 'K at the top moved away from the first request');
    await press('j'); expect((await selectedReq()) === queue[1], `J opened #${await selectedReq()}, expected #${queue[1]}`);
    await press('j'); expect((await selectedReq()) === queue[2], 'a second J did not move on');
    await press('k'); expect((await selectedReq()) === queue[1], 'K did not move back'); expect(order.length === queue.length, 'the queue changed');
  });
  await step('Approvals: pressing ? lists the keyboard shortcuts and Escape closes them', async () => {
    await press('?', { code: 'Slash' }); const t = await waitText('Approval shortcuts'); expect(/J \/ K/.test(t) && /Approve selected request/.test(t) && /Open decline dialog/.test(t), 'the shortcut list is incomplete');
    await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
    await click({ sel: 'button', text: 'Keyboard shortcuts' }); await waitText('Approval shortcuts'); await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
  });
  await step('Approvals: the shortcut keys do nothing while typing in a note field', async () => {
    const id = await selectedReq(); const before = (await held()).length; await openSummary({ text: 'Approval note', within: cardOf(id) });
    await click({ sel: 'input', text: 'Approval note (optional)', within: cardOf(id) });
    for (const ch of 'a d j k') await press(ch === ' ' ? ' ' : ch, ch === ' ' ? { code: 'Space' } : {});
    expect((await field({ sel: 'input', text: 'Approval note (optional)' })) === 'a d j k', `the note holds "${await field({ sel: 'input', text: 'Approval note (optional)' })}"`);
    expect(!(await ev(`!!document.querySelector('[role=dialog]')`)), 'a dialog opened while typing'); expect((await selectedReq()) === id, 'J/K moved the selection while typing'); expect((await held()).length === before, 'a request was decided while typing');
    await type({ sel: 'input', text: 'Approval note (optional)' }, '');
  });
  await step('Approvals: D opens the decline dialog; closing it leaves the request waiting', async () => {
    const id = await selectedReq(); await click({ sel: 'h2', text: 'Waiting for your approval', page: true }); await press('d'); await waitText('Decline this request?');
    await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true }); expect((await ledgerRow(id)).status === 'awaiting_approval', 'closing the dialog declined it');
  });
  await step('Approvals: ⌘K offers Approve and Decline for the open request; Decline opens the decline dialog', async () => {
    await press('k', { ctrl: true }); const t = await waitText('Selected request'); expect(/Approve selected request/.test(t) && /Decline selected request/.test(t), 'the palette lacks approve or decline');
    await click({ sel: '[cmdk-item]', text: 'Decline selected request' }); await waitText('Decline this request?'); await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
  });
  await step('Approvals: pressing A approves the open request and moves on to the next', async () => {
    await selectReq(ids.key); const before = (await held()).length; await click({ sel: 'h2', text: 'Waiting for your approval', page: true }); await press('a');
    await decided(ids.key); const row = await ledgerRow(ids.key); if (row.status === 'failed') notes.push(`Approving #${ids.key} with A was decided but PayPal's sandbox failed it: ${row.error}`);
    await waitFor(async () => (await selectedReq()) !== ids.key, { what: 'the next request to open' }); await waitText(new RegExp(`Request #${ids.key}: (Approved|failed)`, 'i'));
    expect((await held()).length === before - 1, 'the number waiting did not drop by one'); return `#${ids.key} ${row.status}`;
  }, { ok4xx: true });
  await step('Approvals: ⌘K > Approve selected request approves the open request', async () => {
    await selectReq(ids.palette); await press('k', { ctrl: true }); await waitText('Selected request'); await click({ sel: '[cmdk-item]', text: 'Approve selected request' });
    await decided(ids.palette); return `#${ids.palette} ${(await ledgerRow(ids.palette)).status}`;
  }, { ok4xx: true });
  await step('Inbox T7: the $52 teapot refund waits only because of the $40 limit', async () => {
    const r = await runTicket('Tessa'); const e = r.entries.find(x => x.status === 'awaiting_approval'); expect(e?.amount === 52, `expected a held $52 refund, got: ${summary(r)}`);
    const holds = (typeof e.checks === 'string' ? JSON.parse(e.checks) : e.checks).filter(c => c.outcome === 'hold').map(c => c.id); expect(holds.includes('auto_limit') && holds.every(h => ['auto_limit', 'ai_review'].includes(h)), `held by ${holds.join()}, not only the limit`); ids.tessa = e.id; return summary(r);
  });
  await step('Approvals: "Approve and stop asking about these" shows the backtest first, then approves and applies the rule', async () => {
    await openApp('approvals'); await selectReq(ids.tessa);
    await waitControl({ sel: 'button', text: 'Approve and stop asking' }, { timeout: 30000 });
    for (const id of [ids.other, heldPayout.id.replace('act_', '')]) { await selectReq(id); expect(!(await ev(`!!__f.one({ sel: 'button', text: 'Approve and stop asking' })`)), `offered on #${id}, which the change does not cover`); }
    await selectReq(ids.tessa); await waitControl({ sel: 'button', text: 'Approve and stop asking' }, { timeout: 30000 });
    const offered = { id: ids.tessa };
    const v0 = (await stateNow()).policy.id; await click({ sel: 'button', text: 'Approve and stop asking' }); await waitText('Approve and update your rules?');
    const t = await pageText(); expect(/Taps per 100 moves/.test(t) && /Declined requests that would pass/.test(t) && /Benchmark attacks stopped/.test(t), 'the backtest numbers are missing');
    await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true }); expect((await ledgerRow(offered.id)).status === 'awaiting_approval', 'closing the dialog approved it');
    await click({ sel: 'button', text: 'Approve and stop asking' }); await click({ sel: 'button', text: 'Confirm approval and rule change' }); await decided(offered.id);
    await waitFor(async () => (await stateNow()).policy.id > v0, { timeout: 30000, what: 'the rule change to create a new rules version' }); return `#${offered.id} approved and rules v${v0} -> v${(await stateNow()).policy.id}`;
  }, { ok4xx: true });
  await step('Approvals: "Approve a different amount" opens a field; a bad amount is refused; $2 of the $5 refund goes through', async () => {
    await openApp('approvals'); const id = ids.other; const card = cardOf(id); await selectReq(id);
    await click({ sel: 'button', text: 'Approve a different amount', within: card }); await type({ sel: 'input', text: 'Amount in USD', within: card }, '9');
    const pos = await locate({ sel: 'button', re: '^Confirm', within: card }, { allowDisabled: true }); expect(pos.disabled, 'Confirm should stay off for an amount above the request'); await waitText(/Enter a positive amount up to/);
    await type({ sel: 'input', text: 'Amount in USD', within: card }, '2'); await click({ sel: 'button', re: '^Confirm \\$2', within: card });
    await decided(id); const row = await ledgerRow(id); if (row.status === 'approved') expect(Number(row.approved_amount) === 2, `approved ${row.approved_amount} instead of 2`); else notes.push(`The $2 partial approval was decided as ${row.status}: ${row.error}`);
  }, { ok4xx: true });
  await step('Approvals: Decline asks for a reason, closing the dialog keeps it waiting, and Decline with a reason records exactly that reason', async () => {
    const photo = (await held()).find(e => e.amount === 180); expect(photo, 'the $180 photographer payout is not waiting'); const card = cardOf(photo.id); await selectReq(photo.id);
    await click({ sel: 'button', text: 'Decline', within: card }); await waitText('Decline this request?'); await key('Escape'); await waitGone({ sel: '[role=dialog]', page: true });
    expect((await held()).some(e => e.id === photo.id), 'closing the dialog still declined it');
    const reason = `Need the invoice first ${run}`; await click({ sel: 'button', text: 'Decline', within: card }); await type({ sel: 'textarea', text: 'Reason' }, reason);
    await click({ sel: 'button', text: 'Decline request' });
    await waitFor(async () => (await stateNow()).ledger.find(e => e.id === photo.id)?.status === 'declined', { timeout: 30000, what: 'the payout to be declined' });
    expect((await stateNow()).ledger.find(e => e.id === photo.id).decline_reason === reason, 'decline reason was not stored'); await waitText(reason);
  });
  await step('Approvals: approving a payout with "let this agent pay them for N days" creates a temporary allowance that can be revoked', async () => {
    await openApp('approvals'); const id = heldPayout.id.replace('act_', ''); const card = cardOf(id); await selectReq(id);
    await openSummary({ text: 'Approval note', within: card });
    await click({ sel: 'input[type=checkbox]', text: 'Also let this agent pay', within: card }); await type({ sel: 'input[type=number]', within: card }, '3');
    await click({ sel: 'button', re: '^Approve \\$2', within: card });
    const sent = await ev(`__a.reqs.filter(r => r.b).map(r => r.b).pop()`); expect(/allow_payee_days/.test(sent ?? ''), `the approval did not ask for an allowance: ${sent}`);
    await waitFor(async () => ['approved', 'failed'].includes((await stateNow()).ledger.find(e => String(e.id) === id)?.status), { timeout: 60000, what: 'the payout decision' });
    const g = (await api('/api/grants')).json; if (!g.length) { notes.push('The $2 payout was approved but no temporary allowance was listed (the sandbox payout may have failed).'); return 'no allowance created'; }
    await openApp('approvals'); await click({ sel: 'summary', text: 'Temporary payee allowances' }); await waitText(/Up to \$2/);
    await click({ sel: 'button', text: 'Revoke', exact: true }); await waitControl('Keep as is'); await click('Keep as is'); await waitGone({ sel: '[role=dialog]', page: true }); await waitText(/Up to \$2/);
    await click({ sel: 'button', text: 'Revoke', exact: true }); await click({ sel: 'button', text: 'Revoke allowance' }); await waitToast(/Allowance revoked/i); await waitText('No active allowances');
  }, { ok4xx: true });
  await step('Phone page: /approve opens the request from its link and Approve with a note sends it', async () => {
    const id = ids.phone; await asPhone(true); await goto(`/approve#${id}`); await waitControl({ sel: 'button', re: '^Approve \\$6', within: cardOf(id) });
    await openSummary({ text: 'Approval note', within: cardOf(id) });
    await type({ sel: 'input', text: 'Approval note', within: cardOf(id) }, `Looks right on the photos ${run}`);
    await click({ sel: 'button', re: '^Approve \\$6', within: cardOf(id) });
    await decided(id); const row = await ledgerRow(id); if (row.status === 'approved') expect(!!row.paypal_ref, 'no PayPal reference recorded'); else notes.push(`The phone approval of #${id} was decided as ${row.status}: ${row.error}`);
    await waitText(/Approved|submitted|Decision recorded|failed/i); await asPhone(false); return row.status;
  }, { ok4xx: true });
  await step('Phone page: with several waiting, Next request and Previous request move through them', async () => {
    await asPhone(true); await goto('/approve'); const first = await waitFor(selectedReq, { what: 'a request' }); const total = (await held()).length;
    if (total < 2) { await asPhone(false); return 'only one request waiting'; }
    await click({ sel: 'button', text: 'Next request' }); expect((await selectedReq()) !== first, 'Next request stayed on the same request');
    await click({ sel: 'button', text: 'Previous request' }); expect((await selectedReq()) === first, 'Previous request did not come back'); await asPhone(false);
  });
  await step('Approvals: the recent-decisions rows open the ledger entry', async () => {
    await openApp('approvals'); await click({ sel: 'a[href^="/app#ledger/"]', nth: 0 }); await waitFor(async () => /#ledger\/\d+/.test(await ev('location.hash')), { what: 'a ledger entry' });
  });
  await step('Approvals: "View ledger" link leads to the ledger', async () => {
    await openApp('approvals'); await click({ sel: 'a', text: 'View ledger' }); await waitFor(async () => (await ev('location.hash')).startsWith('#ledger'), { what: '#ledger' });
  });
  await step('Approvals: deciding the last waiting request shows "All caught up" with the taps summary', async () => {
    await openApp('approvals');
    for (let i = 0; i < 6; i++) {
      const rows = await held(); if (!rows.length) break; await selectReq(rows[0].id); const card = cardOf(rows[0].id);
      await click({ sel: 'button', text: 'Decline', within: card }); await type({ sel: 'textarea', text: 'Reason' }, 'Cleared by the button flow'); await click({ sel: 'button', text: 'Decline request' });
      await waitFor(async () => (await ledgerRow(rows[0].id)).status === 'declined', { timeout: 30000, what: 'the decline' }); await settle(600);
    }
    await waitText('All caught up'); await waitText(/taps per 100 money moves/i); await waitControl({ sel: 'a', text: 'Go to your inbox' });
  });
  if (fx) await api(`/api/keys/${encodeURIComponent(fx.keyId)}`, { method: 'DELETE' }).catch(() => {});
  if (fx2) await api(`/api/keys/${encodeURIComponent(fx2.keyId)}`, { method: 'DELETE' }).catch(() => {});
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
    const open0 = (await api('/api/incidents')).json.incidents.filter(i => !i.resolved_at).length; await click('Not me, keep agents frozen');
    await waitText(/Rotate your PayPal app/i, { timeout: 20000 }).catch(async e => { const inc = (await api('/api/incidents')).json.incidents; throw new Error(`${e.message.split('\n')[0]} (open incidents before: ${open0}; now: ${inc.map(i => `#${i.id}${i.resolved_at ? ' ' + i.resolution : ' open'}`).join(', ')}) page: ${(await pageText()).replace(/\s+/g, ' ').match(/(Money moved|Resolved PayPal)[\s\S]{0,500}/)?.[0]}`); });
    expect((await stateNow()).agents.every(a => a.status === 'frozen'), 'agents were not kept frozen');
  }, { ok4xx: true });
  await step('Agents: unfreezing each agent from its card works after an incident', async () => {
    await openApp('agents'); const frozenText = await pageText(); expect(/Incident\s+#\d+/.test(frozenText) && /PayPal transaction/.test(frozenText) && /Frozen · unaccounted paypal transaction/i.test(frozenText), `a frozen card does not name the incident and the PayPal transaction: ${frozenText.replace(/\s+/g, ' ').match(/Frozen[^.]{0,200}/)?.[0]}`);
    for (const a of (await stateNow()).agents) { await click({ sel: 'button', text: `Unfreeze ${a.name}` }); await waitControl({ sel: 'button', text: `Freeze ${a.name}` }); }
    expect((await stateNow()).agents.every(a => a.status === 'active'), 'some agent is still frozen');
  });
  await step('Watch: the incidents table lists the incidents', async () => { await openApp('watch'); await waitFor(async () => (await ev(`document.querySelectorAll('.ag-row').length`)) >= 2, { what: 'two incident rows' }); });
});

const dl = { count: 0, names: [] };
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.method === 'Browser.downloadWillBegin' || d.method === 'Page.downloadWillBegin') { dl.count++; dl.names.push(d.params.suggestedFilename); } });
flow('ledger', async () => {
  const consoleStart = consoleMsgs.length; let fxL, heldL;
  await ensureDemo();
  await step('Setup (not under test): put one request in the approval queue so the Waiting view has a row', async () => {
    fxL = await disposableAgent(`Flow ledger agent ${run}`, {}); const order = (await stateNow()).orders.find(o => o.capture_id);
    const r = await agentPost(fxL.key, '/v1/refunds', { capture_id: order.capture_id, amount: 2, requester_email: order.customer_email, source_message: 'Please refund $2 for my order.', reason: 'Ledger view check' }, `flow-l-${run}`); expect(r.json?.status === 'awaiting_approval', `expected held, got ${r.json?.status}`); heldL = r.json.id.replace('act_', '');
  }, { ok4xx: true });
  await openApp('ledger'); await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: mkdtempSync(join(tmpdir(), 'fw-flow-dl-')), eventsEnabled: true });
  await waitFor(async () => (await ev(`document.querySelectorAll('.ag-row').length`)) > 3, { what: 'ledger rows' });
  const rowCount = () => ev(`document.querySelectorAll('.ag-row').length`);
  await step('Ledger: search narrows the rows to matches and clearing it brings them back', async () => {
    const all = await rowCount(); await type('Search ledger', 'hannah.wright'); await waitFor(async () => (await rowCount()) < all, { what: 'fewer rows' });
    const t = await ev(`[...document.querySelectorAll('.ag-row')].map(r => r.innerText).join(' ')`); expect(t.includes('hannah.wright'), 'search result does not contain the match');
    await type('Search ledger', ''); await waitFor(async () => (await rowCount()) >= all, { what: 'rows back' });
  });
  await step('Ledger: the saved-view tabs (Waiting, Stopped, Done by agents) each show only their rows and All brings everything back', async () => {
    const st = (await stateNow()).ledger; const labels = { awaiting_approval: 'Waiting for you', blocked: 'Blocked before PayPal', declined: 'Declined by you', failed: 'Payment failed', executed: 'Done automatically' };
    const outcomes = () => ev(`[...document.querySelectorAll('.ag-row:not(.ag-full-width-row) [col-id="status"]')].map(c => c.innerText.replace(/\\s+/g, ' ').trim())`);
    const seen = [];
    for (const [tab, statuses] of [['Waiting', ['awaiting_approval']], ['Stopped', ['blocked', 'declined', 'failed']], ['Done by agents', ['executed']]]) {
      await click({ sel: '.ledger-views button', text: tab, exact: true }); expect((await ev(`__f.one({ sel: '.ledger-views button', text: ${JSON.stringify(tab)}, exact: true }).getAttribute('aria-pressed')`)) === 'true', `${tab} is not marked as pressed`);
      const want = st.filter(e => statuses.includes(e.status)).length; expect(tab !== 'Waiting' || want > 0, 'setup left nothing waiting'); const allowed = statuses.map(x => labels[x]);
      await waitFor(async () => { const o = await outcomes(); return want ? o.length > 0 && o.every(x => allowed.some(a => x.startsWith(a))) : o.length === 0; }, { what: `the ${tab} rows (${want} expected)`, timeout: 8000 })
        .catch(async () => { throw new Error(`${tab} shows ${JSON.stringify([...new Set(await outcomes())])}, expected only ${allowed.join(' / ')} (${want} rows)`); });
      seen.push(`${tab}: ${want}`);
    }
    await click({ sel: '.ledger-views button', text: 'All', exact: true });
    await waitFor(async () => new Set(await outcomes()).size > 1, { what: 'every outcome to come back under All' }); return seen.join(', ');
  });
  await step('Ledger: Group by Outcome groups the rows; a group opens with its chevron; None ungroups', async () => {
    await choose({ sel: 'select', text: 'Group ledger by' }, 'Outcome'); await waitFor(async () => (await ev(`document.querySelectorAll('.ag-row-group').length`)) > 0 && /approved|done automatically|blocked|declined/i.test(await ev(`[...document.querySelectorAll('.ag-row')].map(r => r.innerText).join(' ')`)), { what: 'group rows' });
    const before = await rowCount(); await click({ sel: '.ag-group-contracted', page: true, nth: 0 }); await waitFor(async () => (await rowCount()) !== before, { what: 'a group to open' });
    await choose({ sel: 'select', text: 'Group ledger by' }, 'None');
  });
  await step('Ledger: a row\'s chevron opens its decision trace and closes it again', async () => {
    const before = await rowCount(); await click({ sel: '.ag-group-contracted', page: true, nth: 0 }); await waitFor(async () => /Decision trace/i.test(await ev(`document.querySelector('.ag-full-width-row')?.innerText ?? ''`)), { what: 'the trace' });
    const trace = await ev(`document.querySelector('.ag-full-width-row')?.innerText.replace(/\\s+/g, ' ') ?? ''`); expect(/Decision trace · #\d+/.test(trace) && /Decided by/.test(trace) && /(pass|hold|block)/.test(trace), `the decision trace is missing its checks or decision: ${trace.slice(0, 200)}`);
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
  await step('Ledger: AG Grid wrote no errors or warnings to the console (the licence banner is a known missing key)', async () => {
    const bad = consoleErrorsSince(consoleStart); expect(!bad.length, bad.slice(0, 3).map(m => `${m.type}: ${m.text}`).join(' || '));
  });
  if (heldL) await api(`/api/ledger/${heldL}/decline`, { method: 'POST', body: { reason: 'Cleared by the button flow' } }).catch(() => {});
  if (fxL) await api(`/api/keys/${encodeURIComponent(fxL.keyId)}`, { method: 'DELETE' }).catch(() => {});
});



flow('rules', async () => {
  await ensureDemo(); await openApp('rules'); await waitText('Learned from your decisions');
  const version = async () => (await stateNow()).policy.id;
  const stepNow = () => ev(`[...document.querySelectorAll('nav[aria-label="Rule steps"] button')].find(b => b.getAttribute('aria-current') === 'step')?.innerText.replace(/\\s+/g, ' ').trim()`);
  await step('Rules: the page has three steps, Write, Test and Apply, and each step button moves to its section', async () => {
    const names = await ev(`[...document.querySelectorAll('nav[aria-label="Rule steps"] button')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())`);
    expect(names.length === 3 && /Write/.test(names[0]) && /Test/.test(names[1]) && /Apply/.test(names[2]), `steps are: ${names.join(' | ')}`);
    expect(/Write/.test(await stepNow()), `the first step is not marked as current (${await stepNow()})`);
    await click({ sel: 'nav[aria-label="Rule steps"] button', text: 'Apply' }); expect(/Apply/.test(await stepNow()), 'Apply is not marked as current after clicking it'); await waitText('Your rules in effect');
    const top = await ev(`Math.round(document.getElementById('rules-step-3').getBoundingClientRect().top)`); expect(top < 400, `the Apply section is ${top}px down after clicking Apply`);
    await click({ sel: 'nav[aria-label="Rule steps"] button', text: 'Write' }); expect(/Write/.test(await stepNow()), 'Write is not marked as current');
  });
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
    for (const p of ['Cautious', 'Generous', 'Standard']) {
      await click({ sel: 'button', text: p, exact: true }); seen[p] = await field({ sel: 'textarea' });
      const on = await ev(`__f.one({ sel: 'button', text: ${JSON.stringify(p)}, exact: true }).getAttribute('aria-checked') ?? __f.one({ sel: 'button', text: ${JSON.stringify(p)}, exact: true }).getAttribute('data-state')`);
      expect(on === 'true' || on === 'on', `${p} is not shown as chosen (${on})`);
    }
    expect(seen.Cautious !== seen.Generous && seen.Standard.length > 20, 'the presets did not change the text');
  });
  const rule = 'Refunds up to $30 can go through on their own. Ask me before any refund over $30. Never refund more than $120. Only pay people on my payee list.';
  let fx;
  await step('Rules: typing a rule and "Turn into rules" shows the compiled rules beside it with changes marked', async () => {
    await type({ sel: 'textarea', text: 'Plain-English rules' }, rule); await click('Turn into rules'); await waitText('Preview your rules', { timeout: 90000 });
    await waitControl('Activate'); await waitControl('Discard'); await waitControl('Watch first'); expect((await ev(`document.querySelectorAll('.c1-limit.changed').length`)) >= 1, 'no field is marked as changed against the active rules');
  });
  await step('Rules: "Test on past activity" shows what would have changed and moves to the Test step', async () => {
    await click('Test on past activity'); await waitText('Tested on your past activity', { timeout: 60000 }); expect(/Test/.test(await stepNow()), `the current step is "${await stepNow()}"`);
    await waitText('Taps per 100 money moves');
  });
  await step('Rules: Discard drops the preview and restores the active text', async () => { await click('Discard'); await waitNoText('Preview your rules'); await waitText('Active rules'); });
  await step('Rules: "Watch first" starts shadow mode: the draft is watched, the active version does not change', async () => {
    const v0 = await version(); await type({ sel: 'textarea', text: 'Plain-English rules' }, rule); await click('Turn into rules'); await waitText('Preview your rules', { timeout: 90000 });
    await click('Watch first'); await waitToast(/Watching this draft for one week/i); await waitText('Watching your draft'); await waitText('Your active rules still decide');
    expect((await version()) === v0, 'starting to watch changed the active rules'); const sh = (await api('/api/policy/shadow')).json; expect(sh.active && sh.draft, `the server does not show an active draft: ${JSON.stringify(sh).slice(0, 200)}`);
    await waitText('No requests observed yet');
  });
  await step('Rules: new requests show up in the shadow report with the live and shadow decision', async () => {
    fx = await disposableAgent(`Flow shadow agent ${run}`, {}); const st = await stateNow(); const order = st.orders.find(o => o.capture_id);
    const r = await agentPost(fx.key, '/v1/refunds', { capture_id: order.capture_id, amount: 2, requester_email: order.customer_email, source_message: 'Please refund $2 for my order.', reason: 'Small refund for the shadow report' }, `flow-shadow-${run}`);
    expect(r.json?.status === 'awaiting_approval', `expected a held refund, got ${r.json?.status}`);
    await waitFor(async () => (await api('/api/policy/shadow')).json.report.seen >= 1, { what: 'the shadow report to count the request' });
    await openApp('rules'); await waitText('Requests observed'); await waitText('Taps per 100 requests'); const t = await pageText(); expect(/Show \d+ differing requests/.test(t), 'no differing-requests disclosure');
    await click({ sel: 'summary', re: '^Show \\d+ differing requests' }); await waitText(/Live decision|No decisions differed/);
    await click({ sel: 'summary', text: 'View the watched draft' }); await waitText(/automatic approval limit/i);
    if (r.json?.id) await api(`/api/ledger/${r.json.id.replace('act_', '')}/decline`, { method: 'POST', body: { reason: 'Cleared by the button flow' } });
  }, { ok4xx: true });
  await step('Rules: Stop clears the watched draft and its report', async () => {
    await click({ sel: 'button', text: 'Stop', exact: true }); await waitToast(/Watching stopped/i); await waitNoText('Watching your draft');
    const sh = (await api('/api/policy/shadow')).json; expect(!sh.draft && !sh.active, `the server still holds a draft: ${JSON.stringify(sh).slice(0, 200)}`);
  });
  let before;
  await step('Rules: compile again, Activate makes the rules live as a new version and moves to the Apply step', async () => {
    before = JSON.stringify((await stateNow()).policy.policy); const v0 = await version(); await type({ sel: 'textarea', text: 'Plain-English rules' }, rule); await click('Turn into rules'); await waitText('Preview your rules', { timeout: 90000 });
    await click('Activate'); await waitToast(/new rules are active/i, { timeout: 30000 }); await waitFor(async () => (await version()) > v0, { what: 'a new policy version' }); expect(/Apply/.test(await stepNow()), `the current step is "${await stepNow()}"`);
  });
  await step('Rules: "Your rules in effect" shows the new version, when it took effect, who changed it, and what changed', async () => {
    const v = await version(); await waitText(new RegExp(`Active version\\s*v${v}\\b`)); const t = await pageText();
    expect(/Took effect/.test(t) && /Changed by/.test(t) && /What changed/.test(t), 'the status block is incomplete');
    const diffs = await ev(`document.querySelectorAll('.c1-differences li').length`); expect(diffs >= 1, `no field differences are listed (${t.match(/No differences[^.]*\\./)?.[0] ?? 'none'})`);
    expect(/waiting requests would decide differently/.test(t), 'no count of waiting requests that would decide differently');
  });
  await step('Rules: "Roll back" asks first, "Keep current rules" changes nothing, and confirming restores the earlier rules as a new version', async () => {
    const v0 = await version(); await click({ sel: 'button', text: 'Roll back', exact: true }); await waitText(/Roll back to v\d+\?/);
    await click('Keep current rules'); await waitGone({ sel: '[role=dialog]', page: true }); expect((await version()) === v0, 'cancelling still rolled back');
    await click({ sel: 'button', text: 'Roll back', exact: true }); await waitText(/Roll back to v\d+\?/); await click({ sel: 'button', text: 'Roll back', exact: true, within: '[role=dialog]' });
    await waitToast(/Restored rules from v\d+/i); await waitFor(async () => (await version()) > v0, { what: 'the restored version' });
    expect(JSON.stringify((await stateNow()).policy.policy) === before, 'the restored rules are not the ones that were active before'); await waitText(new RegExp(`Active version\\s*v${await version()}\\b`));
  });
  await step('Rules: Versions lists the history and "Restore" brings an older version back as a new one', async () => {
    const v0 = await version(); const n = await ev(`__f.all({ sel: 'button', text: 'Restore', exact: true }).length`); expect(n >= 1, 'no older version to restore');
    await click({ sel: 'button', text: 'Restore', exact: true, nth: 0 }); await waitToast(/Restored rules from v\d+/i); await waitFor(async () => (await version()) > v0, { what: 'the restored version to be active' });
  });
  if (fx) await api(`/api/keys/${encodeURIComponent(fx.keyId)}`, { method: 'DELETE' }).catch(() => {});
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
  await step('Demo billing: the usage meter shows the actions used this month against the demo limit', async () => {
    await openApp('settings/billing'); const u = (await api('/api/billing/usage')).json; await waitText('Actions this month'); const bar = await ev(`(() => { const b = document.querySelector('[role=progressbar][aria-label="Actions this month usage"]'); return b && { now: b.getAttribute('aria-valuenow'), max: b.getAttribute('aria-valuemax') }; })()`);
    expect(bar && Number(bar.max) === u.monthlyLimit && Number(bar.now) === Math.min(u.actionsUsed, u.monthlyLimit) && u.actionsUsed > 0, `the meter shows ${JSON.stringify(bar)} but the server says ${u.actionsUsed} of ${u.monthlyLimit}`); await openApp('settings/billing');
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



// ---- trust levels and freeze explanations (demo workspace, which has 90 days of history to preview) ----
flow('trust', async () => {
  await ensureDemo(); const name = `Flow trust agent ${run}`; let fx, order, heldId;
  const radio = (label, who = name) => ({ sel: 'input[type=radio]', text: label, in: who });
  const agentNow = async () => (await stateNow()).agents.find(a => a.id === fx.agent.id);
  const saveTrust = async () => { await click({ sel: 'button', text: 'Save trust level', in: name }); await waitToast(/Saved/); };
  await step('Setup (not under test): a disposable agent with no cap, so it starts at "Everything the rules allow"', async () => {
    fx = await disposableAgent(name, { max_per_action: null }); order = (await stateNow()).orders.find(o => o.capture_id); expect(order, 'no demo order'); expect(fx.agent.max_per_action == null, 'the new agent has a cap');
  }, { critical: true });
  await openApp('agents');
  await step('Agents: every trust level shows its own numbers for the last 90 days', async () => {
    await waitFor(async () => (await trustOf('Support agent'))?.levels.every(l => /taps \/ 100/.test(l)), { what: 'the three preview lines', timeout: 15000 });
    const t = await trustOf('Support agent'); expect(new Set(t.levels).size > 1, `all three levels show the same numbers: ${t.levels.join(' | ')}`);
  });
  await step('Agents: moving the trust control updates the preview sentence under it', async () => {
    const seen = {};
    for (const [id, label] of [['ask', 'Ask every time'], ['small', 'Small amounts on its own'], ['rules', 'Everything the rules allow']]) {
      await click(radio(label, 'Support agent')); await waitFor(async () => { const t = await trustOf('Support agent'); return t.level === id && /\d+ taps per 100/.test(t.preview); }, { what: `the ${id} preview`, timeout: 15000 }); seen[id] = (await trustOf('Support agent')).preview;
    }
    expect(seen.ask !== seen.rules, `asking every time and following the rules preview the same: ${seen.ask}`);
    const small = amount => type({ sel: 'input', text: 'Small-amount limit', in: 'Support agent' }, amount);
    await click(radio('Small amounts on its own', 'Support agent')); await small('1'); await waitFor(async () => /\d+ taps per 100/.test((await trustOf('Support agent')).preview), { what: 'the $1 preview' }); const low = (await trustOf('Support agent')).levels[1];
    await small('900'); await waitFor(async () => (await trustOf('Support agent')).levels[1] !== low, { what: 'the numbers to change with the limit', timeout: 15000 }); return `$1 limit: ${low} | $900 limit: ${(await trustOf('Support agent')).levels[1]}`;
  });
  await step('Agents: "Save trust level" is off until something changes, and a non-money limit is refused', async () => {
    await openApp('agents'); const pos = await locate({ sel: 'button', text: 'Save trust level', in: name }, { allowDisabled: true }); expect(pos.disabled, 'Save is on although nothing changed');
    await click(radio('Small amounts on its own')); await type({ sel: 'input', text: 'Small-amount limit', in: name }, '0'); await waitText('Enter a positive USD amount');
    const bad = await locate({ sel: 'button', text: 'Save trust level', in: name }, { allowDisabled: true }); expect(bad.disabled, 'Save is on for a $0 limit');
  });
  await step('Agents: saving "Ask every time" persists after a reload', async () => {
    await openApp('agents'); await click(radio('Ask every time')); await saveTrust(); await openApp('agents');
    const t = await trustOf(name); expect(t.level === 'ask', `after a reload the level is ${t.level}`); expect((await agentNow()).max_per_action === 0, `the server stored ${(await agentNow()).max_per_action}`);
  });
  await step('Agents: an agent at "Ask every time" holds even a $1 refund for the owner', async () => {
    const r = await agentPost(fx.key, '/v1/refunds', { capture_id: order.capture_id, amount: 1, requester_email: order.customer_email, source_message: 'Please refund $1 for my order.', reason: 'Tiny refund at Ask every time' }, `flow-trust-${run}`);
    expect(r.json?.status === 'awaiting_approval', `a $1 refund from an agent at Ask every time came back ${r.json?.status}`); heldId = r.json.id.replace('act_', '');
    const row = (await stateNow()).ledger.find(e => String(e.id) === heldId); expect(row.checks.some(c => /agent/.test(c.id) && c.outcome === 'hold'), `no agent-level hold among the checks: ${row.checks.map(c => c.id + ':' + c.outcome)}`);
  }, { ok4xx: true });
  await step('Agents: saving "Small amounts on its own" at $7 persists after a reload', async () => {
    await openApp('agents'); await click(radio('Small amounts on its own')); await type({ sel: 'input', text: 'Small-amount limit', in: name }, '7'); await saveTrust(); await openApp('agents');
    const t = await trustOf(name); expect(t.level === 'small' && t.amount === '7', `after a reload: ${JSON.stringify(t)}`); expect((await agentNow()).max_per_action === 7, `the server stored ${(await agentNow()).max_per_action}`);
  });
  await step('Agents: saving "Everything the rules allow" persists after a reload', async () => {
    await click(radio('Everything the rules allow')); await saveTrust(); await openApp('agents');
    const t = await trustOf(name); expect(t.level === 'rules', `after a reload the level is ${t.level}`); expect((await agentNow()).max_per_action == null, `the server stored ${(await agentNow()).max_per_action}`);
  });
  await step('Agents: a frozen agent shows who froze it, when, and what to do next; Unfreeze clears it', async () => {
    await click({ sel: 'button', text: `Freeze ${name}` }); const t = await waitText(/Frozen · owner freeze/);
    const card = await cardText(name); expect(/Changed by/.test(card) && /Frozen at/.test(card), `the card lacks who and when:\n${card.replace(/\s+/g, ' ')}`);
    const ex = (await agentNow()).freeze_explanation; expect(ex?.check === 'owner_freeze' && ex.next_step, `the server has no explanation: ${JSON.stringify(ex)}`); expect(card.includes(ex.next_step.slice(0, 30)), 'the next step is not shown on the card');
    await click({ sel: 'button', text: `Unfreeze ${name}` }); await waitControl({ sel: 'button', text: `Freeze ${name}` }); await waitFor(async () => !/Frozen · owner freeze/.test(await cardText(name)), { what: 'the explanation to go' });
    expect(!(await agentNow()).freeze_explanation, 'the server still has a freeze explanation after unfreezing');
  });
  await step('Ledger: a request blocked by a freeze shows which rule stopped it and the next step', async () => {
    await click({ sel: 'button', text: `Freeze ${name}` }); await waitControl({ sel: 'button', text: `Unfreeze ${name}` });
    const r = await agentPost(fx.key, '/v1/refunds', { capture_id: order.capture_id, amount: 1, requester_email: order.customer_email, source_message: 'Please refund $1 for my order.', reason: 'Tiny refund while frozen' }, `flow-trust-frozen-${run}`);
    expect(r.json?.status === 'blocked', `a frozen agent's request came back ${r.status} ${r.json?.status}`); const id = r.json.id.replace('act_', '');
    await goto(`/app#ledger/${id}`); await waitText(`Request #${id}`); const t = await waitText('Why it stopped'); expect(/Next step/.test(t), 'no next step for the blocked request');
    await key('Escape'); await openApp('agents'); await click({ sel: 'button', text: `Unfreeze ${name}` }); await waitControl({ sel: 'button', text: `Freeze ${name}` });
  }, { ok4xx: true });
  if (heldId) await api(`/api/ledger/${heldId}/decline`, { method: 'POST', body: { reason: 'Cleared by the button flow' } }).catch(() => {});
  if (fx) await api(`/api/keys/${encodeURIComponent(fx.keyId)}`, { method: 'DELETE' }).catch(() => {});
});


// ---- inbox: three panes, the highlighted hidden instruction, the explanation of a blocked request ----
flow('inbox', async () => {
  await ensureDemo(); await viewport(1440, 900);
  await step('Setup (not under test): Jordan\'s injected email has been handled by the agent', async () => {
    if ((await ticketOf('Jordan')).status !== 'handled') await runTicket('Jordan');
  }, { ok4xx: true });
  await step('Inbox: three panes side by side: the requests, the message, and what the agent did', async () => {
    await openApp('inbox');
    const p = await ev(`(() => { const q = s => document.querySelector(s)?.getBoundingClientRect(); const o = r => r && { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) };
      return [o(q('.inbox-layout > [data-slot=card]:first-child')), o(q('section[aria-label="The message"]')), o(q('section[aria-label="What the agent did"]'))]; })()`);
    expect(p.every(Boolean), `a pane is missing: ${JSON.stringify(p)}`); expect(p[0].r <= p[1].l + 1 && p[1].r <= p[2].l + 1, `the panes are not left to right: ${JSON.stringify(p)}`); expect(p.every(x => x.w > 180), `a pane is too narrow: ${JSON.stringify(p)}`);
    return JSON.stringify(p.map(x => x.w));
  });
  await step('Inbox: Jordan\'s email shows the hidden instruction the AI review quoted, highlighted', async () => {
    await click({ sel: 'button.item', text: 'Jordan' }); await waitText('AI review flagged hidden instructions');
    const marks = await ev(`[...document.querySelectorAll('section[aria-label="The message"] mark')].map(m => m.innerText)`); expect(marks.length >= 1, `nothing is highlighted: ${(await ev(`document.querySelector('.message-warning')?.innerText`))}`);
    expect(marks.some(m => m.length > 8), `the highlight is too short to be an instruction: ${JSON.stringify(marks)}`); return `highlighted: "${marks[0].slice(0, 80)}"`;
  });
  await step('Inbox: a blocked request shows which rule stopped it, the evidence and the next step', async () => {
    const t = await ticketOf('Jordan'); const st = await stateNow(); const blocked = st.ledger.filter(e => e.ticket_id === t.id && e.status === 'blocked');
    if (!blocked.length) { notes.push(`Jordan's request produced no blocked ledger row in this run (${st.ledger.filter(e => e.ticket_id === t.id).map(e => e.status).join(', ') || 'no payment request'}), so the block explanation in the inbox was not shown; the freeze-block explanation is covered in the trust flow.`); return 'no blocked row for Jordan this run'; }
    const pane = 'section[aria-label="What the agent did"]'; const text = await ev(`document.querySelector(${JSON.stringify(pane)}).innerText`);
    expect(/Why it stopped/.test(text) && /Next step/.test(text), `no explanation among: ${text.replace(/\\s+/g, ' ').slice(0, 300)}`);
  });
  await step('Inbox: Maya\'s ticket still shows her message beside what the agent did', async () => { await click({ sel: 'button.item', text: 'Maya' }); await waitText(/chipped/i); await waitText('What the agent did'); });
});

// ---- landing: the decision stream and the legal pages ----
flow('landing', async () => {
  await resetBrowser(); await viewport(1440, 900);
  const stream = () => ev(`document.querySelector('.decision-stream')?.innerText.replace(/\\s+/g, ' ')`);
  await step('Landing: the decision stream plays by itself', async () => {
    await goto('/'); await waitFor(async () => !!(await stream()), { what: 'the stream' }); const a = await stream(); await sleep(3500); const b = await stream(); expect(a !== b, `the stream did not move in 3.5s: ${a?.slice(0, 120)}`);
  });
  await step('Landing: Pause stops the stream, the label becomes Play, and Play resumes it', async () => {
    await click('Pause demo stream'); await waitControl({ sel: 'button', text: 'Play demo stream' }); const a = await stream(); await sleep(2500); expect((await stream()) === a, 'the stream kept moving while paused');
    await click('Play demo stream'); await waitControl({ sel: 'button', text: 'Pause demo stream' }); await sleep(2500); expect((await stream()) !== a, 'the stream did not resume');
  });
  for (const [who, full, outcome] of [['Maya', 'Maya Chen', 'Executed'], ['Daniel', 'Daniel Okafor', 'Held for the owner'], ['Jordan', 'Jordan Blake', 'Blocked']]) {
    await step(`Landing: the ${who} button shows ${full}'s request and its outcome "${outcome}"`, async () => {
      await click({ sel: 'nav[aria-label="Recorded requests"] button', text: who });
      expect((await ev(`__f.one({ sel: 'nav[aria-label="Recorded requests"] button', text: ${JSON.stringify(who)} }).getAttribute('aria-pressed')`)) === 'true', `${who} is not marked as pressed`);
      const t = await stream(); expect(t.includes(full), `the stream shows someone else: ${t.slice(0, 120)}`); expect(t.includes(outcome), `no "${outcome}" in: ${t.slice(0, 200)}`);
    });
  }
  await step('Landing: the footer Privacy link opens /privacy, and a hard reload keeps the page', async () => {
    await goto('/'); await click({ sel: 'footer a', text: 'Privacy' }); await waitFor(async () => (await ev('location.pathname')) === '/privacy', { what: '/privacy' });
    await waitText('What is stored'); await send('Page.reload'); await sleep(600); await waitFor(async () => !navigating && (await ev(`document.readyState`)) === 'complete', { what: 'the reload' });
    expect((await ev('location.pathname')) === '/privacy', 'a reload left /privacy'); await waitText('Where data goes'); expect((await ev(`document.querySelector('h1')?.innerText`)) === 'Privacy', 'the page title is not Privacy');
  });
  await step('Landing: the footer Terms link opens /terms, and a hard reload keeps the page', async () => {
    await goto('/'); await click({ sel: 'footer a', text: 'Terms' }); await waitFor(async () => (await ev('location.pathname')) === '/terms', { what: '/terms' });
    await waitText('What an approval does'); await send('Page.reload'); await sleep(600); await waitFor(async () => !navigating && (await ev(`document.readyState`)) === 'complete', { what: 'the reload' });
    expect((await ev('location.pathname')) === '/terms', 'a reload left /terms'); await waitText('Plans and availability'); expect((await ev(`document.querySelector('h1')?.innerText`)) === 'Terms of use', 'the page title is not Terms of use');
  });
  await step('Legal pages: typing the address straight in loads each page, and their links lead back', async () => {
    await goto('/privacy'); await waitText('What is stored'); await click({ sel: 'footer a', text: 'Terms' }); await waitFor(async () => (await ev('location.pathname')) === '/terms', { what: '/terms' });
    await click({ sel: 'footer a', text: 'Privacy' }); await waitFor(async () => (await ev('location.pathname')) === '/privacy', { what: '/privacy' });
    await click({ sel: 'footer a', text: 'Home' }); await waitFor(async () => (await ev('location.pathname')) === '/', { what: 'the home page' });
    await goto('/'); await openSummary({ text: 'Who receives my data?' }); await click({ sel: 'a', text: 'Read the privacy notice' }); await waitFor(async () => (await ev('location.pathname')) === '/privacy', { what: '/privacy from the FAQ' });
  });
});

// ---- phone width: no sideways scrolling, and the Approve button is on screen ----
flow('mobile', async () => {
  await ensureDemo(); let fx; const held375 = [];
  const overflow = () => ev(`(() => { const iw = screen.width, wide = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > iw + 1 && !e.closest('.ag-root-wrapper, [data-sonner-toaster], .benchmark-scroll, .c1-table-scroll, [data-radix-popper-content-wrapper]') && getComputedStyle(e).position !== 'fixed'; }).slice(0, 4).map(e => e.tagName.toLowerCase() + '.' + String(e.className).slice(0, 40));
    return { iw, sw: document.documentElement.scrollWidth, wide }; })()`);
  const fits = async what => { const o = await overflow(); expect(o.sw <= o.iw, `${what} scrolls sideways: page is ${o.sw}px wide on a ${o.iw}px screen (wide: ${o.wide.join(', ')})`); return `${o.sw}px of ${o.iw}px`; };
  await step('Setup (not under test): put a request in the approval queue', async () => {
    fx = await disposableAgent(`Flow phone agent ${run}`, {}); const order = (await stateNow()).orders.find(o => o.capture_id);
    const r = await agentPost(fx.key, '/v1/refunds', { capture_id: order.capture_id, amount: 4, requester_email: order.customer_email, source_message: 'Please refund $4 for my order.', reason: 'Phone layout check' }, `flow-m-${run}`); expect(r.json?.status === 'awaiting_approval', `expected held, got ${r.json?.status}`); held375.push(r.json.id.replace('act_', ''));
  }, { ok4xx: true });
  await viewport(375, 812, true);
  await step('375px wide: the landing page does not scroll sideways', async () => { await goto('/'); await waitText('Every refund checked'); return fits('the landing page'); });
  await step('375px wide: /approve does not scroll sideways and the Approve button is on screen', async () => {
    await goto('/approve'); await waitControl({ sel: 'button', re: '^Approve \\$' }); const note = await fits('/approve');
    const r = await ev(`(() => { const b = document.querySelector('[data-film=approve]').getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), H: innerHeight, W: innerWidth }; })()`);
    expect(r.t >= 0 && r.b <= r.H && r.l >= 0 && r.r <= r.W, `the Approve button is at ${JSON.stringify(r)}`); return `${note}; button ${r.t}-${r.b}px of ${r.H}px`;
  });
  await step('375px wide: with the decision details opened, /approve still does not scroll sideways', async () => {
    const id = await selectedReq(); await openSummary({ text: 'Review checks', within: cardOf(id) }); await openSummary({ text: 'Approval note', within: cardOf(id) }); await sleep(300); return fits('/approve with the details open');
  });
  for (const page of ['overview', 'rules', 'agents', 'inbox', 'approvals']) {
    await step(`375px wide: ${page} does not scroll sideways`, async () => { await openApp(page); await sleep(800); return fits(page); });
  }
  await viewport(1440, 900);
  for (const id of held375) await api(`/api/ledger/${id}/decline`, { method: 'POST', body: { reason: 'Cleared by the button flow' } }).catch(() => {});
  if (fx) await api(`/api/keys/${encodeURIComponent(fx.keyId)}`, { method: 'DELETE' }).catch(() => {});
});

// ---- console errors on every page ----
flow('pages', async () => {
  await ensureDemo(); await viewport(1440, 900);
  const visit = (name, path, after) => step(`Console: ${name} loads without console errors`, async () => {
    const n = consoleMsgs.length; await (path.startsWith('/app#') ? openApp(path.slice(5)) : goto(path)); await sleep(1500); if (after) await after();
    const errs = consoleErrorsSince(n); expect(!errs.length, errs.slice(0, 3).map(m => `${m.type}: ${m.text}`).join(' || '));
  });
  for (const [name, path] of [['landing', '/'], ['sign-in', '/signin'], ['sign-up', '/signup'], ['privacy', '/privacy'], ['terms', '/terms']]) await visit(name, path);
  await visit('phone approvals', '/approve');
  for (const page of ['overview', 'inbox', 'approvals', 'agents', 'rules', 'ledger', 'watch', 'setup', 'developers', 'developers/webhooks', 'audit', 'settings/general', 'settings/paypal', 'settings/team', 'settings/notifications', 'settings/billing', 'settings/security'])
    await visit(page, `/app#${page}`, page === 'ledger' ? async () => { await waitFor(async () => (await ev(`document.querySelectorAll('.ag-row').length`)) > 0, { what: 'ledger rows' }); await sleep(1000); } : undefined);
  await step('Overview: the first screen says what needs the owner now and shows the interruption count', async () => {
    await openApp('overview'); const t = await pageText(); expect(/What needs you now/.test(t), 'no "What needs you now" section'); expect(/taps per 100/i.test(t), 'no taps-per-100 interruption figure on the overview');
  });
});

//FLOWS-GO-HERE

// ---------- run ----------
const ORDER = ['account', 'settings', 'agents', 'developers', 'setup', 'workspaces', 'roles', 'demo', 'approvals', 'trust', 'hijack', 'watch', 'demo-agents', 'ledger', 'rules', 'inbox', 'demo-billing', 'landing', 'mobile', 'pages'];
flows.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
for (const [name, fn] of flows) {
  if (ONLY && !ONLY.includes(name)) continue;
  current = name; abort = false;
  console.log(`\n=== ${name}`);
  try { await fn(); } catch (e) { rows.push({ flow: name, name: '(flow crashed)', result: 'FAIL', note: clean(e.message) }); console.log(`FAIL  ${name} | flow crashed | ${clean(e.message).split('\n')[0]}`); }
}
{ const seen = [...new Map(consoleErrorsSince(0).map(m => [`${m.where}|${m.text}`, m])).values()];
  notes.push(seen.length ? `Console errors and warnings seen during the run (the AG Grid licence banner is ignored): ${seen.slice(0, 8).map(m => `${m.where || '/'}: ${m.type} ${m.text.slice(0, 120)}`).join(' // ')}` : 'No console errors or warnings on any page visited (the AG Grid licence banner, a known missing key, is ignored).'); }
const pass = rows.filter(r => r.result === 'PASS').length, fail = rows.filter(r => r.result === 'FAIL').length, skip = rows.filter(r => r.result === 'SKIP').length;
const md = [`# Button flows: results`, '', `Run ${new Date().toISOString().slice(0, 10)} against ${BASE} (a throwaway local server, PayPal sandbox). **${pass} passed, ${fail} failed, ${skip} skipped.**`, '',
  'Each step is a real mouse click or real typing in headless Chrome, followed by a check of what the page shows. `node tests/button-flows.mjs` reruns it.', '',
  ...[...new Set(rows.map(r => r.flow))].flatMap(f => ['', `## ${f}`, '', '| Result | Step | Note |', '|---|---|---|', ...rows.filter(r => r.flow === f).map(r => `| ${r.result} | ${r.name.replace(/\|/g, '/')} | ${(r.note ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 220)} |`)]),
  ...(notes.length ? ['', '## Notes', '', ...notes.map(n => `- ${clean(n)}`)] : []), ''].join('\n');
// A partial run (FLOWS=...) must not overwrite the full report.
const outName = ONLY ? 'button-flows-RESULTS.partial.md' : 'button-flows-RESULTS.md';
writeFileSync(new URL(`./${outName}`, import.meta.url), md);
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped. Wrote tests/${outName}`);
if (process.env.FLOW_COOKIES) { const jar = (await send('Network.getAllCookies')).cookies ?? []; if (jar.length) writeFileSync(process.env.FLOW_COOKIES, JSON.stringify(jar)); }
process.exit(fail ? 1 : 0);
