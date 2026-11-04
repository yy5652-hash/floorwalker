import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod/v4';
import { ctx, inWorkspace } from './context.ts';
import * as store from './db.ts';
import { core, openWorkspace } from './workspaces.ts';
import { handleTicket } from './agent/run.ts';
import { config, paypalConfigured } from './config.ts';
import { assertActionQuota } from './billing.ts';
import { localOutbox, sendEmail } from './email.ts';

export const MessageBody = z.object({
  from_email: z.email().max(254), from_name: z.string().max(200).optional(),
  subject: z.string().min(1).max(1000), body: z.string().min(1).max(200_000),
  received_at: z.iso.datetime({ offset: true }).optional(), external_id: z.string().min(1).max(255).optional(),
  run: z.boolean().optional(),
});
export function inboxSettings() {
  let token = store.setting('inbound.token', '');
  if (!token) { token = randomBytes(24).toString('hex'); store.setSetting('inbound.token', token); }
  const domain = inboundDomain();
  const address = domain ? `${token}@${domain}` : null;
  return { address, support_address: store.setting('inbound.support', ''), auto_run: store.setting('inbound.auto_run', false),
    auto_send: store.setting('inbound.auto_send', false), received: store.setting('inbound.received', false),
    confirmations: store.tickets().filter(t => t.inbound_kind === 'confirmation'), skipped: store.setting<any[]>('inbound.skipped', []) };
}
export function rotateAddress() { store.setSetting('inbound.token', randomBytes(24).toString('hex')); return inboxSettings(); }
export function saveInboxSettings(input: unknown) {
  const b = z.object({ support_address: z.union([z.email(), z.literal('')]), auto_run: z.boolean(), auto_send: z.boolean() }).parse(input);
  store.setSetting('inbound.support', b.support_address); store.setSetting('inbound.auto_run', b.auto_run); store.setSetting('inbound.auto_send', b.auto_send);
  return inboxSettings();
}
export function addMessage(input: unknown, extra: Partial<store.Ticket> = {}) {
  const b = MessageBody.parse(input);
  const existing = b.external_id ? store.db().prepare('SELECT * FROM tickets WHERE external_id = ?').get(b.external_id) as store.Ticket | undefined : undefined;
  if (existing) return { ticket: existing, duplicate: true };
  const id = randomUUID();
  store.upsertTicket({ id, channel: 'email', from_name: b.from_name || b.from_email, from_email: b.from_email,
    subject: b.subject, body: b.body, received_at: b.received_at ?? new Date().toISOString() });
  store.db().prepare(`UPDATE tickets SET external_id=?, message_id=?, thread_references=?, attachment_note=?, inbound_kind=?, confirmation_link=?, confirmation_code=? WHERE id=?`)
    .run(b.external_id ?? null, extra.message_id ?? null, extra.thread_references ?? null, extra.attachment_note ?? null,
      extra.inbound_kind ?? 'message', extra.confirmation_link ?? null, extra.confirmation_code ?? null, id);
  if (extra.inbound_kind !== 'confirmation' && (b.run || store.setting('inbound.auto_run', false))) enqueue(id);
  return { ticket: store.ticket(id)!, duplicate: false };
}
export const running = new Set<string>();
let runner = handleTicket;
export function setInboundRunner(value = handleTicket) { runner = value; }

const pending = new Map<string, Set<string>>();
export function enqueue(id: string) {
  const ws = ctx().ws;
  if (!pending.has(ws.id)) pending.set(ws.id, new Set());
  pending.get(ws.id)!.add(id);
  void drain();
}
export async function drain() {
  const ws = ctx().ws;
  if (running.has(ws.id)) return;
  running.add(ws.id);
  try {
    const queue = pending.get(ws.id);
    while (queue?.size) {
      const id = queue.values().next().value!; queue.delete(id);
      try {
        if (!paypalConfigured() || !config.ai.configured) throw new Error('Agent setup incomplete');
        assertActionQuota(ws.id, store.actionsThisMonth());
        await runner(id, () => {});
        await maybeSendReply(id);
      } catch { console.warn('Inbound agent run failed; message remains available in inbox'); }
    }
  } finally { running.delete(ws.id); pending.delete(ws.id); }
}
const sending = new Set<string>();
export async function sendReply(id: string, confirm = false) {
  const t = store.ticket(id);
  if (!t || t.channel !== 'email' || !t.reply || t.inbound_kind === 'confirmation') throw new Error('No email reply to send');
  const support = store.setting('inbound.support', '');
  if (!z.email().safeParse(support).success) throw new Error('Set your support address in Settings before sending');
  if (t.reply_sent_at && !confirm) throw new Error('Confirm before sending this reply again');
  if (!config.mailFrom) throw new Error('Email sender is not configured on this server');
  const key = `${ctx().ws.id}:${id}`;
  if (sending.has(key)) throw new Error('Reply is already sending');
  sending.add(key);
  try {
    const clean = (v: string) => v.replace(/[\r\n]/g, ' ');
    const refs = [t.thread_references, t.message_id].filter(Boolean).join(' ');
    await sendEmail({ to: t.from_email, subject: /^re:/i.test(t.subject) ? clean(t.subject) : `Re: ${clean(t.subject)}`,
      text: t.reply, html: `<pre>${t.reply.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`, tag: 'support-reply',
      from: `"${clean(ctx().ws.name).replaceAll('"', '')} via Floorwalker" <${config.mailFrom.match(/<([^>]+)>/)?.[1] ?? config.mailFrom}>`,
      replyTo: support, headers: [...(t.message_id ? [{ Name: 'In-Reply-To', Value: clean(t.message_id) }] : []), ...(refs ? [{ Name: 'References', Value: clean(refs) }] : [])] });
    store.db().prepare('UPDATE tickets SET reply_sent_at=? WHERE id=?').run(new Date().toISOString(), id);
    return store.ticket(id);
  } finally { sending.delete(key); }
}
export async function maybeSendReply(id: string) {
  const t = store.ticket(id);
  if (!store.setting('inbound.auto_send', false) || !t?.reply || t.reply_sent_at) return;
  // A hold/block remains a reason for owner review even after a later approval.
  if (store.ledger().some(r => r.ticket_id === id && ['hold', 'block'].includes(r.decision)) || /\b(held|blocked|review|approval|unverified|cannot|can’t)\b/i.test(t.reply)) return;
  await sendReply(id);
}
function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
/** The domain whose every address Resend receives for us, e.g. "in.example.com" or "abc123.resend.app". */
export function inboundDomain() {
  const d = (process.env.FLOORWALKER_INBOUND_DOMAIN ?? '').trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}
/** Resend signs webhooks the Svix way: HMAC-SHA256 over "id.timestamp.body" with the base64 key after "whsec_". */
export function authorized(headers: Record<string, string | string[] | undefined>, body: string, now = Date.now()) {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? '';
  const id = headers['svix-id'], timestamp = headers['svix-timestamp'], signature = headers['svix-signature'];
  if (!secret.startsWith('whsec_') || typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
  return signature.split(' ').some(part => part.startsWith('v1,') && equal(part.slice(3), expected));
}
function plain(html: string) {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n: string) => { const c = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''; }).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
export function confirmation(from: string, subject: string, text: string, html: string) {
  const gmail = /^forwarding-noreply@google\.com$/i.test(from) && /forwarding.*confirm|confirm.*forwarding/i.test(subject);
  const outlook = /^[^@]+@(outlook\.com|microsoft\.com|accountprotection\.microsoft\.com)$/i.test(from) && /forwarding.*confirm|confirm.*forwarding/i.test(subject);
  if (!gmail && !outlook) return null;
  const urls = `${html}\n${text}`.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const link = urls.map(u => u.replaceAll('&amp;', '&')).find(u => {
    try { const h = new URL(u).hostname; return gmail ? h === 'mail.google.com' : /(^|\.)(outlook\.com|microsoft\.com|live\.com)$/.test(h); } catch { return false; }
  });
  return { confirmation_link: link ?? null, confirmation_code: /(?:confirmation\s+code|code)\s*[:：]?\s*([\d -]{6,20})/i.exec(text)?.[1]?.trim() ?? null };
}
export type InboundMail = { mailbox: string; messageId: string; from: string; fromName?: string; subject: string; text: string; html: string;
  headers: Map<string, string>; date?: string; attachments: number };
type Received = { ok: boolean; duplicate?: boolean; skipped?: boolean; ignored?: boolean; id?: string };
export function receive(m: InboundMail): Received {
  if (!m.mailbox || !m.messageId || m.messageId.length > 1000) throw new Error('Invalid inbound payload');
  const messageId = m.messageId.startsWith('<') ? m.messageId : `<${m.messageId}>`;
  const rows = core.prepare('SELECT id FROM workspace').all() as { id: string }[];
  for (const row of rows) {
    const ws = openWorkspace(row.id);
    const result = inWorkspace(ws, { kind: 'system', id: 'inbound', name: 'Inbound email' }, () => {
      const token = store.setting('inbound.token', '');
      if (!token || !equal(token, m.mailbox)) return null;
      const duplicate = store.db().prepare('SELECT id FROM tickets WHERE message_id=?').get(messageId);
      const seenKey = `inbound.seen.${createHash('sha256').update(m.messageId).digest('hex')}`;
      if (duplicate || store.setting(seenKey, false)) return { ok: true, duplicate: true };
      const text = m.text || plain(m.html);
      const confirm = confirmation(m.from, m.subject, text, m.html);
      const auto = m.headers.get('auto-submitted');
      if (!confirm && ((auto && auto.toLowerCase() !== 'no') || /^(bulk|list|junk)$/i.test(m.headers.get('precedence') ?? '') || /mailer-daemon/i.test(m.from))) {
        store.setSetting('inbound.skipped', [{ at: new Date().toISOString(), reason: 'Auto-reply or bulk mail' }, ...store.setting<any[]>('inbound.skipped', [])].slice(0, 20));
        store.setSetting(seenKey, true);
        return { ok: true, skipped: true };
      }
      const received = new Date(m.date ?? Date.now());
      const out = addMessage({ from_email: m.from, from_name: m.fromName, subject: m.subject || '(No subject)', body: text || '(Empty email)', received_at: Number.isFinite(received.getTime()) ? received.toISOString() : new Date().toISOString() }, {
        message_id: messageId, thread_references: m.headers.get('references') ?? m.headers.get('in-reply-to'),
        attachment_note: m.attachments ? `${m.attachments} attachment(s) were not stored.` : null,
        inbound_kind: confirm ? 'confirmation' : 'message', ...confirm,
      });
      if (!confirm) store.setSetting('inbound.received', true);
      return { ok: true, id: out.ticket.id };
    });
    if (result) return result;
  }
  console.info('Inbound email dropped: unknown or rotated mailbox');
  return { ok: true };
}
/** "Name <a@b.c>" or "a@b.c" → parts. */
function address(value: unknown) {
  const v = String(value ?? '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { name: undefined, email: v };
}
type Fetcher = (id: string) => Promise<any>;
const fetchFromResend: Fetcher = async id => {
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
  if (!response.ok) throw new Error('Received email could not be fetched');
  return response.json();
};
let fetchReceived = fetchFromResend;
/** Tests replace the Resend API call. */
export function setReceivedFetcher(value = fetchFromResend) { fetchReceived = value; }
/** Resend's `email.received` event carries only metadata; the body is fetched from its API. A local server
 * without a key (the outbox case) takes the body from the event itself so tests can run offline. */
export async function receiveResend(event: any): Promise<Received> {
  const data = event?.data;
  if (event?.type !== 'email.received' || !data || typeof data.email_id !== 'string') return { ok: true, ignored: true };
  const domain = inboundDomain();
  const full = process.env.RESEND_API_KEY ? await fetchReceived(data.email_id) : localOutbox() ? data : null;
  if (!full) throw new Error('Inbound email needs RESEND_API_KEY');
  const recipients = [full.to, full.cc, full.bcc, full.received_for, data.to, data.received_for].flat().filter(Boolean).map(v => address(v).email.toLowerCase());
  const mine = recipients.find(r => domain && r.endsWith(`@${domain}`));
  if (!mine) { console.info('Inbound email dropped: not addressed to the inbound domain'); return { ok: true }; }
  const from = address(full.from ?? data.from);
  const headers = new Map<string, string>(Object.entries(full.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(Array.isArray(v) ? v.join(' ') : v).trim()]));
  return receive({ mailbox: mine.split('@')[0].split('+')[0], messageId: String(full.message_id ?? data.message_id ?? data.email_id), from: from.email, fromName: from.name,
    subject: String(full.subject ?? data.subject ?? ''), text: typeof full.text === 'string' ? full.text : '', html: typeof full.html === 'string' ? full.html : '',
    headers, date: headers.get('date') ?? full.created_at ?? data.created_at, attachments: (full.attachments ?? data.attachments ?? []).length });
}
export const resendInbound = Router();
resendInbound.post('/api/inbound/resend', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!authorized(req.headers, body)) { res.sendStatus(401); return; }
  try { res.json(await receiveResend(JSON.parse(body))); } catch { res.status(400).json({ error: 'Invalid inbound payload' }); }
});
