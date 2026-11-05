import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Pure message construction: the caller supplies the host and clock.
export function buildAlert({ subject, body = '', host, now }) {
  return {
    subject: `[Floorwalker] ${subject}`,
    text: `${body}${body ? '\n\n' : ''}Hostname: ${host}\nTime: ${new Date(now).toISOString()}\n`,
  };
}

export function loadAlertEnv() {
  try {
    process.loadEnvFile(process.env.FLOORWALKER_ENV_FILE || '/opt/floorwalker/app/.env');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to load Floorwalker environment file');
  }
}

export async function sendAlert(alert, { fetch = globalThis.fetch, env = process.env } = {}) {
  const recipients = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);
  let to = recipients(env.FLOORWALKER_ALERT_EMAILS);
  if (!to.length) to = recipients(env.FLOORWALKER_ADMIN_EMAILS);
  const missing = !env.RESEND_API_KEY?.trim() ? 'RESEND_API_KEY is missing'
    : !to.length ? 'No recipients: set FLOORWALKER_ALERT_EMAILS or FLOORWALKER_ADMIN_EMAILS'
      : !env.FLOORWALKER_MAIL_FROM?.trim() ? 'FLOORWALKER_MAIL_FROM is missing' : null;
  if (missing) throw Object.assign(new Error(missing), { exitCode: 2 });

  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.FLOORWALKER_MAIL_FROM, to, subject: alert.subject, text: alert.text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Do not log transport errors or API response bodies: they may contain credentials.
    throw new Error('Resend request failed or timed out');
  }
  if (!response.ok) throw new Error(`Resend request failed (HTTP ${response.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    loadAlertEnv();
    if (!process.argv[2]) throw Object.assign(new Error('Usage: node alert.mjs <subject> [body]'), { exitCode: 2 });
    await sendAlert(buildAlert({ subject: process.argv[2], body: process.argv[3], host: hostname(), now: new Date() }));
    console.log('Floorwalker alert sent');
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
