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
const wait = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const timeline = JSON.parse(readFileSync(join(HERE, 'work/timeline.json'), 'utf8'));
const run = JSON.parse(readFileSync(join(HERE, 'data/run.json'), 'utf8'));
const stepOf = id => run.steps.find(s => s.id === id) ?? (() => { throw new Error(`no recorded step ${id}`); })();
const framesDir = join(HERE, ONLY ? 'work/preview' : 'work/frames');
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

// ---------------------------------------------------------------- servers and browser
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.startsWith('/film/') ? join(HERE, path.slice(6)) : join(ROOT, 'dist/web', path === '/' ? 'index.html' : path);
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
let initScript = null;
const prime = async (state, streams = {}, responses = {}) => {
  if (initScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript });
  initScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__filmInit = ${JSON.stringify({ state, streams, responses })};` })).identifier;
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(() => js(`document.readyState === 'complete' && !!document.querySelector('.kpis')`), 'app');
  await js('document.fonts.ready.then(() => true)');
  await js(UI);
  await js('window.scrollTo(0, 0); true');
  cursor = { x: VW * 0.62, y: VH * 0.62, show: false };
  hud = HUD;
  await wait(300);
};

const item = name => ({ sel: '.item', has: name });
const S = {};

S.hook = async (B, sc) => {
  const T5 = stepOf('T5');
  await prime(stepOf('T1').before);
  cam = { ...WIDE };
  click(B, 0.6, item('Jordan Blake'), sc.start);
  camTo(B, lineAt(sc, 'h2') - 0.3, 1.4, async () => fit(await rect('.message'), { pad: 30, minW: 820 }));
  ring(B, lineAt(sc, 'h2') + 0.8, lineAt(sc, 'h3', true) - lineAt(sc, 'h2') + 0.2, 'hidden', '.hidden-part', '#d14343');
  void T5;
};
S.maya = async (B, sc) => {
  const st = stepOf('T1');
  await prime(st.before, { T1: st.events });
  cam = { ...WIDE };
  click(B, 0.5, item('Maya Chen'), sc.start);
  click(B, 1.6, { sel: '.card-h .btn.primary' }, sc.start);
  const end = lineAt(sc, 'm3') - 0.6, speed = st.events.at(-1).t / Math.max(1, end - 1.8);
  replay(B, 1.8, end - 1.8, 'T1', speed, () => setState(st.after));
  follow(B, 1.8, end - 1.8 + 1.0);
  follow(B, end + 0.8, 1.2, { sel: '.verdict' });
  camTo(B, end + 2.1, 1.2, async () => fit(await rect('.verdict'), { pad: 24, minW: 900 }));
  ring(B, lineAt(sc, 'm4') + 0.2, lineAt(sc, 'm4', true) - lineAt(sc, 'm4'), 'ref', '.paypal-ref', '#0f9f6e');
  camTo(B, lineAt(sc, 'm4', true) + 0.2, 0.9, WIDE);
};
S.daniel = async (B, sc) => {
  const st = stepOf('T2'), ap = stepOf('approve');
  await prime(st.before, { T2: st.events }, { approve: ap.response });
  cam = { ...WIDE };
  click(B, 0.5, item('Daniel Okafor'), sc.start);
  click(B, 1.5, { sel: '.card-h .btn.primary' }, sc.start);
  const end = lineAt(sc, 'd2') + 1.2, speed = st.events.at(-1).t / Math.max(1, end - 1.7);
  replay(B, 1.7, end - 1.7, 'T2', speed, () => setState(st.after));
  follow(B, 1.7, end - 1.7 + 0.6);
  scrollTo(B, lineAt(sc, 'd3') - 1.4, 0.6, 0);
  click(B, lineAt(sc, 'd3') + 0.1, { sel: '.tab', has: 'Approvals' }, sc.start);
  scrollTo(B, lineAt(sc, 'd3') + 0.5, 0.6, scrollToShow('.btn.go'));
  click(B, lineAt(sc, 'd3') + 1.9, { sel: '.btn.go' }, sc.start);
  B.do(lineAt(sc, 'd3') + 2.0, async () => { await setState(ap.after); await js(`__film.release('approve')`); });
};
S.sam = async (B, sc) => {
  const t3 = stepOf('T3'), t4 = stepOf('T4');
  await prime(t3.before, { T3: t3.events, T4: t4.events });
  cam = { ...WIDE };
  click(B, 0.5, item('Pay Sam for the windows'), sc.start);
  click(B, 1.4, { sel: '.card-h .btn.primary' }, sc.start);
  const end1 = lineAt(sc, 's1') + 4.1;
  replay(B, 1.6, end1 - 1.6, 'T3', t3.events.at(-1).t / Math.max(1, end1 - 1.6), () => setState(t3.after));
  follow(B, 1.6, end1 - 1.6);
  scrollTo(B, lineAt(sc, 's2') - 1.0, 0.5, 0);
  click(B, lineAt(sc, 's2') + 0.3, item('New PayPal for my payments'), sc.start);
  click(B, lineAt(sc, 's2') + 1.4, { sel: '.card-h .btn.primary' }, sc.start);
  const end2 = lineAt(sc, 's3', true) - 0.5;
  replay(B, lineAt(sc, 's2') + 1.6, end2 - lineAt(sc, 's2') - 1.6, 'T4', t4.events.at(-1).t / Math.max(1, end2 - lineAt(sc, 's2') - 1.6), () => setState(t4.after));
  follow(B, lineAt(sc, 's2') + 1.6, end2 - lineAt(sc, 's2') - 1.6 + 1.0);
};
S.jordan = async (B, sc) => {
  const st = stepOf('T5');
  await prime(st.before, { T5: st.events });
  cam = { ...WIDE };
  click(B, 0.5, item('Jordan Blake'), sc.start);
  click(B, 1.4, { sel: '.card-h .btn.primary' }, sc.start);
  const end = lineAt(sc, 'j2') + 1.0;
  replay(B, 1.6, end - 1.6, 'T5', st.events.at(-1).t / Math.max(1, end - 1.6), () => setState(st.after));
  follow(B, 1.6, end - 1.6 + 0.4);
  follow(B, end + 0.3, 1.0, { sel: '.verdict' });
  camTo(B, end + 1.4, 1.1, async () => fit(await rect('.verdict'), { pad: 24, minW: 900 }));
  hit(B, lineAt(sc, 'j3'));
  ring(B, lineAt(sc, 'j3') - 0.2, lineAt(sc, 'j3', true) - lineAt(sc, 'j3') + 0.9, 'quote', '.verdict .quote', '#d14343');
};
S.hijack = async (B, sc) => {
  const st = stepOf('attack');
  await prime(st.before, { ATTACK: st.events });
  cam = { ...WIDE };
  click(B, 0.6, { sel: '.btn.danger' }, sc.start);
  const end = lineAt(sc, 'x3') + 0.5;
  replay(B, 0.8, end - 0.8, 'ATTACK', st.events.at(-1).t / Math.max(1, end - 0.8), () => setState(st.after));
  follow(B, 0.8, end - 0.8 + 0.4);
  hit(B, lineAt(sc, 'x3') + 0.9);
  B.do(lineAt(sc, 'x3') + 0.6, () => setState(st.after));
  scrollTo(B, lineAt(sc, 'x3') + 0.8, 1.0, 0);
  ring(B, lineAt(sc, 'x3') + 1.5, sc.end - sc.start - lineAt(sc, 'x3') - 1.6, 'stopped', { sel: '.kpi', i: 3 }, '#d14343');
};
S.rules = async (B, sc) => {
  const st = stepOf('compile');
  await prime(st.before, {}, { compile: st.response });
  cam = { ...WIDE };
  click(B, 0.5, { sel: '.tab', has: 'Rules' }, sc.start);
  B.do(1.0, () => js(`(() => { const ta = document.querySelector('.rules textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ${JSON.stringify(st.text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  ring(B, 1.2, 2.2, 'text', { sel: '.rules textarea', text: 'refund up to $30' }, '#2563eb');
  click(B, 3.4, { sel: '.rules .btn.primary' }, sc.start);
  B.do(4.6, () => js(`__film.release('compile')`));
  ring(B, 5.0, lineAt(sc, 'r2') - 5.2, 'changed', '.limit.changed', '#2563eb');
  click(B, lineAt(sc, 'r2') - 0.1, { sel: '.tab', has: 'Ledger' }, sc.start);
};

// ---------------------------------------------------------------- run
for (const sc of timeline.scenes) {
  if (ONLY && !ONLY.includes(sc.id)) continue;
  const t0 = Date.now();
  if (sc.kind === 'art') await artScene(sc);
  else await appScene(sc, B => S[sc.id](B, sc));
  console.log(`${sc.id.padEnd(8)} ${((sc.end - sc.start) * FPS).toFixed(0)} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
writeFileSync(join(HERE, ONLY ? 'work/events.preview.json' : 'work/events.json'), JSON.stringify({ events }));
console.log(`${frameNo} frames -> ${framesDir}`);
process.exit(0);
