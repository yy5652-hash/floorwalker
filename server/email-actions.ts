import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { can } from './auth.ts';
import { config } from './config.ts';
import { inWorkspace, type Workspace } from './context.ts';
import * as store from './db.ts';
import { subscribe } from './events.ts';
import { approve, declineRequest } from './guard/index.ts';
import { core, openWorkspace, workspaceRow } from './workspaces.ts';

core.exec(`CREATE TABLE IF NOT EXISTS email_action (
 hash TEXT PRIMARY KEY, ws_id TEXT NOT NULL, ledger_id INTEGER NOT NULL,
 action TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
); CREATE INDEX IF NOT EXISTS email_action_request ON email_action(ws_id, ledger_id);`);
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const openLink = (wsId: string, id: number) => `${config.baseUrl.replace(/\/$/, '')}/approve?ws=${encodeURIComponent(wsId)}#${id}`;
export function actionToken(ws: Workspace, row: store.LedgerRow, userId: string, action: 'approve' | 'decline') {
  const token = randomBytes(32).toString('base64url');
  const expiry = Math.min(Date.now() + 72 * 3600000, row.expires_at ? Date.parse(row.expires_at) : Infinity);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('This request has expired.');
  core.prepare('INSERT INTO email_action(hash,ws_id,ledger_id,action,user_id,expires_at) VALUES (?,?,?,?,?,?)')
    .run(hash(token), ws.id, row.id, action, userId, expiry);
  return `${config.baseUrl.replace(/\/$/, '')}/email/act?t=${token}`;
}
subscribe((e, ws) => {
  if (e.type.startsWith('action.') && e.type !== 'action.held') {
    const id = Number((e.data as { id: string }).id.replace(/^act_/, ''));
    core.prepare('UPDATE email_action SET used = 1 WHERE ws_id = ? AND ledger_id = ?').run(ws.id, id);
  }
});
type Token = { hash: string; ws_id: string; ledger_id: number; action: 'approve' | 'decline'; user_id: string; expires_at: number; used: number };
function resolve(token: string) {
  const t = core.prepare('SELECT * FROM email_action WHERE hash = ?').get(hash(token)) as Token | undefined;
  if (!t || !workspaceRow(t.ws_id)) throw new Error('This link is invalid or no longer available.');
  const ws = openWorkspace(t.ws_id);
  return inWorkspace(ws, { kind: 'system', id: 'email', name: 'Floorwalker' }, () => {
    const row = store.ledgerEntry(t.ledger_id);
    const member = core.prepare('SELECT m.role,u.name FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND m.userId=?').get(ws.id, t.user_id) as { role: string; name: string } | undefined;
    let error = '';
    if (ws.demo) error = 'Email actions are unavailable in demo workspaces.';
    else if (!member || !can(member.role, { ledger: ['approve'] })) error = 'You no longer have permission to decide this request.';
    else if (!row) error = 'This request no longer exists.';
    else if (row.status !== 'awaiting_approval') error = `This request is already ${row.status}.`;
    else if (t.used) error = 'This link has already been used.';
    else if (t.expires_at <= Date.now() || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) error = 'This request or link has expired.';
    else if (row.agent_id && store.agent(row.agent_id)?.status === 'frozen') error = 'This agent is frozen. Review it in Floorwalker.';
    else if (t.action === 'approve' && row.amount > store.setting<number>('step_up_over', 250)) error = 'This amount needs a step-up check. Sign in and review it in Floorwalker.';
    return { t, ws, row, member, error };
  });
}
export async function emailAction(token: string, method: 'GET' | 'POST', reason = '') {
  let state: ReturnType<typeof resolve>;
  try { state = resolve(token); } catch (e) { return page((e as Error).message); }
  const { t, ws, row, member } = state;
  const url = openLink(ws.id, t.ledger_id);
  if (state.error) return page(state.error, url);
  const label = t.action === 'approve' ? `Approve $${row!.amount.toFixed(2)}` : 'Decline';
  if (method === 'GET') return page(`$${row!.amount.toFixed(2)} ${row!.kind} to ${row!.counterparty ?? 'unknown'}`, url,
    `<form method="post" action="/email/act"><input type="hidden" name="t" value="${escapeHtml(token)}">${t.action === 'decline' ? '<label>Reason <textarea name="reason" required maxlength="500"></textarea></label>' : ''}<button type="submit">${label}</button></form>`);
  if (t.action === 'decline' && !reason.trim()) return page('Enter a reason for declining this request.', url);
  if (core.prepare('UPDATE email_action SET used=1 WHERE hash=? AND used=0').run(t.hash).changes !== 1) return page('This link has already been used.', url);
  return inWorkspace(ws, { kind: 'user', id: t.user_id, name: member!.name, role: member!.role }, async () => {
    try {
      if (t.action === 'approve') await approve(t.ledger_id, member!.name);
      else declineRequest(t.ledger_id, member!.name, reason.slice(0, 500));
      return page(`Request ${store.ledgerEntry(t.ledger_id)!.status}.`, url);
    } catch (e) { return page((e as Error).message, url); }
  });
}
function page(message: string, url = `${config.baseUrl}/app`, form = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Floorwalker approval</title><body><main><h1>Floorwalker</h1><p>${escapeHtml(message)}</p>${form}<p><a href="${escapeHtml(url)}">Open in Floorwalker</a></p></main></body></html>`;
}
export const emailActions = express.Router();
const rates = new Map<string, { at: number; count: number }>();
emailActions.use((req, res, next) => {
  const now = Date.now();
  for (const [key, v] of rates) if (now - v.at >= 60000) rates.delete(key);
  const key = req.ip ?? 'local';
  const bucket = rates.get(key) ?? { at: now, count: 0 };
  rates.set(key, bucket);
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" });
  if (++bucket.count > 30) return void res.status(429).send(page('Too many attempts. Try again in a minute.'));
  next();
});
emailActions.use(express.urlencoded({ extended: false, limit: '4kb' }));
emailActions.route('/act').get(async (req, res) => {
  res.type('html').send(await emailAction(typeof req.query.t === 'string' ? req.query.t : '', 'GET'));
}).post(async (req, res) => {
  if (req.get('origin') && req.get('origin') !== new URL(config.baseUrl).origin) return void res.status(403).send(page('Cross-site request refused.'));
  res.type('html').send(await emailAction(typeof req.body?.t === 'string' ? req.body.t : '', 'POST', typeof req.body?.reason === 'string' ? req.body.reason : ''));
});
