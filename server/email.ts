import { config } from './config.ts';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Email = { to: string; subject: string; text: string; html: string; tag: string; from?: string; replyTo?: string; headers?: { Name: string; Value: string }[] };
type Transport = (email: Email) => Promise<void>;
let transport: Transport | undefined;
/** Tests replace delivery without exposing credentials or email contents. */
export function setEmailTransport(fake?: Transport) { transport = fake; }
export function localOutbox() {
  try {
    const url = new URL(config.baseUrl);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
export function assertEmailConfigured() {
  if (!transport && config.production && !process.env.RESEND_API_KEY && !localOutbox())
    throw new Error("Email isn't set up on this server");
}
export async function sendEmail(email: Email) {
  assertEmailConfigured();
  if (transport) return transport(email);
  const token = process.env.RESEND_API_KEY;
  if (!token) {
    if (localOutbox()) {
      const dir = dirname(config.coreDbPath);
      await mkdir(dir, { recursive: true });
      const { to, subject, text, tag } = email;
      await appendFile(join(dir, 'outbox.jsonl'), JSON.stringify({ at: new Date().toISOString(), to, subject, text, tag }) + '\n', { mode: 0o600 });
      console.info(`Email to ${to}: ${subject}`);
      return;
    }
    console.info(`Email to ${email.to}: ${email.tag === 'code' ? 'Your Floorwalker code' : email.subject}`);
    // Codes are deliberately confined to local development. Never print bodies or links.
    if (process.env.NODE_ENV !== 'production' && email.tag === 'code') console.info(`Local code: ${email.text.split('\n')[0]}`);
    return;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ from: email.from ?? config.mailFrom, reply_to: email.replyTo, to: email.to, subject: email.subject,
      text: email.text, html: email.html, tags: [{ name: 'category', value: email.tag.replace(/[^A-Za-z0-9_-]/g, '_') }],
      headers: email.headers?.length ? Object.fromEntries(email.headers.map(h => [h.Name, h.Value])) : undefined }),
  });
  if (!response.ok) throw new Error('Email could not be sent. Please try again later.');
}
