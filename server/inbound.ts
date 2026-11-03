import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod/v4';
import { ctx, inWorkspace } from './context.ts';
import * as store from './db.ts';
import { core, openWorkspace } from './workspaces.ts';
import { handleTicket } from './agent/run.ts';
import { config, paypalConfigured } from './config.ts';
import { assertActionQuota } from './billing.ts';
import { sendEmail } from './email.ts';

export const MessageBody = z.object({
  from_email: z.email().max(254), from_name: z.string().max(200).optional(),
  subject: z.string().min(1).max(1000), body: z.string().min(1).max(200_000),
  received_at: z.iso.datetime({ offset: true }).optional(), external_id: z.string().min(1).max(255).optional(),
  run: z.boolean().optional(),
});
export function inboxSettings() {
  let token = store.setting('inbound.token', '');
  if (!token) { token = randomBytes(24).toString('hex'); store.setSetting('inbound.token', token); }
  const base = process.env.POSTMARK_INBOUND_ADDRESS;
  const address = base && /^[^+\s@]+@[^\s@]+$/.test(base) ? base.replace('@', `+${token}@`) : null;
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
export function authorized(header: string | undefined) {
  const user = process.env.POSTMARK_INBOUND_USER, password = process.env.POSTMARK_INBOUND_PASSWORD;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? '');
  const supplied = match ? Buffer.from(match[1], 'base64').toString() : '';
  return !!user && !!password && equal(supplied, `${user}:${password}`);
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
export function receivePostmark(b: any): { ok: boolean; duplicate?: boolean; skipped?: boolean; id?: string } {
  if (!b || typeof b.MailboxHash !== 'string' || typeof b.MessageID !== 'string' || !b.MessageID || b.MessageID.length > 1000) throw new Error('Invalid inbound payload');
  const rows = core.prepare('SELECT id FROM workspace').all() as { id: string }[];
  for (const row of rows) {
    const ws = openWorkspace(row.id);
    const result = inWorkspace(ws, { kind: 'system', id: 'inbound', name: 'Inbound email' }, () => {
      const token = store.setting('inbound.token', '');
      if (!token || !equal(token, b.MailboxHash)) return null;
      const duplicate = store.db().prepare('SELECT id FROM tickets WHERE message_id=?').get(b.MessageID.startsWith('<') ? b.MessageID : `<${b.MessageID}>`);
      const seenKey = `inbound.seen.${createHash('sha256').update(b.MessageID).digest('hex')}`;
      if (duplicate || store.setting(seenKey, false)) return { ok: true, duplicate: true };
      const from = b.FromFull?.Email ?? b.From;
      if (typeof from !== 'string') throw new Error('Missing sender');
      const headers = new Map<string, string>((Array.isArray(b.Headers) ? b.Headers : []).map((h: any) => [String(h.Name).toLowerCase(), String(h.Value).trim()]));
      const text = typeof b.StrippedTextReply === 'string' && b.StrippedTextReply ? b.StrippedTextReply : typeof b.TextBody === 'string' && b.TextBody ? b.TextBody : plain(String(b.HtmlBody ?? ''));
      const confirm = confirmation(from, String(b.Subject ?? ''), text, String(b.HtmlBody ?? ''));
      const auto = headers.get('auto-submitted');
      if (!confirm && ((auto && auto.toLowerCase() !== 'no') || /^(bulk|list|junk)$/i.test(headers.get('precedence') ?? '') || /mailer-daemon/i.test(from))) {
        store.setSetting('inbound.skipped', [{ at: new Date().toISOString(), reason: 'Auto-reply or bulk mail' }, ...store.setting<any[]>('inbound.skipped', [])].slice(0, 20));
        store.setSetting(seenKey, true);
        return { ok: true, skipped: true };
      }
      const received = new Date(b.Date ?? Date.now());
      const out = addMessage({ from_email: from, from_name: b.FromFull?.Name, subject: b.Subject || '(No subject)', body: text || '(Empty email)', received_at: Number.isFinite(received.getTime()) ? received.toISOString() : new Date().toISOString() }, {
        message_id: b.MessageID.startsWith('<') ? b.MessageID : `<${b.MessageID}>`, thread_references: headers.get('references') ?? headers.get('in-reply-to'),
        attachment_note: b.Attachments?.length ? `${b.Attachments.length} attachment(s) were not stored.` : null,
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
export const postmark = Router();
postmark.post('/api/inbound/postmark', (req, res, next) => {
  if (!authorized(req.headers.authorization)) { res.setHeader('WWW-Authenticate', 'Basic realm="Postmark"'); res.sendStatus(401); return; }
  next();
}, express.json({ limit: '1mb' }), (req, res) => {
  try { res.json(receivePostmark(req.body)); } catch { res.status(400).json({ error: 'Invalid inbound payload' }); }
});
