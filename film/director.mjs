// Films Allowance frame by frame in headless Chromium: the art cards (film/art) and the real web app (dist/web).
//   npm run build && node film/director.mjs [--only=scene,scene] [--every=N]  ->  film/work/frames/00000.jpg ... + events.json
//
// Nothing in the UI is mocked. The app's API calls are answered from one recorded live run against the PayPal sandbox
// (film/data/run.json, see record.mjs and shim.js), released on the film clock. The film adds only a camera, a drawn
// cursor, captions, recorded-outcome annotations and highlight rings (ui.js).
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
const NOCAP = process.argv.includes('--nocap');   // no burned-in captions: the vertical cut sets its own
const PATCH = process.argv.includes('--patch');   // with --only: re-render those scenes in place in work/frames
const wait = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const script = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'));
const sourceTimeline = JSON.parse(readFileSync(join(HERE, 'work/timeline.json'), 'utf8'));
const scripted = new Map(script.scenes.map(sc => [sc.id, sc]));
// Retired scenes have no handlers or dependencies. Never silently omit a new narrated scene.
const timeline = { ...sourceTimeline, scenes: sourceTimeline.scenes.filter(sc => scripted.has(sc.id)) };
for (const sc of script.scenes) {
  const timed = timeline.scenes.find(t => t.id === sc.id);
  if (!timed || sc.lines.some(l => !timed.lines.some(t => t.id === l.id && t.text === l.text))) {
    throw new Error(`Narration timeline is stale for ${sc.id}; regenerate film/work/timeline.json from film/script.json before filming.`);
  }
}
const run = JSON.parse(readFileSync(join(HERE, 'data/run.json'), 'utf8'));
const stepOf = id => run.steps.find(s => s.id === id) ?? (() => { throw new Error(`no recorded step ${id}`); })();
const framesDir = join(HERE, NOCAP ? 'work/frames-nocap' : ONLY && !PATCH ? 'work/preview' : 'work/frames');
if (!PATCH) rmSync(framesDir, { recursive: true, force: true });
const frameOffset = id => { let n = 0; for (const sc of timeline.scenes) { if (sc.id === id) break; n += Math.round((sc.end - sc.start) * FPS); } return n; };
mkdirSync(framesDir, { recursive: true });

// ---------------------------------------------------------------- servers and browser
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.startsWith('/film/') ? join(HERE, path.slice(6)) : join(ROOT, 'dist/web', path === '/' ? 'index.html' : path);
  // The app routes /app and /approve on the client, like the real server's catch-all.
  if (!path.startsWith('/film/') && !path.includes('.') && !existsSync(file)) file = join(ROOT, 'dist/web/index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1');
const chrome = spawn(SHELL, [`--remote-debugging-port=${DEBUG}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'allowance-film-'))}`, '--window-size=1920,1080', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('floorwalker-theme', 'light'); } catch {}\nif (!location.pathname.startsWith('/film/')) { ${readFileSync(join(HERE, 'shim.js'), 'utf8')} }` });
const UI = readFileSync(join(HERE, 'ui.js'), 'utf8');
const LABELS = { hook: 'Threat brief', maya: 'Claim 01 / Auto', daniel: 'Claim 02 / Hold', phone: 'Claim 02 / Owner', jordan: 'Claim 05 / Injection', hijack: 'Hijack sim', learn: 'Learning', watch: 'PayPal watch', ledger: 'AG Grid Enterprise', api: 'Any agent', bench: 'Benchmark', end: '' };

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
  if (NOCAP) return { text: '', a: 0 };
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
  await js(`window.LINES = ${JSON.stringify(rel)}; film.setCam(0, 0, 1920); film.label(${JSON.stringify(LABELS[sc.id] ?? '')}); document.getElementById('film-caption').classList.add('on-art'); true`);
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
  B.span(at - 0.7, 1.4, async p => { await js(`film.spot(${Math.min(1, p / 0.25, (1 - p) / 0.25)})`); });
  B.do(at + 0.75, async () => { await js(`film.spot(0)`); });
  B.span(at, 0.35, async p => { await js(`film.press(${p})`); });
  B.do(at, async () => {
    const r = await rect(spec);
    if (!r) throw new Error(`click target not found at ${at}s: ${JSON.stringify(spec)}`);
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
const setState = s => js(`window.__film.state = ${JSON.stringify({ ...s, appUrl: LIVE })}; true`);

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
function follow(B, at, dur, spec = { sel: '.trace > *', last: true }, keep = 0.62) {
  B.span(at, dur, async () => {
    const target = await js(`(() => { const els = document.querySelectorAll(${JSON.stringify(spec.sel)}); const el = els[els.length - 1]; if (!el) return null;
      const r = el.getBoundingClientRect(); const max = document.documentElement.scrollHeight - innerHeight;
      return Math.max(0, Math.min(max, scrollY + r.bottom - innerHeight * ${keep})); })()`);
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
  // The product settles from a slight tilt to face-on before anything is clicked.
  B.span(0, 0.45, async p => { const e = 1 - ease(p); await js(`document.body.style.transform = ${JSON.stringify(`perspective(1800px) rotateX(${(5 * e).toFixed(2)}deg) scale(${(1 - 0.03 * e).toFixed(4)})`)}; true`); });
  B.do(0.46, async () => { await js(`document.body.style.transform = ''; true`); });
  await js(`film.label(${JSON.stringify(LABELS[sc.id] ?? '')}); true`);
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
const LIVE = 'https://floorwalker.yingzhilu.cn';
const setInit = async (state, streams = {}, responses = {}) => {
  // The run was recorded against a local server; the pages show the hosted app's address instead.
  if (state) state = { ...state, appUrl: LIVE };
  if (initScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScript });
  initScript = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__filmInit = ${JSON.stringify({ state, streams, responses })};` })).identifier;
};
const prime = async (state, streams = {}, responses = {}, page = 'inbox') => {
  await setInit(state, streams, { ...stepOf('learned').extras, ...responses });
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

const ZOOM = { x: 440, y: 50, w: 1000 };
const item = name => ({ sel: '.item', has: name });
const film = id => `[data-film="${id}"]`;
const S = {};

const duration = sc => sc.end - sc.start;
const resultCard = '.inbox-agent-result .verdict';
const paymentStatus = { sel: '.inbox-agent-result h3', has: 'Payment status', closest: 'div' };
// Navigate with a genuine click, keeping the per-take query string and injected film UI alive.
function route(B, at, page, sc) {
  const spec = `[data-slot="sidebar"] a[href="/app#${page}"]`;
  B.do(at - 0.05, () => js(`document.querySelector(${JSON.stringify(spec)})?.addEventListener('click', e => { e.preventDefault(); location.hash = ${JSON.stringify(page)}; window.scrollTo(0, 0); }, { once: true }); true`));
  click(B, at, spec, sc.start);
}
// These are film annotations, derived only from recorded outcomes; product cards stay untouched.
function outcome(B, at, sc, entry, title) {
  if (!entry) throw new Error(`Missing recorded outcome for ${sc.id}`);
  const detail = entry.paypal_ref ? `PayPal sandbox reference: ${entry.paypal_ref}` : 'Recorded outcome · PayPal sandbox';
  B.do(at, () => js(`film.outcome(${JSON.stringify(title)}, ${JSON.stringify(detail)}); true`));
  B.do(at, () => { cursor.show = false; });
}
function requireHold(sc, settled, seconds = 2) {
  if (duration(sc) - settled + 1 / FPS < seconds) throw new Error(`${sc.id}: narration leaves less than ${seconds}s for the outcome`);
}
S.maya = async (B, sc) => {
  const st = stepOf('T1'), m2 = lineAt(sc, 'm2'), m3 = lineAt(sc, 'm3');
  await prime(st.before, { T1: st.events }, {}, 'overview');
  cam = { ...WIDE };
  ring(B, 0.2, 1.1, 'three', { sel: 'h2', has: 'Try these three requests' });
  route(B, 1.4, 'inbox', sc);
  click(B, 1.9, item('Maya Chen'), sc.start);
  click(B, 2.6, film('run'), sc.start);
  const start = 2.7, end = Math.max(start + 1.0, m3 - 1.7);
  camTo(B, start, 0.65, ZOOM);
  replay(B, start, end - start, 'T1', st.events.at(-1).t / (end - start), () => setState(st.after));
  follow(B, start, end - start);
  // The new run button becomes View result; it jumps to the separate result section, never sends a reply.
  click(B, end + 0.15, { sel: '[data-film="run"]', has: 'View result' }, sc.start);
  scrollTo(B, end + 0.35, 0.5, scrollToShow(resultCard));
  camTo(B, end + 0.9, 0.55, async () => fit(await rect(resultCard), { pad: 20, minW: 960 }));
  ring(B, Math.max(m2, end + 0.9), 1.2, 'rule', `${resultCard} .cited-rule`, '#059669');
  const finish = Math.max(m3 + 0.4, end + 1.7);
  scrollTo(B, finish - 0.7, 0.5, scrollToShow(paymentStatus));
  camTo(B, finish - 0.2, 0.6, async () => fit(await rect(paymentStatus), { pad: 28, minW: 960, ay: 0.57 }));
  const entry = st.after.ledger.find(r => r.ticket_id === 'T1' && r.status === 'executed' && r.paypal_ref);
  if (!entry) throw new Error('Maya must have a recorded executed refund and sandbox reference');
  outcome(B, finish + 0.4, sc, entry, `$${entry.amount} executed · Maya's refund`);
  requireHold(sc, finish + 0.4);
};
S.daniel = async (B, sc) => {
  const st = stepOf('T2');
  await prime(st.before, { T2: st.events });
  cam = { ...WIDE };
  click(B, 0.5, item('Daniel Okafor'), sc.start);
  click(B, 1.4, film('run'), sc.start);
  const start = 1.5, end = duration(sc) - 3.3;
  if (end <= start) throw new Error('Daniel narration is too short for the held result');
  camTo(B, start, 0.6, ZOOM);
  replay(B, start, end - start, 'T2', st.events.at(-1).t / (end - start), () => setState(st.after));
  follow(B, start, end - start);
  click(B, end + 0.15, { sel: '[data-film="run"]', has: 'View result' }, sc.start);
  scrollTo(B, end + 0.3, 0.4, scrollToShow(resultCard));
  camTo(B, end + 0.7, 0.5, async () => fit(await rect(resultCard), { pad: 20, minW: 960 }));
  const entry = st.after.ledger.find(r => r.ticket_id === 'T2' && r.status === 'awaiting_approval');
  outcome(B, end + 1.2, sc, entry, '$86 waiting for Elena · above the $40 automatic limit');
  requireHold(sc, end + 1.2);
};
// The phone: the real /approve page inside a phone frame (film/art/phone.html), tapped for real.
async function phoneScene(sc) {
  await setMode('art');
  cam = { x: 0, y: 0, w: 1920 };
  const st = stepOf('T2'), ap = stepOf('approve');
  await setInit(st.after, {}, { approve: ap.response });
  await open(`http://127.0.0.1:${PORT}/film/${sc.page}`, `window.ready === true && !!document.getElementById('app').contentDocument?.querySelector('[data-film="approve"]')`);
  await js('document.getElementById("app").contentDocument.fonts.ready.then(() => true)');
  // Select Daniel by the recorded request id: Tessa is also waiting in this same run.
  await js(`(() => { const w = document.getElementById('app').contentWindow; w.location.hash = ${JSON.stringify(String(ap.ledgerId))}; return true; })()`);
  await until(() => js(`document.getElementById('app').contentDocument.querySelector('.approval-card')?.id === ${JSON.stringify(String(ap.ledgerId))}`), 'Daniel phone approval');
  // Selection stays in Approvals; clear the deep link so refresh cannot mount a second, completed card above its receipt.
  await js(`document.getElementById('app').contentWindow.location.hash = ''; true`);
  await js(`document.getElementById('app').contentDocument.querySelector('.approval-card').scrollIntoView({ block: 'start' }); true`);
  const rel = Object.fromEntries(sc.lines.map(l => [l.id, [l.start - sc.start, l.end - sc.start]]));
  await js(`window.LINES = ${JSON.stringify(rel)}; film.setCam(0, 0, 1920); film.label(${JSON.stringify(LABELS[sc.id])}); true`);
  await js(`Object.assign(document.getElementById('film-caption').style, { left: '100px', bottom: '90px', transform: 'none', width: '860px', maxWidth: '860px', textAlign: 'left', background: 'transparent', boxShadow: 'none', padding: '0', border: '0', borderImage: 'none', textShadow: '0 0 14px #fff, 0 0 14px #fff' }); true`);
  const inner = sel => js(`(() => { const f = document.getElementById('app'), r = f.getBoundingClientRect(), e = f.contentDocument.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(), k = r.width / f.offsetWidth; return { x: r.left + (b.left + b.width / 2) * k, y: r.top + (b.top + b.height / 2) * k }; })()`);
  const tapAt = Math.min(lineAt(sc, 'p2') + 0.2, duration(sc) - 3.0);
  requireHold(sc, tapAt + 0.6);
  let to = null, tapped = false, receiptShown = false;
  const n = Math.round(duration(sc) * FPS);
  for (let f = 0; f < n; f++) {
    const t = f / FPS;
    if (t >= tapAt - 1.1 && t < tapAt) {
      to ??= await inner('.approval-card [data-film="approve"]');
      if (!to) throw new Error('Phone approval button missing');
      const p = ease(clamp((t - tapAt + 1.1) / 1.0));
      await js(`film.cursor(${lerp(1700, to.x, p)}, ${lerp(900, to.y, p)}, true); true`);
    }
    if (t >= tapAt && t < tapAt + 0.35) await js(`film.press(${(t - tapAt) / 0.35}); true`);
    if (!tapped && t >= tapAt) {
      tapped = true;
      const p = await inner('.approval-card [data-film="approve"]');
      if (!p) throw new Error('Phone approval button disappeared');
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      events.push({ t: sc.start + t, kind: 'click' });
      await js(`document.getElementById('app').contentWindow.__film.state = ${JSON.stringify({ ...ap.after, appUrl: LIVE })}; true`);
      await until(() => js(`!!document.getElementById('app').contentWindow.__film.waiting.approve`), 'phone approval request');
      await js(`document.getElementById('app').contentWindow.__film.release('approve'); true`);
      events.push({ t: sc.start + t + 0.3, kind: 'verdict', label: 'allow' });
    }
    if (!receiptShown && t >= tapAt + 0.5) {
      await until(() => js(`!!document.getElementById('app').contentDocument.querySelector('[aria-label="Decision receipt"]')`), 'phone receipt');
      await js(`(() => { const d = document.getElementById('app').contentDocument; const r = d.querySelector('[aria-label="Decision receipt"]'); if (!r.textContent.includes('$86.00 refunded after your approval') || !r.textContent.includes('PayPal sandbox reference:')) throw new Error('Daniel receipt does not confirm the recorded $86 refund'); r.scrollIntoView({ block: 'center' }); film.cursorShow(false); return true; })()`);
      receiptShown = true;
    }
    if (f % EVERY) continue;
    const c = captionAt(sc, t);
    await js(`render(${t}); film.caption(${JSON.stringify(c.text)}, ${c.a}); film.frame(${sc.start + t}); true`);
    await capture();
  }
}
S.jordan = async (B, sc) => {
  const st = stepOf('T5');
  await prime(st.before, { T5: st.events });
  cam = { ...WIDE };
  let listFrom, listTo;
  B.span(0.1, 0.5, async p => {
    // Scroll the message list (its own scroll box, or the page) so Jordan's message sits near the top.
    if (listFrom === undefined) [listFrom, listTo] = await js(`(() => { const e = [...document.querySelectorAll('.item')].find(x => x.textContent.includes('Jordan Blake')); if (!e) throw new Error('Jordan message missing'); let l = e.parentElement; while (l && !(l.scrollHeight > l.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(l).overflowY))) l = l.parentElement; if (l) l.setAttribute('data-film-list', ''); const top = l ? l.getBoundingClientRect().top : 0; const from = l ? l.scrollTop : 0; return [from, Math.max(0, from + e.getBoundingClientRect().top - top - 8)]; })()`);
    await js(`(() => { const l = document.querySelector('[data-film-list]'); if (l) l.scrollTop = ${lerp(listFrom, listTo, ease(p))}; return true; })()`);
  });
  click(B, 0.9, item('Jordan Blake'), sc.start);
  // Make sure the selection lands on Jordan's message even if the list was still settling under the pointer.
  B.do(0.95, () => js(`(() => { const e = [...document.querySelectorAll('.item')].find(x => x.textContent.includes('Jordan Blake')); if (!e) throw new Error('Jordan message missing'); if (e.getAttribute('aria-pressed') !== 'true') e.click(); return true; })()`));
  camTo(B, 1.2, 0.65, async () => fit(await rect('.inbox-message .hidden-part'), { pad: 28, minW: 960, ay: 0.55 }));
  ring(B, 1.8, 1.1, 'hidden', '.inbox-message .hidden-part', '#dc2626');
  const start = Math.max(2.9, lineAt(sc, 'j1', true) + 0.2);
  const end = Math.min(Math.max(start + 0.8, lineAt(sc, 'j2') + 0.3), duration(sc) - 3.8);
  if (end <= start) throw new Error('Jordan narration is too short for the quoted outcome');
  click(B, start - 0.1, film('run'), sc.start);
  replay(B, start, end - start, 'T5', st.events.at(-1).t / (end - start), () => setState(st.after));
  follow(B, start, end - start);
  click(B, end + 0.1, { sel: '[data-film="run"]', has: 'View result' }, sc.start);
  const quote = `${resultCard} .injection`;
  scrollTo(B, end + 0.3, 0.45, scrollToShow(quote));
  camTo(B, end + 0.8, 0.6, async () => fit(await rect(quote), { pad: 40, minW: 960, ay: 0.56 }));
  const entry = st.after.ledger.find(r => r.ticket_id === 'T5' && r.status === 'blocked');
  if (!entry?.review?.injection_detected || !entry.review.concerns[0]?.evidence || entry.paypal_ref) throw new Error('Jordan recording needs a blocked outcome and quoted hidden instruction, with no PayPal submission');
  outcome(B, end + 1.4, sc, entry, 'Blocked — nothing was sent to PayPal');
  ring(B, end + 1.4, duration(sc) - end - 1.5, 'inj', quote, '#dc2626');
  hit(B, end + 1.4);
  requireHold(sc, end + 1.4);
};
S.hijack = async (B, sc) => {
  const st = stepOf('attack');
  await prime(st.before, { ATTACK: st.events });
  cam = { ...WIDE };
  scrollTo(B, 0.05, 0.4, scrollToShow(film('hijack')));
  click(B, 0.8, film('hijack'), sc.start);
  const start = 0.9, end = duration(sc) - 2.4;
  if (end <= start) throw new Error('Hijack narration is too short');
  const guards = st.events.filter(e => e.event.type === 'guard');
  if (guards.length !== 6 || guards.some(e => e.event.decision !== 'block')) throw new Error('Hijack recording must show six stopped money moves');
  camTo(B, start, 0.65, ZOOM);
  replay(B, start, end - start, 'ATTACK', st.events.at(-1).t / (end - start), () => setState(st.after));
  follow(B, start, end - start);
  camTo(B, end, 0.3, async () => fit(await rect({ sel: '.inbox-simulation .verdict', last: true }), { pad: 24, minW: 960 }));
  B.do(end + 0.3, () => js(`film.outcome('6 money moves · all stopped', 'Hijacked-agent simulation · recorded guard decisions'); true`));
  requireHold(sc, end + 0.3);
};
// An outside agent: its key on the Developers page, then the quickstart (REST and MCP).
S.api = async (B, sc) => {
  const st = stepOf('agent');
  await prime(st.after, {}, { keys: st.response.keys }, 'developers/keys');
  cam = { ...WIDE };
  B.do(0, () => js(`film.outcome('agent → Floorwalker → PayPal', 'REST or MCP · https://floorwalker.yingzhilu.cn'); true`));
  // A generic MCP config is shown; the one-line command for a named client stays out of the frame (no third-party marks).
  B.do(2.7, async () => { await js(`(() => { const p = [...document.querySelectorAll('pre')].find(e => e.textContent.includes('mcp add')); (p?.parentElement ?? p)?.style.setProperty('display', 'none'); for (const e of document.querySelectorAll('main h2, main h3, main h4, main p')) if (/Claude/.test(e.textContent)) e.style.visibility = 'hidden'; return true; })()`); });
  ring(B, 0.5, 1.5, 'key', { sel: 'tr', has: 'Help desk' }, '#2563eb');
  // The tab is a link to /app#developers/quickstart; following it would reload the page without the film's
  // query string, so the drawn click switches the tab by its hash, as the link does.
  cursorTo(B, 1.8, 0.65, { sel: 'a', has: 'Quickstart' });
  B.span(2.5, 0.35, async p => { await js(`film.press(${p})`); });
  B.do(2.5, async () => { await js(`location.hash = 'developers/quickstart'; true`); events.push({ t: sc.start + 2.5, kind: 'click' }); });
  camTo(B, 2.9, 1.0, async () => fit(await rect({ sel: 'pre', has: '/v1/refunds' }), { pad: 40, minW: 1000, ay: 0.4 }));
  ring(B, 3.2, 2.4, 'curl', { sel: 'pre', has: '/v1/refunds' }, '#2563eb');
  camTo(B, 5.5, 0.6, { ...WIDE });
  scrollTo(B, 5.6, 0.9, scrollToShow({ sel: 'pre', has: 'mcpServers' }));
  camTo(B, 6.5, 0.9, async () => fit(await rect({ sel: 'pre', has: 'mcpServers' }), { pad: 60, minW: 960, ay: 0.4 }));
  ring(B, 6.7, sc.end - sc.start - 6.9, 'mcp', { sel: 'pre', has: 'mcpServers' }, '#2563eb');
};
// Scroll the comparison's own viewport; scrolling the document cannot reveal its lower sections.
function scrollInside(B, at, dur, container, spec) {
  let from, to;
  B.span(at, dur, async p => {
    if (from === undefined) {
      const r = await rect(spec);
      if (!r) throw new Error(`Missing scroll target ${JSON.stringify(spec)}`);
      ({ from, to } = await js(`(() => { const e = document.querySelector(${JSON.stringify(container)}); if (!e) throw new Error('Missing scroll container'); const b = e.getBoundingClientRect(); return { from: e.scrollTop, to: Math.max(0, Math.min(e.scrollHeight - e.clientHeight, e.scrollTop + ${r.y + r.h / 2} - b.top - b.height / 2)) }; })()`));
    }
    await js(`document.querySelector(${JSON.stringify(container)}).scrollTop = ${lerp(from, to, ease(p))}; true`);
  });
}
const releaseRecorded = async key => {
  await until(() => js(`!!__film.waiting[${JSON.stringify(key)}]`), `${key} replay request`);
  await js(`__film.release(${JSON.stringify(key)}); true`);
};
S.learn = async (B, sc) => {
  const seen = stepOf('learned'), st = stepOf('learnApply');
  if (seen.before.agents.find(a => a.id === 'support')?.status !== 'active') throw new Error('Learning recording must start after Support agent was unfrozen');
  const offered = { ...seen.response, changes: [...seen.response.changes].sort((a, b) => Number(b.id === st.change) - Number(a.id === st.change)) };
  await prime(seen.before, {}, { learned: offered, coverage: st.coverage, approve: st.approve, learnApply: st.response }, 'agents');
  cam = { ...WIDE };
  ring(B, 0.3, 1.1, 'active', `${film('agent-support')} [aria-label="Freeze Support agent"]`, '#059669');
  B.do(0.3, () => js(`film.outcome('Support agent active', 'Recorded state · restored before learning'); true`));
  route(B, 1.8, 'approvals', sc);
  B.do(1.8, () => js(`film.outcome(''); true`));
  const row = { sel: '.approval-queue button', has: 'Tessa' };
  click(B, 2.4, row, sc.start);
  camTo(B, 2.7, 0.7, async () => fit(await rect('.approval-detail .approval-card'), { pad: 20, minW: 960 }));
  ring(B, 3.5, 1.2, 'tessa', '.approval-detail .approval-heading', '#b45309');
  const l2 = lineAt(sc, 'l2'), l3 = lineAt(sc, 'l3'), l3b = lineAt(sc, 'l3b'), l4 = lineAt(sc, 'l4');
  const openAt = Math.max(4.8, l2 + 0.1);
  click(B, openAt, { sel: '.learn-approve', has: 'Approve and stop asking about these' }, sc.start);
  const section = title => ({ sel: '[role="dialog"] h4', has: title, closest: 'section' });
  const changes = section('What changes'), why = section('Why'), replayed = section('What would have changed'), stays = section('What stays in force');
  camTo(B, openAt + 0.4, 0.6, async () => fit(await rect(changes), { pad: 40, minW: 900, ay: 0.5 }));
  ring(B, openAt + 0.55, 0.6, 'change', changes, '#059669');
  scrollInside(B, openAt + 0.85, 0.3, '[role="dialog"]', why);
  camTo(B, openAt + 1.2, 0.35, async () => fit(await rect(why), { pad: 30, minW: 900, ay: 0.5 }));
  scrollInside(B, l3 - 0.6, 0.5, '[role="dialog"]', replayed);
  camTo(B, l3 - 0.1, 0.6, async () => fit(await rect(replayed), { pad: 30, minW: 900, ay: 0.5 }));
  ring(B, l3 + 0.6, Math.max(1.0, l3b - l3 - 0.8), 'taps', { sel: '[role="dialog"] .learning-backtest > div', has: 'Taps per 100 money moves' }, '#059669');
  B.do(l3 + 0.6, () => js(`film.outcome('Demo history replay', 'Replay using recorded facts and AI reviews'); true`));
  ring(B, l3b + 0.1, 1.3, 'declined', { sel: '[role="dialog"] .learning-backtest > div', has: 'Declined requests that would pass' }, '#059669');
  scrollInside(B, l3b + 1.0, 0.5, '[role="dialog"]', stays);
  camTo(B, l3b + 1.5, 0.5, async () => fit(await rect(stays), { pad: 40, minW: 900, ay: 0.5 }));
  B.do(l3b + 1.0, () => js(`film.outcome(''); true`));
  const confirm = { sel: '[role="dialog"] button', has: 'Confirm approval and rule change' };
  scrollInside(B, l4 - 0.7, 0.5, '[role="dialog"]', confirm);
  camTo(B, l4 - 0.2, 0.5, async () => fit(await rect(confirm), { pad: 55, minW: 960, ay: 0.6 }));
  click(B, l4 + 0.4, confirm, sc.start);
  B.do(l4 + 0.5, () => releaseRecorded('approve'));
  B.do(l4 + 0.8, async () => {
    await js(`__film.responses.learned = ${JSON.stringify(st.learned)}; true`);
    await setState(st.after);
    await releaseRecorded('learnApply');
  });
  hit(B, l4 + 0.9);
  B.do(l4 + 1.2, async () => {
    await until(() => js(`!document.querySelector('[role="dialog"]') && !!document.querySelector('[aria-label="Decision receipt"]')`), 'Tessa receipt and rule change');
    cam = { ...WIDE }; await js(`location.hash = 'rules'; window.scrollTo(0, 0); true`);
  });
  camTo(B, l4 + 1.5, 0.65, async () => fit(await rect('textarea'), { pad: 40, minW: 960, ay: 0.5 }));
  ring(B, l4 + 2.2, Math.max(0.1, duration(sc) - l4 - 2.3), 'new', 'textarea', '#059669');
};
// Keep recorded coverage and webhook state intact. No invented successful webhook registration or sweep.
S.watch = async (B, sc) => {
  const st = stepOf('bypass'), rs = stepOf('resolve');
  if (Number(st.response.refund.amount) !== 25 || !st.after.agents.every(a => a.status === 'frozen')) throw new Error('Watch recording must show the outside $25 refund and paused agents');
  const quiet = { ...st.incidents, incidents: st.before.incidents ?? [], watch: { ...st.incidents.watch, last_sweep: null, last_event: null } };
  await prime(st.before, {}, { incidents: quiet, bypass: st.response, resolve: rs.response, learned: stepOf('learnApply').learned }, 'watch');
  cam = { ...WIDE };
  const w2 = lineAt(sc, 'w2'), w3 = lineAt(sc, 'w3'), resolveAt = duration(sc) - 3.5;
  const detectAt = Math.min(w3 - 0.35, resolveAt - 3.2);
  ring(B, 0.6, Math.max(0.3, w2 - 0.9), 'status', { sel: '.watch-page [data-slot="card"]', has: 'Watch status' });
  scrollTo(B, w2 - 0.6, 0.5, scrollToShow(film('bypass')));
  click(B, Math.min(w2 + 0.7, detectAt - 0.8), film('bypass'), sc.start);
  B.do(detectAt, async () => {
    await js(`__film.responses.incidents = ${JSON.stringify(st.incidents)}; true`);
    await setState(st.after);
    await releaseRecorded('bypass');
  });
  hit(B, detectAt + 0.2);
  const incident = '.watch-incidents [data-film="incident"]';
  const happened = `${incident} li:nth-child(1)`, paused = `${incident} li:nth-child(3)`;
  scrollTo(B, detectAt + 0.2, 0.45, scrollToShow(happened));
  camTo(B, detectAt + 0.65, 0.5, async () => fit(await rect(happened), { pad: 35, minW: 1040, ay: 0.52 }));
  B.do(detectAt + 0.65, () => js(`film.outcome('$25 already refunded outside Floorwalker', 'Agents paused · the refund has already happened'); true`));
  scrollTo(B, detectAt + 1.15, 0.4, scrollToShow(paused));
  camTo(B, detectAt + 1.55, 0.45, async () => fit(await rect(paused), { pad: 30, minW: 1040, ay: 0.55 }));
  ring(B, detectAt + 1.9, Math.max(0.4, resolveAt - detectAt - 2), 'pause', paused, '#dc2626');
  click(B, resolveAt, `${incident} [data-film="incident-mine"]`, sc.start);
  B.do(resolveAt + 0.15, async () => {
    await js(`__film.responses.incidents = ${JSON.stringify(rs.incidents)}; true`);
    await setState(rs.after);
    await releaseRecorded('resolve');
  });
  B.do(resolveAt + 0.5, async () => {
    await until(() => js(`!document.querySelector('.watch-incidents [data-film="incident-mine"]')`), 'resolved incident');
    if (rs.after.agents.some(a => st.after.agents.find(b => b.id === a.id)?.status === 'frozen' && a.status !== 'active')) throw new Error('Recorded owner resolution did not restore paused agents');
    cam = { ...WIDE }; await js(`film.outcome('Agents restored after Elena confirmed', 'Pausing agents did not reverse the $25 refund'); location.hash = 'agents'; window.scrollTo(0, 0); true`);
  });
  camTo(B, resolveAt + 0.8, 0.5, async () => fit(await rect(film('agent-support')), { pad: 30, minW: 1100, ay: 0.54 }));
};
S.ledger = async (B, sc) => {
  const st = stepOf('resolve');
  await prime(st.after, {}, { learned: stepOf('learnApply').learned }, 'overview');
  cam = { ...WIDE };
  route(B, 0.6, 'ledger', sc);
  const investigate = Math.max(1.7, lineAt(sc, 'lg2') - 0.3);
  const chartAt = duration(sc) - 5.5, closeAt = duration(sc) - 2.2, exportAt = duration(sc) - 1.0;
  if (chartAt - investigate < 5.5) throw new Error('Ledger narration needs room for groups, Jordan trace, chart and export');
  click(B, investigate, { sel: '.ledger-views button', has: 'Investigate stopped requests' }, sc.start);
  let gridScroll;
  B.span(investigate + 0.15, 0.4, async p => {
    if (gridScroll === undefined) { await js(`(() => { document.querySelectorAll('[data-film-scroller]').forEach(e => e.removeAttribute('data-film-scroller')); const root = document.querySelector('.ledger-surface .ag-root-wrapper'); const inner = root && [...root.querySelectorAll('*')].find(e => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2); (inner || document.scrollingElement).setAttribute('data-film-scroller', ''); return true; })()`); gridScroll = await js(`document.querySelector('[data-film-scroller]').scrollTop`); }
    await js(`document.querySelector('[data-film-scroller]').scrollTop = ${lerp(gridScroll, 0, ease(p))}; true`);
  });
  // AG Grid 36.2.0 master/detail + grouping: real group renderer, range-chart and export buttons.
  // Official reference: https://www.ag-grid.com/react-data-grid/master-detail-other/
  camTo(B, investigate + 0.4, 0.6, async () => fit(await rect('.ledger-surface .ag-root-wrapper'), { pad: 10, minW: 1220, ay: 0.5 }));
  ring(B, investigate + 0.8, 1.5, 'totals', '.ledger-surface [row-id^="row-group-"] [col-id="amount"]', '#059669');
  // Narrow the grouped view with its real search box; this also brings the virtualized Jordan row into view.
  const search = '.ledger-toolbar input[aria-label="Search ledger"]';
  click(B, investigate + 2.0, search, sc.start);
  B.do(investigate + 2.1, () => send('Input.insertText', { text: 'Jordan' }));
  const jordan = st.after.ledger.find(r => r.ticket_id === 'T5' && r.status === 'blocked');
  if (!jordan) throw new Error('Ledger recording is missing Jordan’s blocked request');
  const master = `.ledger-surface .ag-row[row-id="${jordan.id}"]`;
  const toggle = `${master} [col-id="ag-Grid-AutoColumn"] .ag-group-contracted:not(.ag-hidden)`;
  click(B, investigate + 2.9, toggle, sc.start);
  const trace = `section[aria-label="Decision trace for request ${jordan.id}"]`;
  B.do(investigate + 3.05, () => js(`(() => { document.querySelectorAll('[data-film-scroller]').forEach(e => e.removeAttribute('data-film-scroller')); const root = document.querySelector('.ledger-surface .ag-root-wrapper'); const inner = root && [...root.querySelectorAll('*')].find(e => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2); (inner || document.scrollingElement).setAttribute('data-film-scroller', ''); return true; })()`));
  scrollInside(B, investigate + 3.1, 0.45, '[data-film-scroller]', `${trace} .injection`);
  scrollTo(B, investigate + 3.55, 0.3, scrollToShow(`${trace} .injection`));
  camTo(B, investigate + 3.9, 0.5, async () => fit(await rect(`${trace} .injection`), { pad: 40, minW: 1000, ay: 0.54 }));
  ring(B, investigate + 4.4, Math.max(0.7, chartAt - investigate - 5.2), 'evidence', `${trace} .injection`, '#dc2626');
  // Return to all stopped requests so the chart and exported record retain the investigation's scope.
  click(B, chartAt - 0.9, search, sc.start);
  B.do(chartAt - 0.8, async () => {
    await js(`document.querySelector(${JSON.stringify(search)}).select(); true`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  });
  camTo(B, chartAt - 0.6, 0.5, { ...WIDE });
  click(B, chartAt, { sel: '.ledger-toolbar button', has: 'Chart' }, sc.start);
  camTo(B, chartAt + 0.4, 0.6, async () => fit(await rect('.ag-dialog:has(.ag-chart)'), { pad: 24, minW: 1180, ay: 0.5 }));
  click(B, closeAt, '.ag-dialog:has(.ag-chart) .ag-panel-title-bar-button:has(.ag-panel-title-bar-button-icon)', sc.start);
  camTo(B, closeAt + 0.2, 0.5, async () => fit(await rect('.ledger-toolbar'), { pad: 30, minW: 1200, ay: 0.5 }));
  click(B, exportAt, { sel: '.ledger-toolbar button', has: 'Excel' }, sc.start);
};

// ---------------------------------------------------------------- run
for (const sc of timeline.scenes) {
  if (ONLY && !ONLY.includes(sc.id)) continue;
  const t0 = Date.now();
  if (PATCH) frameNo = frameOffset(sc.id);
  if (sc.kind === 'art') await artScene(sc);
  else if (sc.kind === 'phone') await phoneScene(sc);
  else await appScene(sc, B => S[sc.id](B, sc));
  const slip = await js(`(document.body.innerText.match(/film: [^\\n]+/) ?? [''])[0]`).catch(() => '');
  if (slip) console.log(`WARNING ${sc.id}: ${slip}`);
  console.log(`${sc.id.padEnd(8)} ${((sc.end - sc.start) * FPS).toFixed(0)} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
if (!PATCH) writeFileSync(join(HERE, ONLY ? 'work/events.preview.json' : 'work/events.json'), JSON.stringify({ events }));
console.log(`${frameNo} frames -> ${framesDir}`);
process.exit(0);
