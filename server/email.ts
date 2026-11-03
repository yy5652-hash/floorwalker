import { config } from './config.ts';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Email = { to: string; subject: string; text: string; html: string; tag: string };
type Transport = (email: Email) => Promise<void>;
let transport: Transport | undefined;
/** Tests replace delivery without exposing credentials or email contents. */
export function setEmailTransport(fake?: Transport) { transport = fake; }
function localOutbox() {
  try {
    const url = new URL(config.baseUrl);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
export function assertEmailConfigured() {
  if (!transport && config.production && !process.env.POSTMARK_SERVER_TOKEN && !localOutbox())
    throw new Error("Email isn't set up on this server");
}
export async function sendEmail(email: Email) {
  assertEmailConfigured();
  if (transport) return transport(email);
  const token = process.env.POSTMARK_SERVER_TOKEN;
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
  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Postmark-Server-Token': token },
    body: JSON.stringify({ From: config.mailFrom, To: email.to, Subject: email.subject,
      TextBody: email.text, HtmlBody: email.html, Tag: email.tag, MessageStream: 'outbound' }),
  });
  if (!response.ok) throw new Error('Email could not be sent. Please try again later.');
}
