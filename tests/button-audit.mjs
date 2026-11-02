// Clicks every button, link, tab and switch on every page with a real mouse in a real browser, one fresh page load per click, and records what happened.
//   node tests/button-audit.mjs <base URL> demo|account [page,page]   ->  tests/results/button-audit-<mode>-<first page>.json
// An element counts as working if the click navigated, sent a request, started a download, opened a window or changed the page.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:18999', MODE = process.argv[3] ?? 'demo', ONLY = process.argv[4]?.split(','), DEBUG = 9400 + Math.floor(Math.random() * 500);
const SHELL = process.env.CHROME_SHELL || '/Users/hudsonyu/Documents/Codex/2026-09-28/referenced-chatgpt-conversation-this-is-an-4/work/ai4s-v2/.pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(SHELL, [`--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'fw-audit-'))}`, '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());
let targets; for (let i = 0; i < 60 && !targets?.length; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json(); } catch {} await sleep(200); }
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const wait = new Map(); let downloads = 0; const consoleErrors = [];
ws.addEventListener('message', m => {
  const d = JSON.parse(m.data);
  if (wait.has(d.id)) { wait.get(d.id)(d.result ?? {}); wait.delete(d.id); }
  if (d.method === 'Page.downloadWillBegin' || d.method === 'Browser.downloadWillBegin') downloads++;
  if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails.exception?.description?.split('\n')[0] ?? d.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise(r => { wait.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: mkdtempSync(join(tmpdir(), 'fw-dl-')), eventsEnabled: true }).catch(() => {});
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__a = { reqs: [], open: 0, inflight: 0 };
  const f = window.fetch; window.fetch = async (...x) => { const u = String(x[0]?.url ?? x[0]), m = x[1]?.method ?? 'GET'; const r = { u, m, s: 0 }; if (m !== 'GET' || !/\\/api\\/(state|assistant\\/status|auth\\/get-session)/.test(u)) __a.reqs.push(r); __a.inflight++; try { const res = await f(...x); r.s = res.status; return res; } catch (e) { r.s = -1; throw e; } finally { __a.inflight--; } };
  window.open = (...x) => { __a.open++; return null; };
  const c = navigator.clipboard; if (c) c.writeText = async () => { __a.copied = true; };
  window.confirm = () => { __a.confirm = true; return true; };
  window.alert = () => { __a.alert = true; };
` });

const SELECT = 'button, a[href], [role=button], [role=tab], [role=switch], [role=menuitem], [role=menuitemradio], [role=checkbox], [role=combobox], summary, select, input[type=checkbox]';
const LIST = scope => `(() => {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)}) || document` : 'document'}, seen = {};
  return [...root.querySelectorAll(${JSON.stringify(SELECT)})].filter(e => { if (e.closest('.ag-charts-wrapper, [class*=ag-charts-]')) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }).map(e => {
    const label = (e.getAttribute('aria-label') || e.innerText || e.title || e.value || e.name || e.className.toString().slice(0, 30) || '').replace(/\\s+/g, ' ').trim().slice(0, 70);
    const k = e.tagName + '|' + label; seen[k] = (seen[k] ?? 0) + 1;
    return { key: k, n: seen[k] - 1, label, shell: !!e.closest('[data-slot=sidebar], header, .site-nav, .assistant-launcher'), tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), href: e.tagName === 'A' ? e.href : null, disabled: e.disabled || e.getAttribute('aria-disabled') === 'true', blank: e.target === '_blank' };
  });
})()`;
const FIND = (it, scope) => `(() => { const root = ${scope ? `document.querySelector(${JSON.stringify(scope)}) || document` : 'document'}; let c = 0; for (const e of root.querySelectorAll(${JSON.stringify(SELECT)})) { if (e.closest('.ag-charts-wrapper, [class*=ag-charts-]')) continue; const r0 = e.getBoundingClientRect(), s = getComputedStyle(e); if (!(r0.width > 0 && r0.height > 0 && s.visibility !== 'hidden' && s.display !== 'none')) continue; const label = (e.getAttribute('aria-label') || e.innerText || e.title || e.value || e.name || e.className.toString().slice(0, 30) || '').replace(/\\s+/g, ' ').trim().slice(0, 70); if (e.tagName + '|' + label !== ${JSON.stringify(it.key)}) continue; if (c++ !== ${it.n}) continue; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { x: r.left + r.width / 2, y: r.top + r.height / 2, covered: !!top && top !== e && !e.contains(top) && !top.contains(e) ? (top.innerText || top.className.toString()).slice(0, 40) : null }; } return null; })()`;
const SNAP = `(() => { const h = document.body.cloneNode(true); h.querySelectorAll('canvas,style,script').forEach(x => x.remove()); return { url: location.href, html: h.innerHTML.replace(/\\d+ (second|minute)s? ago|just now/g, ''), cls: document.documentElement.className }; })()`;
const OPEN = `(() => { const d = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=menu],[role=listbox]')].filter(e => e.getBoundingClientRect().width > 0); return d.length ? (d.at(-1).id ? '#' + CSS.escape(d.at(-1).id) : '[role=' + d.at(-1).getAttribute('role') + ']') : null; })()`;
let loads = 0;
async function load(url) {
  // A fresh query string forces a real reload (a hash-only change would keep open dialogs and state).
  const u = new URL(url); u.searchParams.set('audit', String(++loads));
  await send('Page.navigate', { url: u.href });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`document.readyState === 'complete' && document.body.innerText.length > 40`)) break; }
  await sleep(1300);
}
async function click(pos) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
}
const rows = [];
const record = (page, it, result, note = '') => { rows.push({ page, label: it.label || `(${it.tag})`, tag: it.tag, result, note: String(note).slice(0, 160) }); console.log(`${result.padEnd(9)} ${page} | ${it.label} | ${String(note).slice(0, 120)}`); };

// One click on a freshly loaded page; `before` re-creates anything that must be open first (a dialog or menu).
async function tryOne(page, url, it, scope, before) {
  if (it.disabled) return record(page, it, 'DISABLED');
  await load(url);
  if (before) { const p = await ev(FIND(before)); if (!p) return record(page, it, 'NOT-FOUND', 'opener vanished'); await click(p); await sleep(700); }
  const pos = await ev(FIND(it, scope));
  if (!pos) return record(page, it, 'NOT-FOUND', 'not there after reload');
  if (pos.covered) record(page, it, 'COVERED', `under: ${pos.covered}`);
  const a = await ev(SNAP); const dl0 = downloads, err0 = consoleErrors.length;
  await ev('__a.reqs.length = 0; __a.open = 0; __a.copied = false; __a.confirm = false; true');
  await sleep(80);
  const again = await ev(FIND(it, scope));
  await click(again ?? pos);
  for (let i = 0; i < 12; i++) { await sleep(250); if (await ev('location.href') !== a.url) break; }
  for (let i = 0; i < 80 && (await ev('window.__a?.inflight ?? 0')) > 0; i++) await sleep(250);
  await sleep(400);
  const b = await ev(SNAP) ?? a;
  const st = await ev('window.__a ? { reqs: __a.reqs, open: __a.open, copied: __a.copied, confirm: __a.confirm } : { reqs: [] }');
  // Status 0 / -1 with a navigation is the browser cancelling a request as the page changed.
  const bad = (st?.reqs ?? []).filter(r => r.s >= 400 || (r.s === -1 && b.url === a.url));
  const toast = await ev(`[...document.querySelectorAll('[data-sonner-toast],[role=alert],[role=status]')].map(e => e.innerText).join(' | ').slice(0, 120)`);
  const effects = [b.url !== a.url && 'nav', st?.reqs?.length && `req ${st.reqs.map(r => `${r.m} ${r.u.replace(BASE, '').split('?')[0]} ${r.s}`).join(', ')}`, downloads > dl0 && 'download', st?.open && 'window.open', st?.copied && 'copied', b.html !== a.html && 'dom', b.cls !== a.cls && 'class'].filter(Boolean);
  const errs = consoleErrors.slice(err0);
  if (errs.length) record(page, it, 'JS-ERROR', errs[0]);
  if (bad.length) record(page, it, 'HTTP-ERR', `${bad.map(r => `${r.m} ${r.u.replace(BASE, '')} ${r.s}`).join(', ')} ${toast}`);
  else if (!effects.length) record(page, it, 'DEAD', 'nothing changed');
  else record(page, it, 'OK', effects.join('; '));
  return await ev(OPEN);
}

await load(`${BASE}/`);
const creds = MODE === 'account' ? `fetch('/api/auth/sign-up/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Audit Owner', email: 'audit-${Date.now()}@example.com', password: '${randomBytes(12).toString('hex')}' }) }).then(r => r.status)` : `fetch('/api/auth/sign-in/anonymous', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status)`;
console.log('sign in', await ev(creds));
for (let i = 0; i < 90; i++) { const s = await ev(`fetch('/api/state').then(r => r.json()).then(s => s.workspace?.seedStatus ?? 'none')`); if (s === 'ready' || (MODE === 'account' && s === 'none') || MODE === 'account') break; await sleep(1000); }

const app = ['overview', 'inbox', 'approvals', 'agents', 'rules', 'ledger', 'watch', 'setup', 'developers', 'audit', 'settings'];
const PAGES = [['landing', `${BASE}/`], ...app.map(p => [p, `${BASE}/app#${p}`]), ['phone', `${BASE}/approve`], ['signin', `${BASE}/signin`], ['signup', `${BASE}/signup`]].filter(([p]) => !ONLY || ONLY.includes(p));
const done = new Set(), external = new Map();
const LAST = /sign out|log out|delete workspace|delete account/i;
const later = [];
for (const [page, url] of PAGES) {
  await load(url);
  const items = await ev(LIST());
  console.log(`--- ${page}: ${items?.length ?? 0} elements`);
  for (const it of items ?? []) {
    const shared = `${it.key}|${it.href ?? ''}|${it.n}`;
    // The shell (sidebar, top bar) repeats on every page: once is enough.
    if (it.shell && done.has(shared)) continue;
    if (it.shell) done.add(shared);
    if (it.href && new URL(it.href).origin !== new URL(BASE).origin) {
      if (!external.has(it.href)) { const s = await fetch(it.href, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15000) }).then(r => r.status).catch(e => `fail ${e.message}`); external.set(it.href, s); }
      record(page, it, /^[23]/.test(String(external.get(it.href))) ? 'OK' : 'LINK-ERR', `${it.href} -> ${external.get(it.href)}`);
      continue;
    }
    if (LAST.test(it.label)) { later.push([page, url, it]); continue; }
    const opened = await tryOne(page, url, it);
    // Whatever the click opened (a dialog or a menu) is tested too, one click per item.
    if (opened) {
      const inner = await ev(LIST(opened));
      for (const sub of inner ?? []) {
        if (LAST.test(sub.label)) { later.push([page, url, sub, opened, it]); continue; }
        await tryOne(`${page} > ${it.label.slice(0, 24)}`, url, sub, opened, it);
      }
    }
  }
}
for (const [page, url, it, scope, before] of later) if (!scope) await tryOne(page, url, it, scope, before);
const count = {}; rows.forEach(r => { count[r.result] = (count[r.result] ?? 0) + 1; });
mkdirSync('tests/results', { recursive: true });
writeFileSync(`tests/results/button-audit-${MODE}-${ONLY?.[0] ?? 'all'}.json`, JSON.stringify({ base: BASE, mode: MODE, rows }, null, 0));
console.log('DONE', JSON.stringify(count));
process.exit(0);
