// Films Allowance frame by frame in headless Chromium: the art cards (film/art) and the real web app (dist/web).
//   npm run build && node film/director.mjs [--only=scene,scene] [--every=N]  ->  film/work/frames/00000.jpg ... + events.json
//
// Nothing in the UI is mocked. The app's API calls are answered from one recorded live run against the PayPal sandbox
// (film/data/run.json, see record.mjs and shim.js), released on the film clock. The film adds only a camera, a drawn
// cursor, captions and highlight rings (ui.js).
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHELL = process.env.CHROME_SHELL || '/Users/hudsonyu/Documents/Codex/2026-09-28/referenced-chatgpt-conversation-this-is-an-4/work/ai4s-v2/.pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const PORT = 3190, DEBUG = 9352, FPS = 30, VW = 1440, VH = 810, DSF = 2;
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const ONLY = arg('only')?.split(',');
const EVERY = Number(arg('every') || 1);
const PATCH = process.argv.includes('--patch');   // with --only: re-render those scenes in place in work/frames
const wait = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const timeline = JSON.parse(readFileSync(join(HERE, 'work/timeline.json'), 'utf8'));
const run = JSON.parse(readFileSync(join(HERE, 'data/run.json'), 'utf8'));
const stepOf = id => run.steps.find(s => s.id === id) ?? (() => { throw new Error(`no recorded step ${id}`); })();
const framesDir = join(HERE, ONLY && !PATCH ? 'work/preview' : 'work/frames');
if (!PATCH) rmSync(framesDir, { recursive: true, force: true });
const frameOffset = id => { let n = 0; for (const sc of timeline.scenes) { if (sc.id === id) break; n += Math.round((sc.end - sc.start) * FPS); } return n; };
mkdirSync(framesDir, { recursive: true });

// ---------------------------------------------------------------- servers and browser
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.startsWith('/film/') ? join(HERE, path.slice(6)) : join(ROOT, 'dist/web', path === '/' ? 'index.html' : path);
  // The app routes /app and /approve on the client, like the real server's catch-all.
  if (!path.startsWith('/film/') && !path.includes('.') && !existsSync(file)) file = join(ROOT, 'dist/web/index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1');
const chrome = spawn(SHELL, [`--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'allowance-film-'))}`, '--window-size=1920,1080', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { chrome.kill(); server.close(); });

async function until(fn, what, tries = 160) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await wait(250); }
  throw new Error(`timed out waiting for ${what}`);
}
const wsUrl = await until(async () => (await (await fetch(`http://127.0.0.1:${DEBUG}/json`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl, 'Chromium');
const ws = new WebSocket(wsUrl);
await new Promise(r => { ws.onopen = r; });
let nextId = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') console.error('PAGE ERROR:', m.params.exceptionDetails.exception?.description?.split('\n')[0]);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const js = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text}\n in: ${expression.slice(0, 200)}`);
  return r.result.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setLocaleOverride', { locale: 'en-US' });
await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (!location.pathname.startsWith('/film/')) { ${readFileSync(join(HERE, 'shim.js'), 'utf8')} }` });
const UI = readFileSync(join(HERE, 'ui.js'), 'utf8');

// ---------------------------------------------------------------- capture
let frameNo = 0, mode = null;
const events = [];
let cam = { x: 0, y: 0, w: VW };
async function setMode(m) {
  if (mode === m) return;
  mode = m;
  await send('Emulation.setDeviceMetricsOverride', m === 'app' ? { width: VW, height: VH, deviceScaleFactor: DSF, mobile: false } : { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
}
async function capture() {
  const scrollY = await js('window.scrollY');
  const clip = mode === 'app'
    ? { x: cam.x, y: cam.y + scrollY, width: cam.w, height: (cam.w * 9) / 16, scale: 1920 / (cam.w * DSF) }
    : { x: 0, y: 0, width: 1920, height: 1080, scale: 1 };
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip });
  writeFileSync(join(framesDir, `${String(frameNo).padStart(5, '0')}.jpg`), Buffer.from(r.data, 'base64'));
  frameNo++;
}
async function open(url, ready) {
  await send('Page.navigate', { url });
  await until(() => js(`document.readyState === 'complete' && (${ready})`), url);
  await js('document.fonts.ready.then(() => true)');
  await js(UI);
}
const captionAt = (sc, t) => {
  const line = sc.lines.find(l => t >= l.start - sc.start - 0.12 && t <= l.end - sc.start + 0.4);
  if (!line) return { text: '', a: 0 };
  const a = Math.min(1, (t - (line.start - sc.start - 0.12)) / 0.18, (line.end - sc.start + 0.4 - t) / 0.2);
  return { text: line.text, a: Math.max(0, a) };
};
const lineAt = (sc, id, end = false) => { const l = sc.lines.find(x => x.id === id); return (end ? l.end : l.start) - sc.start; };

// ---------------------------------------------------------------- art scenes
async function artScene(sc) {
  await setMode('art');
  cam = { x: 0, y: 0, w: 1920 };
  await open(`http://127.0.0.1:${PORT}/film/${sc.page}`, 'window.ready === true');
  const rel = Object.fromEntries(sc.lines.map(l => [l.id, [l.start - sc.start, l.end - sc.start]]));
  await js(`window.LINES = ${JSON.stringify(rel)}; film.setCam(0, 0, 1920); true`);
  const n = Math.round((sc.end - sc.start) * FPS);
  for (let f = 0; f < n; f++) {
    if (f % EVERY) continue;
    const t = f / FPS, c = captionAt(sc, t);
    await js(`render(${t}); film.caption(${JSON.stringify(c.text)}, ${c.a}); film.frame(${sc.start + t}); true`);
    await capture();
  }
}

// ---------------------------------------------------------------- app scenes
// A scene is a list of beats on the scene clock: do(at, fn) runs once, span(at, dur, fn(p)) runs every frame in its window.
function beats() {
  const list = [];
  return { list, do: (at, fn) => list.push({ at, dur: 0, fn }), span: (at, dur, fn) => list.push({ at, dur, fn }) };
}
const rect = async spec => { for (let i = 0; i < 40; i++) { const r = await js(`film.rect(${JSON.stringify(spec)})`); if (r) return r; await wait(100); } return null; };
function fit(r, { pad = 40, minW = 720, ay = 0.45 } = {}) {
  if (!r) return { ...cam };
  const w = clamp(Math.max(r.w + 2 * pad, ((r.h + 2 * pad) * 16) / 9, minW), 640, VW), h = (w * 9) / 16;
  return { x: clamp(r.x + r.w / 2 - w / 2, 0, VW - w), y: clamp(r.y + r.h / 2 - h * ay, 0, VH - h), w };
}
const WIDE = { x: 0, y: 0, w: VW };
function camTo(B, at, dur, target) {
  let from, to;
  B.span(at, dur, async p => {
    if (!from) { from = { ...cam }; to = typeof target === 'function' ? await target() : target; }
    const e = ease(p);
    cam = { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e), w: lerp(from.w, to.w, e) };
  });
}
let cursor = { x: VW * 0.6, y: VH * 0.6, show: false };
function cursorTo(B, at, dur, spec) {
  let from, to;
  B.span(at, dur, async p => {
    if (!from) { from = { ...cursor }; const r = await rect(spec); to = r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : from; }
    const e = ease(p), lift = Math.sin(Math.PI * e) * Math.min(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.1);
    cursor = { x: lerp(from.x, to.x, e), y: lerp(from.y, to.y, e) - lift, show: true };
  });
}
// Moves the drawn cursor to the element, then clicks it for real (the app handles a genuine mouse event).
function click(B, at, spec, sceneStart) {
  // An off-screen target is scrolled into view first, the way a person would.
  let from, to;
  B.span(at - 1.3, 0.5, async p => {
    if (from === undefined) {
      from = await js('window.scrollY');
      to = from;
      const r = await rect(spec);
      if (r && (r.y < 70 || r.y + r.h > VH - 40)) to = clamp(from + r.y + r.h / 2 - VH * 0.5, 0, await js('document.documentElement.scrollHeight - innerHeight'));
    }
    if (to !== from) await js(`window.scrollTo(0, ${lerp(from, to, ease(p))}); true`);
  });
  cursorTo(B, at - 0.7, 0.65, spec);
  B.span(at, 0.35, async p => { await js(`film.press(${p})`); });
  B.do(at, async () => {
    const r = await rect(spec);
    if (!r) { console.error(`click target not found at ${at}s: ${JSON.stringify(spec)}`); return; }
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    events.push({ t: sceneStart + at, kind: 'click' });
  });
}
function ring(B, at, dur, key, spec, color = '#2563eb') {
  B.span(at, dur, async p => { const a = Math.min(1, p * dur / 0.3, (1 - p) * dur / 0.3); await js(`film.ring(${JSON.stringify(key)}, ${JSON.stringify(spec)}, ${JSON.stringify(color)}, ${a}, 12)`); });
  B.do(at + dur, async () => { await js(`film.ring(${JSON.stringify(key)}, null, '', 0)`); });
}
// Replays a recorded stream: the shim releases events up to (scene time - start) * speed seconds after the request.
function replay(B, at, dur, key, speed, onGuard) {
  let fired = false;
  B.do(at, () => { hud = speed > 1.15 ? `${HUD} · ${speed.toFixed(1)}× speed` : HUD; });
  B.do(at + dur + 0.4, () => { hud = HUD; });
  let sent = 0;
  B.span(at, dur, async p => {
    const n = await js(`__film.push(${JSON.stringify(key)}, ${(p * dur) * speed})`);
    if (n > sent) {
      const fresh = await js(`(__film.open[${JSON.stringify(key)}]?.events ?? []).slice(${sent}, ${n}).filter(e => e.event.type === 'guard').map(e => e.event.decision)`);
      for (const label of fresh) events.push({ t: sceneStart + at + p * dur, kind: 'verdict', label });
      sent = n;
    }
    if (!fired && onGuard && n > 0) {
      const hasGuard = await js(`(__film.open[${JSON.stringify(key)}]?.events ?? []).slice(0, ${n}).some(e => e.event.type === 'guard')`);
      if (hasGuard) { fired = true; await onGuard(); }
    }
  });
  B.do(at + dur, async () => { await js(`__film.push(${JSON.stringify(key)}, 1e9)`); if (!fired && onGuard) await onGuard(); });
}
const setState = s => js(`window.__film.state = ${JSON.stringify(s)}; true`);

const scrollTo = (B, at, dur, target) => {
  let from, to;
  B.span(at, dur, async p => {
    if (from === undefined) { from = await js('window.scrollY'); to = typeof target === 'function' ? await target() : target; }
    await js(`window.scrollTo(0, ${lerp(from, to, ease(p))}); true`);
  });
};
const scrollToShow = spec => async () => {
  const r = await rect(spec), y = await js('window.scrollY'), max = await js('document.documentElement.scrollHeight - innerHeight');
  return r ? clamp(y + r.y + r.h / 2 - VH * 0.5, 0, max) : y;
};

// Keeps the newest line of the agent's trace in view, the way a person watching it would scroll.
function follow(B, at, dur, spec = { sel: '.trace > *', last: true }) {
  B.span(at, dur, async () => {
    const target = await js(`(() => { const els = document.querySelectorAll(${JSON.stringify(spec.sel)}); const el = els[els.length - 1]; if (!el) return null;
      const r = el.getBoundingClientRect(); const max = document.documentElement.scrollHeight - innerHeight;
      return Math.max(0, Math.min(max, scrollY + r.bottom - innerHeight * 0.78)); })()`);
    if (target === null) return;
    const y = await js('window.scrollY');
    await js(`window.scrollTo(0, ${y + (target - y) * 0.12}); true`);
  });
}
let hud = '';
let sceneStart = 0;
const hit = (B, at) => B.do(at, () => { events.push({ t: sceneStart + at, kind: 'hit' }); });
const HUD = 'Recorded live run · PayPal sandbox';

async function appScene(sc, script) {
  await setMode('app');
  sceneStart = sc.start;
  const B = beats();
  await script(B);
  const n = Math.round((sc.end - sc.start) * FPS);
  B.list.sort((a, b) => a.at - b.at);
  const done = new Set();
  for (let f = 0; f < n; f++) {
    const t = f / FPS;
    for (const b of B.list) {
      if (b.dur === 0) { if (!done.has(b) && t >= b.at) { done.add(b); await b.fn(); } }
      else if (t >= b.at && (t <= b.at + b.dur || !done.has(b))) { await b.fn(clamp((t - b.at) / b.dur)); if (t > b.at + b.dur) done.add(b); }
    }
    if (f % EVERY) continue;
    const c = captionAt(sc, t);
    await js(`film.setCam(${cam.x}, ${cam.y}, ${cam.w}); film.cursor(${cursor.x}, ${cursor.y}, ${cursor.show}); film.caption(${JSON.stringify(c.text)}, ${c.a}); film.hud(${JSON.stringify(hud)}, ${hud ? 1 : 0}); film.frame(${sc.start + t}); true`);
    await wait(12);
    await capture();
  }
}

// Each app scene loads the app fresh, with that scene's recorded state, streams and responses.
let initScript = null, takes = 0;
const LIVE = 'https://floorwalker.43-160-214-187.sslip.io';
const setInit = async (state, streams = {}, responses = {}) => {
  // The run was recorded against a local server; the pages show the hosted app's address instead.
  if (state) state = { ...state, appUrl: LIVE };
  if (initScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript });
  initScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__filmInit = ${JSON.stringify({ state, streams, responses })};` })).identifier;
};
const prime = async (state, streams = {}, responses = {}, page = 'inbox') => {
  await setInit(state, streams, responses);
  // A fresh query string per scene forces a full load (a hash-only change would keep the previous scene's data).
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/app?take=${++takes}#${page}` });
  await until(() => js(`document.readyState === 'complete' && !!document.querySelector('[data-slot="sidebar"]') && !!document.querySelector('main')`), 'app');
  await js('document.fonts.ready.then(() => true)');
  await js(UI);
  await js('window.scrollTo(0, 0); true');
  cursor = { x: VW * 0.62, y: VH * 0.62, show: false };
  hud = HUD;
  await wait(300);
};

const item = name => ({ sel: '.item', has: name });
const film = id => `[data-film="${id}"]`;
const S = {};

S.hook = async (B, sc) => {
  await prime(stepOf('T1').before);
  cam = { ...WIDE };
  click(B, 1.5, item('Jordan Blake'), sc.start);
  scrollTo(B, 1.9, 0.6, 0);
  camTo(B, lineAt(sc, 'h2') - 0.3, 1.4, async () => fit(await rect('.message'), { pad: 30, minW: 820 }));
  ring(B, lineAt(sc, 'h2') + 0.8, lineAt(sc, 'h3', true) - lineAt(sc, 'h2') + 0.2, 'hidden', '.hidden-part', '#dc2626');
};
S.maya = async (B, sc) => {
  const st = stepOf('T1');
  await prime(st.before, { T1: st.events });
  cam = { ...WIDE };
  click(B, 0.5, item('Maya Chen'), sc.start);
  click(B, 1.6, film('run'), sc.start);
  const end = lineAt(sc, 'm2') + 0.5, speed = st.events.at(-1).t / Math.max(1, end - 1.8);
  replay(B, 1.8, end - 1.8, 'T1', speed, () => setState(st.after));
  follow(B, 1.8, end - 1.8 + 1.0);
  follow(B, end + 0.8, 1.2, { sel: '.verdict' });
  camTo(B, lineAt(sc, 'm3') - 0.2, 1.2, async () => fit(await rect('.verdict'), { pad: 24, minW: 900 }));
  ring(B, lineAt(sc, 'm3') + 0.6, 2.6, 'rule', '.verdict .cited-rule', '#059669');
  ring(B, lineAt(sc, 'm3') + 3.4, lineAt(sc, 'm3', true) - lineAt(sc, 'm3') - 3.0, 'ref', '.verdict .paypal-ref', '#059669');
};
S.daniel = async (B, sc) => {
  const st = stepOf('T2');
  await prime(st.before, { T2: st.events });
  cam = { ...WIDE };
  click(B, 0.5, item('Daniel Okafor'), sc.start);
  click(B, 1.4, film('run'), sc.start);
  const end = sc.end - sc.start - 1.0;
  replay(B, 1.6, end - 1.6, 'T2', st.events.at(-1).t / Math.max(1, end - 1.6), () => setState(st.after));
  follow(B, 1.6, end - 1.6 + 0.8);
};
// The phone: the real /approve page inside a phone frame (film/art/phone.html), tapped for real.
async function phoneScene(sc) {
  await setMode('art');
  cam = { x: 0, y: 0, w: 1920 };
  const st = stepOf('T2'), ap = stepOf('approve');
  await setInit(st.after, {}, { approve: ap.response });
  await open(`http://127.0.0.1:${PORT}/film/${sc.page}`, `window.ready === true && !!document.getElementById('app').contentDocument?.querySelector('[data-film="approve"]')`);
  await js('document.getElementById("app").contentDocument.fonts.ready.then(() => true)');
  const rel = Object.fromEntries(sc.lines.map(l => [l.id, [l.start - sc.start, l.end - sc.start]]));
  await js(`window.LINES = ${JSON.stringify(rel)}; film.setCam(0, 0, 1920); true`);
  const inner = sel => js(`(() => { const f = document.getElementById('app'), r = f.getBoundingClientRect(), e = f.contentDocument.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: r.left + b.left + b.width / 2, y: r.top + b.top + b.height / 2 }; })()`);
  // The push notification shows the same text the server sends (server/notify.ts), for the recorded request.
  const row = st.after.ledger.find(r => r.id === ap.ledgerId);
  const note = { title: `Approve a $${row.amount.toFixed(2)} ${row.kind}?`, body: `Support agent → ${row.counterparty} · AI review: ${row.review?.verdict ?? 'unavailable'}` };
  const noteTap = lineAt(sc, 'p1', true) - 0.3;
  await js(`window.NOTE = ${JSON.stringify(note)}; window.NOTE_OUT = ${noteTap + 0.15}; render(1.2); true`);
  const noteAt = await js(`(() => { const b = document.getElementById('note').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height * 0.42 }; })()`);
  const tapAt = lineAt(sc, 'p2') + 0.3;
  let from = { x: 1700, y: 900 }, to = null, tapped = false;
  const n = Math.round((sc.end - sc.start) * FPS);
  for (let f = 0; f < n; f++) {
    const t = f / FPS;
    if (t >= noteTap - 1.0 && t < noteTap) {
      const p = ease(clamp((t - (noteTap - 1.0)) / 0.9));
      await js(`film.cursor(${lerp(from.x, noteAt.x, p)}, ${lerp(from.y, noteAt.y, p)}, true); true`);
    }
    if (t >= noteTap && t < noteTap + 0.35) await js(`film.press(${(t - noteTap) / 0.35}); true`);
    if (t >= tapAt - 1.2 && t < tapAt) {
      to ??= await inner('[data-film="approve"]');
      const p = ease(clamp((t - (tapAt - 1.2)) / 1.1));
      if (to) await js(`film.cursor(${lerp(noteAt.x, to.x, p)}, ${lerp(noteAt.y, to.y, p)}, true); true`);
    }
    if (t >= tapAt && t < tapAt + 0.35) await js(`film.press(${(t - tapAt) / 0.35}); true`);
    if (!tapped && t >= tapAt) {
      tapped = true;
      const p = await inner('[data-film="approve"]');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      events.push({ t: sc.start + t, kind: 'click' });
      await js(`(() => { const w = document.getElementById('app').contentWindow; w.__film.state = ${JSON.stringify(ap.after)}; setTimeout(() => w.__film.release('approve'), 250); return true; })()`);
      events.push({ t: sc.start + t + 0.3, kind: 'verdict', label: 'allow' });
    }
    if (f % EVERY) continue;
    const c = captionAt(sc, t);
    await js(`render(${t}); film.caption(${JSON.stringify(c.text)}, ${c.a}); film.frame(${sc.start + t}); true`);
    await capture();
  }
}
S.sam = async (B, sc) => {
  const t3 = stepOf('T3'), t4 = stepOf('T4');
  await prime(t3.before, { T3: t3.events, T4: t4.events });
  cam = { ...WIDE };
  click(B, 0.5, item('Pay Sam for the windows'), sc.start);
  click(B, 1.4, film('run'), sc.start);
  const end1 = lineAt(sc, 's1', true) + 0.2;
  replay(B, 1.6, end1 - 1.6, 'T3', t3.events.at(-1).t / Math.max(1, end1 - 1.6), () => setState(t3.after));
  follow(B, 1.6, end1 - 1.6 + 0.4);
  scrollTo(B, lineAt(sc, 's2') - 0.2, 0.5, 0);
  click(B, lineAt(sc, 's2') + 0.6, item('New PayPal for my payments'), sc.start);
  click(B, lineAt(sc, 's2') + 1.6, film('run'), sc.start);
  const end2 = lineAt(sc, 's2', true) - 0.2;
  replay(B, lineAt(sc, 's2') + 1.8, end2 - lineAt(sc, 's2') - 1.8, 'T4', t4.events.at(-1).t / Math.max(1, end2 - lineAt(sc, 's2') - 1.8), () => setState(t4.after));
  follow(B, lineAt(sc, 's2') + 1.8, end2 - lineAt(sc, 's2') - 1.8 + 1.0);
};
S.jordan = async (B, sc) => {
  const st = stepOf('T5');
  await prime(st.before, { T5: st.events });
  cam = { ...WIDE };
  click(B, 1.4, item('Jordan Blake'), sc.start);
  scrollTo(B, 1.8, 0.5, 0);
  click(B, 3.0, film('run'), sc.start);
  const end = lineAt(sc, 'j2') + 0.6;
  replay(B, 3.2, end - 3.2, 'T5', st.events.at(-1).t / Math.max(1, end - 3.2), () => setState(st.after));
  follow(B, 3.2, end - 3.2 + 0.4);
  follow(B, end + 0.3, 1.0, { sel: '.verdict' });
  camTo(B, end + 1.4, 1.1, async () => fit(await rect('.verdict .review'), { pad: 30, minW: 900 }));
  hit(B, end + 1.6);
  ring(B, end + 2.4, sc.end - sc.start - end - 2.6, 'inj', '.verdict .injection', '#dc2626');
};
S.hijack = async (B, sc) => {
  const st = stepOf('attack');
  await prime(st.before, { ATTACK: st.events });
  cam = { ...WIDE };
  scrollTo(B, 0.1, 0.5, scrollToShow(film('hijack')));
  click(B, 1.3, film('hijack'), sc.start);
  const end = lineAt(sc, 'x1', true) - 0.2;
  replay(B, 1.5, end - 1.5, 'ATTACK', st.events.at(-1).t / Math.max(1, end - 1.5), () => setState(st.after));
  follow(B, 1.6, end - 1.6 + 0.4);
};
S.freeze = async (B, sc) => {
  const st = stepOf('freeze');
  await prime(st.before, {}, {}, 'agents');
  cam = { ...WIDE };
  ring(B, 0.4, 1.6, 'perm', `${film('agent-support')} .permissions`, '#2563eb');
  // The recorded frozen state is in place before the click, so the page's refresh after the click shows it.
  B.do(lineAt(sc, 'f1', true) - 0.65, () => setState(st.after));
  click(B, lineAt(sc, 'f1', true) - 0.6, film('freeze-support'), sc.start);
  hit(B, lineAt(sc, 'f1', true) - 0.4);
  ring(B, lineAt(sc, 'f1', true) + 0.2, sc.end - sc.start - lineAt(sc, 'f1', true) - 0.3, 'frozen', '.frozen-banner', '#dc2626');
};
// An outside agent: its key on the Developers page, then the quickstart (REST and MCP).
S.api = async (B, sc) => {
  const st = stepOf('agent');
  await prime(st.after, {}, { keys: st.response.keys }, 'developers/keys');
  cam = { ...WIDE };
  ring(B, 0.4, 1.8, 'key', { sel: 'tr', has: 'Help desk' }, '#2563eb');
  // The tab is a link to /app#developers/quickstart; following it would reload the page without the film's
  // query string, so the drawn click switches the tab by its hash, as the link does.
  cursorTo(B, 1.8, 0.65, { sel: 'a', has: 'Quickstart' });
  B.span(2.5, 0.35, async p => { await js(`film.press(${p})`); });
  B.do(2.5, async () => { await js(`location.hash = 'developers/quickstart'; true`); events.push({ t: sc.start + 2.5, kind: 'click' }); });
  camTo(B, 2.9, 1.0, async () => fit(await rect({ sel: 'pre', has: '/v1/refunds' }), { pad: 40, minW: 1000, ay: 0.4 }));
  ring(B, 3.2, 2.4, 'curl', { sel: 'pre', has: '/v1/refunds' }, '#2563eb');
  camTo(B, 5.5, 0.6, { ...WIDE });
  scrollTo(B, 5.6, 0.9, scrollToShow({ sel: 'pre', has: 'claude mcp add' }));
  camTo(B, 6.5, 0.9, async () => fit(await rect({ sel: 'pre', has: 'claude mcp add' }), { pad: 60, minW: 1000, ay: 0.4 }));
  ring(B, 6.7, sc.end - sc.start - 6.9, 'mcp', { sel: 'pre', has: 'claude mcp add' }, '#2563eb');
};
// The bot's API request, held by its own cap, waiting in Approvals next to the inbox's requests.
S.apiheld = async (B, sc) => {
  const st = stepOf('api');
  await prime(st.after, {}, {}, 'approvals');
  cam = { ...WIDE };
  const card = { sel: '[data-film="approval"]', has: 'Help-desk bot' };
  scrollTo(B, 0.1, 0.6, scrollToShow(card));
  ring(B, 0.8, 2.0, 'card', card, '#b45309');
  camTo(B, 2.2, 1.1, async () => fit(await rect(card), { pad: 30, minW: 820, ay: 0.5 }));
  ring(B, 2.9, sc.end - sc.start - 3.1, 'cap', { ...card, text: 'limit per action' }, '#b45309');
};
S.rules = async (B, sc) => {
  const st = stepOf('compile'), sim = stepOf('simulate');
  await prime(st.before, {}, { compile: st.response }, 'rules');
  cam = { ...WIDE };
  click(B, 0.6, { sel: '.preset', has: 'Cautious' }, sc.start);
  click(B, 1.8, film('compile'), sc.start);
  B.do(2.9, () => js(`__film.release('compile')`));
  ring(B, 3.4, lineAt(sc, 'r2') - 3.4, 'changed', '.limit.changed', '#2563eb');
  B.do(lineAt(sc, 'r2') - 0.9, () => js(`window.__film.responses.simulate = ${JSON.stringify(sim.response)}; true`));
  click(B, lineAt(sc, 'r2') - 0.3, film('simulate'), sc.start);
  B.do(lineAt(sc, 'r2') + 0.4, () => js(`__film.release('simulate')`));
  scrollTo(B, lineAt(sc, 'r2') + 0.8, 1.2, scrollToShow('.simulation-table'));
};
S.audit = async (B, sc) => {
  const st = stepOf('audit');
  await prime(st.after, {}, { audit: st.response.log, auditVerify: st.response.verify }, 'audit');
  cam = { ...WIDE };
  camTo(B, 0.2, 0.01, async () => fit(await rect('main'), { pad: 0, minW: 1100, ay: 0.3 }));
  ring(B, 0.3, 1.9, 'agent', { sel: 'tr', has: 'On behalf of' }, '#2563eb');
  click(B, 2.5, { sel: 'button', has: 'Verify integrity' }, sc.start);
  ring(B, 3.0, sc.end - sc.start - 3.2, 'chain', { sel: 'main', text: 'Chain intact' }, '#059669');
};
S.overview = async (B, sc) => {
  const st = stepOf('simulate');
  await prime(st.after, {}, {}, 'overview');
  cam = { ...WIDE };
  ring(B, 0.6, 2.2, 'moved', film('metric-moved'), '#059669');
  ring(B, 2.4, 2.0, 'waiting', film('metric-waiting'), '#b45309');
  ring(B, 4.0, sc.end - sc.start - 4.2, 'stopped', film('metric-stopped'), '#dc2626');
};

// What Floorwalker learned from the owner's decisions: the taps on the Overview, the suggested change on Rules, Apply.
S.learn = async (B, sc) => {
  const seen = stepOf('learned'), st = stepOf('learnApply');
  await prime(seen.before, {}, { learned: seen.response, learnApply: st.response }, 'overview');
  cam = { ...WIDE };
  const taps = { sel: '[data-slot="card"]', has: 'How often agents need you' };
  scrollTo(B, 0.1, 0.6, scrollToShow(taps));
  ring(B, 0.8, lineAt(sc, 'l2') - 1.1, 'taps', taps, '#b45309');
  const card = '[data-film="learned-refunds.auto_approve_up_to"]';
  B.do(lineAt(sc, 'l2') - 0.2, async () => { await js(`location.hash = 'rules'; true`); });
  scrollTo(B, lineAt(sc, 'l2') + 0.4, 0.6, scrollToShow(card));
  camTo(B, lineAt(sc, 'l2') + 0.9, 1.0, async () => fit(await rect(card), { pad: 40, minW: 1100, ay: 0.45 }));
  ring(B, lineAt(sc, 'l2') + 1.6, 3.2, 'evidence', { sel: card, text: 'You approved all' }, '#059669');
  ring(B, lineAt(sc, 'l2') + 4.9, lineAt(sc, 'l3') - lineAt(sc, 'l2') - 4.9, 'line', { sel: card, text: 'declined a $72' }, '#dc2626');
  ring(B, lineAt(sc, 'l3') + 2.2, 2.6, 'declined', { sel: card, text: 'requests you declined would' }, '#059669');
  ring(B, lineAt(sc, 'l3') + 4.9, lineAt(sc, 'l4') - lineAt(sc, 'l3') - 4.9, 'bench', { sel: card, text: 'Benchmark attacks still stopped' }, '#059669');
  // The recorded state after the change is in place before the click, so the page's refresh after it shows the new rules.
  B.do(lineAt(sc, 'l4') + 0.3, () => js(`window.__film.responses.learned = ${JSON.stringify(st.learned)}; window.__film.state = ${JSON.stringify({ ...st.after, appUrl: LIVE })}; true`));
  click(B, lineAt(sc, 'l4') + 0.6, `${card} [data-film="apply"]`, sc.start);
  B.do(lineAt(sc, 'l4') + 1.2, () => js(`__film.release('learnApply')`));
  hit(B, lineAt(sc, 'l4') + 0.8);
  camTo(B, lineAt(sc, 'l4') + 1.6, 0.8, { ...WIDE });
  scrollTo(B, lineAt(sc, 'l4') + 1.8, 0.9, scrollToShow({ sel: '[data-slot="card"]', has: 'Active rules' }));
  ring(B, lineAt(sc, 'l4') + 2.8, sc.end - sc.start - lineAt(sc, 'l4') - 3.0, 'new', { sel: 'main', text: '$60.00' }, '#059669');
};
// A refund straight through the PayPal API: the Watch page, the incident, and the owner saying it was her.
S.watch = async (B, sc) => {
  const st = stepOf('bypass'), rs = stepOf('resolve');
  const quiet = { ...st.incidents, incidents: [], watch: { ...st.incidents.watch, last_event: null } };
  await prime(st.before, {}, { incidents: quiet, bypass: st.response, resolve: rs.response }, 'watch');
  cam = { ...WIDE };
  ring(B, 0.6, lineAt(sc, 'w2') - 0.9, 'status', { sel: '[data-slot="card"]', has: 'PayPal webhooks' }, '#2563eb');
  scrollTo(B, lineAt(sc, 'w2') - 0.4, 0.6, scrollToShow('[data-film="bypass"]'));
  click(B, lineAt(sc, 'w2') + 1.2, '[data-film="bypass"]', sc.start);
  B.do(lineAt(sc, 'w3') - 0.4, () => js(`window.__film.responses.incidents = ${JSON.stringify(st.incidents)}; window.__film.state = ${JSON.stringify({ ...st.after, appUrl: LIVE })}; true`));
  B.do(lineAt(sc, 'w3') - 0.2, () => js(`__film.release('bypass')`));
  hit(B, lineAt(sc, 'w3'));
  scrollTo(B, lineAt(sc, 'w3') + 0.3, 0.6, 0);
  ring(B, lineAt(sc, 'w3') + 0.6, 2.2, 'row', { sel: '.ag-center-cols-container .ag-row', has: 'Refund' }, '#dc2626');
  B.do(lineAt(sc, 'w3') + 2.9, async () => { await js(`location.hash = 'overview'; true`); });
  ring(B, lineAt(sc, 'w3') + 3.4, 2.4, 'incident', '[data-film="incident"]', '#dc2626');
  B.do(lineAt(sc, 'w3', true) - 0.2, () => js(`window.__film.responses.incidents = ${JSON.stringify(rs.incidents)}; window.__film.state = ${JSON.stringify({ ...rs.after, appUrl: LIVE })}; true`));
  click(B, lineAt(sc, 'w3', true) + 0.2, '[data-film="incident-mine"]', sc.start);
  B.do(lineAt(sc, 'w3', true) + 0.5, () => js(`__film.release('resolve')`));
};

// ---------------------------------------------------------------- run
for (const sc of timeline.scenes) {
  if (ONLY && !ONLY.includes(sc.id)) continue;
  const t0 = Date.now();
  if (PATCH) frameNo = frameOffset(sc.id);
  if (sc.kind === 'art') await artScene(sc);
  else if (sc.kind === 'phone') await phoneScene(sc);
  else await appScene(sc, B => S[sc.id](B, sc));
  console.log(`${sc.id.padEnd(8)} ${((sc.end - sc.start) * FPS).toFixed(0)} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (!PATCH) writeFileSync(join(HERE, ONLY ? 'work/events.preview.json' : 'work/events.json'), JSON.stringify({ events }));
console.log(`${frameNo} frames -> ${framesDir}`);
process.exit(0);
