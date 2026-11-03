// Telling people a request is waiting: Web Push to approvers' phones and browsers (with Approve and
// Decline right on the notification), Slack for the team channel, and a reminder when nobody answers.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";
import { can } from "./auth.ts";
import { config } from "./config.ts";
import { ctx, type Workspace } from "./context.ts";
import { seal, unseal } from "./crypto.ts";
import * as store from "./db.ts";
import { subscribe, type FloorwalkerEvent } from "./events.ts";
import { core } from "./workspaces.ts";
import { sendEmail, type Email } from "./email.ts";
import { actionToken, escapeHtml, openLink } from "./email-actions.ts";
import { blockExplanations } from "./explanations.ts";
import { learnedChanges, tapsPer100 } from "./guard/learn.ts";

core.exec(`
CREATE TABLE IF NOT EXISTS push_subscription (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notify_pref (
  user_id TEXT NOT NULL,
  ws_id TEXT NOT NULL,
  prefs TEXT NOT NULL,
  PRIMARY KEY (user_id, ws_id)
);
`);

// ---------------------------------------------------------------- VAPID keys
function vapid(): { publicKey: string; privateKey: string } {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  const file = join(dirname(config.coreDbPath), "vapid.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
  return JSON.parse(readFileSync(file, "utf8"));
}
const keys = vapid();
webpush.setVapidDetails(config.baseUrl.startsWith("https:") ? config.baseUrl : "mailto:push@floorwalker.localhost", keys.publicKey, keys.privateKey);
export const vapidPublicKey = keys.publicKey;

// ---------------------------------------------------------------- subscriptions and preferences
export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };

export function savePushSubscription(userId: string, sub: PushSub, userAgent?: string) {
  core.prepare(`INSERT INTO push_subscription (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 200) ?? null, new Date().toISOString());
}

export function removePushSubscription(userId: string, endpoint: string) {
  core.prepare("DELETE FROM push_subscription WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
}

export function pushDevices(userId: string): { endpoint: string; user_agent: string | null; created_at: string }[] {
  return core.prepare("SELECT endpoint, user_agent, created_at FROM push_subscription WHERE user_id = ? ORDER BY created_at DESC").all(userId) as any;
}

export type Prefs = { email_held: boolean; email_blocked: boolean; email_reminders: boolean; email_weekly: boolean; push_held: boolean; push_blocked: boolean; push_reminders: boolean; push_executed: boolean };
const DEFAULT_PREFS: Prefs = { email_held: true, email_blocked: true, email_reminders: true, email_weekly: true, push_held: true, push_blocked: true, push_reminders: true, push_executed: false };

export function prefs(userId: string, wsId: string): Prefs {
  const r = core.prepare("SELECT prefs FROM notify_pref WHERE user_id = ? AND ws_id = ?").get(userId, wsId) as { prefs: string } | undefined;
  return { ...DEFAULT_PREFS, ...(r ? JSON.parse(r.prefs) : {}) };
}

export function setPrefs(userId: string, wsId: string, p: Partial<Prefs>) {
  const next = { ...prefs(userId, wsId), ...p };
  core.prepare("INSERT INTO notify_pref (user_id, ws_id, prefs) VALUES (?, ?, ?) ON CONFLICT(user_id, ws_id) DO UPDATE SET prefs = excluded.prefs")
    .run(userId, wsId, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------- sending
type ActionData = { id: string; type: string; amount: number; counterparty: string | null; agent_id: string | null; review: { verdict: string; summary: string; injection_detected: boolean } | null; checks: { outcome: string; label: string; detail: string }[] };

const money = (n: number) => `$${n.toFixed(2)}`;
const agentName = (id: string | null) => (id ? (store.agent(id)?.name ?? id) : "An agent");
const link = (ws: Workspace, a: ActionData) => `${config.baseUrl.replace(/\/$/, "")}/approve?ws=${ws.id}#${a.id.replace(/^act_/, "")}`;

async function pushTo(ws: Workspace, pref: keyof Prefs, payload: Record<string, unknown>) {
  const members = core.prepare("SELECT userId, role FROM member WHERE organizationId = ?").all(ws.id) as { userId: string; role: string }[];
  for (const m of members) {
    if (!can(m.role, { ledger: ["approve"] }) || !prefs(m.userId, ws.id)[pref]) continue;
    const subs = core.prepare("SELECT * FROM push_subscription WHERE user_id = ?").all(m.userId) as any[];
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" });
      } catch (e: any) {
        // The browser dropped the subscription (uninstalled, revoked): forget it.
        if (e?.statusCode === 404 || e?.statusCode === 410) core.prepare("DELETE FROM push_subscription WHERE endpoint = ?").run(s.endpoint);
      }
    }
  }
}

function pushHeld(ws: Workspace, a: ActionData, reminder = false) {
  const stepUp = a.amount > store.setting<number>("step_up_over", 250);
  return pushTo(ws, reminder ? "push_reminders" : "push_held", {
    title: `${reminder ? "Still waiting: " : ""}Approve a ${money(a.amount)} ${a.type}?`,
    body: `${agentName(a.agent_id)} → ${a.counterparty ?? "unknown"}${a.review ? ` · AI review: ${a.review.verdict}` : ""}`,
    tag: `${ws.id}:${a.id}`,
    url: link(ws, a),
    workspaceId: ws.id,
    ledgerId: Number(a.id.replace(/^act_/, "")),
    // Large amounts need the passkey check, so the notification only offers to open the request.
    actions: stepUp ? ["open"] : ["approve", "decline"],
  });
}

// ---------------------------------------------------------------- Slack
export const SLACK_EVENTS = ["action.held", "action.blocked", "action.executed", "action.expired"] as const;

export function slackConfig(): { configured: boolean; events: string[] } {
  return { configured: Boolean(store.setting<string | null>("slack_webhook", null)), events: store.setting<string[]>("slack_events", ["action.held", "action.blocked"]) };
}

export async function setSlack(url: string | null, events?: string[]) {
  if (url !== null) {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com") throw new Error("Paste a Slack incoming webhook URL (https://hooks.slack.com/services/…).");
    await postSlack(url, { text: `Floorwalker is connected. Requests from ${ctx().ws.name} will show up here.` });
  }
  store.setSetting("slack_webhook", url ? seal(url, "slack") : null);
  if (events) store.setSetting("slack_events", events.filter((e) => (SLACK_EVENTS as readonly string[]).includes(e)));
}

async function postSlack(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Slack said ${res.status} ${await res.text().catch(() => "")}`.trim());
}

function slackMessage(ws: Workspace, e: FloorwalkerEvent, a: ActionData, reminder = false) {
  const head = {
    "action.held": `${reminder ? "Still waiting" : "Approval needed"}: ${money(a.amount)} ${a.type} to ${a.counterparty ?? "unknown"}`,
    "action.blocked": `Blocked before PayPal: ${money(a.amount)} ${a.type} to ${a.counterparty ?? "unknown"}`,
    "action.executed": `Done: ${money(a.amount)} ${a.type} to ${a.counterparty ?? "unknown"}`,
    "action.expired": `Expired unanswered: ${money(a.amount)} ${a.type} to ${a.counterparty ?? "unknown"}`,
  }[e.type as (typeof SLACK_EVENTS)[number]];
  const flagged = a.checks.filter((c) => c.outcome !== "pass").slice(0, 3).map((c) => `• *${c.label}:* ${c.detail}`).join("\n");
  return {
    text: head,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${head}*\n${agentName(a.agent_id)} · ${ws.name}${a.review ? `\nAI review: _${a.review.verdict}_ — ${a.review.summary}` : ""}` } },
      ...(flagged ? [{ type: "section", text: { type: "mrkdwn", text: flagged } }] : []),
      ...(e.type === "action.held" ? [{ type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Review in Floorwalker" }, url: link(ws, a) }] }] : []),
    ],
  };
}

async function slack(ws: Workspace, e: FloorwalkerEvent, reminder = false) {
  const sealed = store.setting<string | null>("slack_webhook", null);
  if (!sealed || !slackConfig().events.includes(e.type)) return;
  await postSlack(unseal(sealed, "slack"), slackMessage(ws, e, e.data as ActionData, reminder));
}

subscribe(async (e, ws) => {
  if (e.type === "incident.opened") {
    const i = e.data as { id: number; kind: string; amount: number; detail: string; frozen_agents: string | null };
    const frozen = (JSON.parse(i.frozen_agents ?? "[]") as string[]).length;
    await pushTo(ws, "push_blocked", {
      title: `Money moved outside Floorwalker: ${money(i.amount)} ${i.kind}`,
      body: `${i.detail}${frozen ? ` ${frozen} agent${frozen === 1 ? " was" : "s were"} frozen.` : ""}`,
      tag: `${ws.id}:incident:${i.id}`, url: `/app?ws=${ws.id}#overview`, actions: ["open"],
    }).catch(() => {});
    return;
  }
  if (!e.type.startsWith("action.")) return;
  const a = e.data as ActionData;
  await Promise.allSettled([
    e.type === "action.held" ? pushHeld(ws, a) : null,
    e.type === "action.blocked" && a.review?.injection_detected
      ? pushTo(ws, "push_blocked", { title: `Blocked: ${money(a.amount)} ${a.type}`, body: `${agentName(a.agent_id)} was steered by a message. Nothing reached PayPal.`, tag: `${ws.id}:${a.id}`, url: link(ws, a), actions: ["open"] })
      : null,
    e.type === "action.executed" ? pushTo(ws, "push_executed", { title: `Done: ${money(a.amount)} ${a.type}`, body: `${agentName(a.agent_id)} → ${a.counterparty}`, tag: `${ws.id}:${a.id}`, url: link(ws, a), actions: [] }) : null,
    slack(ws, e),
    e.type === "action.held" || e.type === "action.blocked" ? emailRequest(ws, Number(a.id.replace(/^act_/, "")), e.type === "action.blocked" ? "blocked" : "held") : null,
  ]);
});

/** One reminder per request that has waited longer than the workspace's reminder delay. Runs inside a workspace. */
export async function remindWaiting() {
  const { ws } = ctx();
  await sendWeeklySummary();
  const after = store.setting<number>("reminder_after_minutes", 60);
  const cutoff = new Date(Date.now() - after * 60_000).toISOString();
  const due = store.ledger().filter((r) => r.status === "awaiting_approval" && !r.reminded_at && r.created_at <= cutoff);
  const { actionView } = await import("./guard/index.ts");
  for (const r of due) {
    store.markReminded(r.id);
    const a = actionView(r) as unknown as ActionData;
    await Promise.allSettled([emailRequest(ws, r.id, "reminders"), pushHeld(ws, a, true), slack(ws, { id: `evt_reminder_${r.id}`, type: "action.held", workspace_id: ws.id, created_at: new Date().toISOString(), data: a }, true)]);
  }
}


// Persistent receipts keep duplicate events and scheduler ticks from sending the same email twice.
core.exec(`CREATE TABLE IF NOT EXISTS email_notice (
 ws_id TEXT NOT NULL, user_id TEXT NOT NULL, notice TEXT NOT NULL,
 PRIMARY KEY(ws_id,user_id,notice)
);`);
async function deliverOnce(ws: Workspace, userId: string, notice: string, make: () => Email) {
  if (!core.prepare('INSERT OR IGNORE INTO email_notice VALUES (?,?,?)').run(ws.id, userId, notice).changes) return;
  try { await sendEmail(make()); }
  catch (e) {
    core.prepare('DELETE FROM email_notice WHERE ws_id=? AND user_id=? AND notice=?').run(ws.id, userId, notice);
    throw e;
  }
}
function recipients(ws: Workspace) {
  return core.prepare('SELECT DISTINCT u.id,u.email,m.role FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND u.emailVerified=1 AND COALESCE(u.isAnonymous,0)=0')
    .all(ws.id) as { id: string; email: string; role: string }[];
}
function compose(ws: Workspace, to: string, subject: string, lines: string[], links: [string, string][], tag: string): Email {
  const settings = `${config.baseUrl.replace(/\/$/, '')}/app?ws=${encodeURIComponent(ws.id)}#settings/notifications`;
  const footer: [string, string][] = [...links, ['Notification settings', settings]];
  return { to, subject, tag,
    text: [...lines, '', ...footer.map(([label, url]) => `${label}: ${url}`), '', ws.name].join('\n'),
    html: `<html lang="en"><body>${lines.map(l => `<p>${escapeHtml(l)}</p>`).join('')}${footer.map(([label, url]) => `<p><a${label.startsWith("Approve $") || label === "Decline" ? ' style="display:inline-block;padding:12px 18px;border:1px solid #333;border-radius:6px"' : ""} href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`).join('')}<footer>${escapeHtml(ws.name)}</footer></body></html>` };
}
/** The same four groups and priority order as ApprovalEvidence. */
export function emailEvidence(row: store.LedgerRow) {
  const checks = JSON.parse(row.checks) as { id: string; outcome: string; detail: string }[];
  const limits = new Set(['auto_limit', 'hard_limit', 'budget', 'payee_limit', 'agent_cap', 'agent_budget']);
  const rules = checks.filter(c => !['ai_review', 'injection'].includes(c.id));
  const priority: Record<string, number> = { pass: 0, hold: 1, block: 2 };
  const labels: Record<string, string> = { pass: 'Passed', hold: 'Needs you', block: 'Blocked', missing: 'Not recorded' };
  const summarize = (label: string, group: typeof checks, fallback: string) => {
    const first = [...group].sort((a,b) => priority[b.outcome] - priority[a.outcome])[0];
    return `${label}: ${labels[first?.outcome ?? 'missing']} — ${first?.detail ?? fallback}`;
  };
  const review = row.review ? JSON.parse(row.review) : null;
  return [
    summarize('PayPal records', rules.filter(c => ['capture','buyer'].includes(c.id)), row.kind === 'payout' ? 'No recipient payment record is verified for this payout; see the payee rule below.' : 'No PayPal evidence was recorded for this request.'),
    summarize('Your rules', rules.filter(c => !limits.has(c.id) && !['capture','buyer'].includes(c.id)), 'No other rule applies to this request.'),
    summarize('Limits', rules.filter(c => limits.has(c.id)), 'No amount or budget check was recorded.'),
    review ? `AI review: ${labels[({ approve: 'pass', escalate: 'hold', reject: 'block' } as Record<string,string>)[review.verdict]] ?? 'Not recorded'} — ${review.summary}`
      : summarize('AI review', checks.filter(c => ['ai_review','injection'].includes(c.id)), 'No AI recommendation recorded for this request.'),
  ];
}
export async function emailRequest(ws: Workspace, id: number, kind: 'held' | 'blocked' | 'reminders') {
  if (ws.demo) return;
  const row = store.ledgerEntry(id);
  if (!row || (kind !== 'blocked' && (row.status !== 'awaiting_approval' || (row.expires_at && Date.parse(row.expires_at) <= Date.now())))) return;
  const title = `${money(row.amount)} ${row.kind} to ${row.counterparty ?? 'unknown'}`;
  const review = row.review ? JSON.parse(row.review) : null;
  const checks = JSON.parse(row.checks) as { outcome: string; detail: string }[];
  const conclusion = (checks.find(c => c.outcome === 'block') ?? checks.find(c => c.outcome === 'hold'))?.detail ?? review?.summary ?? 'This request is waiting for your decision.';
  const lines = [title, kind === 'blocked' ? 'Stopped before reaching PayPal.' : (conclusion.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || conclusion),
    ...emailEvidence(row),
    ...(kind === 'blocked' ? blockExplanations(row).map(b => `${b.rule}: ${b.evidence} ${b.next_step}`) : []),
    `Agent: ${agentName(row.agent_id)}`, `Expires: ${row.expires_at ?? 'No request expiry recorded'}`];
  await Promise.allSettled(recipients(ws).filter(m => can(m.role, { ledger: ['approve'] }) && prefs(m.id, ws.id)[`email_${kind}`]).map(m =>
    deliverOnce(ws, m.id, `${kind}:${id}`, () => compose(ws, m.email,
      kind === 'blocked' ? `Blocked: ${title}` : `${kind === 'reminders' ? 'Still waiting: ' : ''}Approve a ${title}?`, lines,
      [...(kind === 'blocked' ? [] : [[`Approve ${money(row.amount)}`, actionToken(ws, row, m.id, 'approve')], ['Decline', actionToken(ws, row, m.id, 'decline')]] as [string,string][]),
        ['Open in Floorwalker', openLink(ws.id, id)]], `request-${kind}`))));
}
// Installed when the email routes are mounted, so the Overview owns the money/count formulas.
type OverviewMetrics = (rows: store.LedgerRow[]) => { moved: number; stopped: number; waitingCount: number };
let overviewMetrics: OverviewMetrics | undefined;
export function useOverviewMetrics(metrics: OverviewMetrics) { overviewMetrics = metrics; }
/** Completed Monday–Monday reporting weeks; tap calculations and suggestions reuse Overview functions. */
export function weeklySummary(now = new Date()) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - (end.getUTCDay() + 6) % 7);
  const start = end.getTime() - 7 * 86400000;
  const moves = store.ledger().filter(r => ['refund','payout'].includes(r.kind));
  const week = moves.filter(r => Date.parse(r.created_at) >= start && Date.parse(r.created_at) < end.getTime());
  const last = moves.filter(r => Date.parse(r.created_at) >= start - 7 * 86400000 && Date.parse(r.created_at) < start);
  if (!overviewMetrics) throw new Error('Overview metrics have not been registered.');
  const suggestion = learnedChanges(store.activePolicy().policy)[0] ?? null;
  return { week: new Date(start).toISOString().slice(0,10), moves: week.length,
    taps: tapsPer100(week.map(r => r.decision)), lastTaps: tapsPer100(last.map(r => r.decision)),
    automatic: overviewMetrics(week.filter(r => r.status === 'executed')).moved,
    stopped: overviewMetrics(week).stopped,
    waiting: overviewMetrics(store.ledger()).waitingCount, suggestion };
}
export async function sendWeeklySummary(now = new Date()) {
  const { ws } = ctx();
  if (ws.demo || now.getUTCDay() !== 1 || now.getUTCHours() < 9) return;
  const summary = weeklySummary(now);
  if (!summary.moves) return;
  await Promise.allSettled(recipients(ws).filter(m => m.role.split(',').map(r => r.trim()).includes('owner') && prefs(m.id,ws.id).email_weekly).map(m =>
    deliverOnce(ws, m.id, `weekly:${summary.week}`, () => compose(ws, m.email, 'Your Floorwalker weekly summary', [
      `Week of ${summary.week}`,
      `Taps per 100 money moves: ${summary.taps} this week vs ${summary.lastTaps} last week`,
      `Money done without the owner: ${money(summary.automatic)}`,
      `Money stopped: ${money(summary.stopped)}`,
      `Requests still waiting: ${summary.waiting}`,
      summary.suggestion ? `Best learned suggestion: ${summary.suggestion.title} — saves ${summary.suggestion.impact.tapsSaved} taps in the learning window.` : 'No learned suggestion is supported by the recorded decisions yet.',
    ], [['Open in Floorwalker', `${config.baseUrl}/app?ws=${encodeURIComponent(ws.id)}#overview`]], 'weekly'))));
}
