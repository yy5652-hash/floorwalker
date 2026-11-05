import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAlert, loadAlertEnv, sendAlert } from './alert.mjs';

const REPEAT_MS = 6 * 60 * 60 * 1000;

// result is { ok: boolean, detail?: string }; timestamps are stored as ISO strings.
export function nextState(prev, result, now) {
  const time = new Date(now).toISOString();
  const state = {
    failures: prev?.failures || 0,
    downAlerted: prev?.downAlerted || false,
    lastAlertAt: prev?.lastAlertAt || null,
  };
  let alert = null;
  if (result.ok) {
    if (state.downAlerted) alert = { subject: 'recovered', body: 'The site health check is healthy again.' };
    state.failures = 0;
    state.downAlerted = false;
    state.lastAlertAt = null;
  } else {
    state.failures++;
    if (state.failures >= 2 && (!state.downAlerted || new Date(time).getTime() - new Date(state.lastAlertAt).getTime() >= REPEAT_MS)) {
      alert = { subject: 'site down', body: `The site health check failed ${state.failures} consecutive times.\n${result.detail || 'Unhealthy response'}` };
      state.downAlerted = true;
      state.lastAlertAt = time;
    }
  }
  return { state, alert };
}

export async function checkHealth(url, fetch = globalThis.fetch) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) return { ok: false, detail: `HTTP ${response.status}` };
    const data = await response.json();
    return { ok: data?.ok === true, detail: 'Expected JSON ok:true' };
  } catch {
    return { ok: false, detail: 'Request failed, timed out, or returned invalid JSON' };
  }
}

async function main() {
  loadAlertEnv();
  const file = process.env.FLOORWALKER_HEALTH_STATE_FILE || '/opt/floorwalker/state/health.json';
  const url = process.env.FLOORWALKER_HEALTH_URL || 'https://floorwalker.yingzhilu.cn/healthz';
  let prev = null;
  try {
    prev = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read health check state');
  }
  const result = await checkHealth(url);
  const now = new Date();
  const { state, alert } = nextState(prev, result, now);
  // Commit notification state only after delivery succeeds, so failures retry next run.
  if (alert) await sendAlert(buildAlert({ ...alert, host: hostname(), now }));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  console.log(`Floorwalker health: ${result.ok ? 'healthy' : 'unhealthy'}; consecutive failures: ${state.failures}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  });
}
