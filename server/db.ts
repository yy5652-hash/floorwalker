import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { ctx, setDefaultWorkspace, type Workspace } from "./context.ts";
import { DEFAULT_POLICY, DEFAULT_POLICY_TEXT, type Policy } from "./guard/policy.ts";
import type { Check, Spend } from "./guard/rules.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shadow_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  started_by TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ends_at TEXT
);
CREATE TABLE IF NOT EXISTS shadow_results (
  ledger_id INTEGER PRIMARY KEY REFERENCES ledger(id) ON DELETE CASCADE,
  real_decision TEXT NOT NULL,
  shadow_decision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  invoice_id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  order_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,
  amount REAL NOT NULL,
  items TEXT NOT NULL,
  tracking TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reply TEXT
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  params TEXT NOT NULL,
  amount REAL NOT NULL,
  counterparty TEXT,
  justification TEXT,
  decision TEXT NOT NULL,
  checks TEXT NOT NULL,
  review TEXT,
  status TEXT NOT NULL,
  paypal_ref TEXT,
  paypal_result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  can_refund INTEGER NOT NULL DEFAULT 0,
  can_payout INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  status_changed_at TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  on_behalf_of TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
-- The audit log is append-only: SQLite itself refuses edits and deletions.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  max_amount REAL NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ledger_id INTEGER,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  paypal_ref TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  counterparty TEXT,
  capture_id TEXT,
  detail TEXT NOT NULL,
  detected_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  frozen_agents TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT
);
`;

// Columns added after the first release; older databases get them here.
const COLUMNS: [table: string, column: string, type: string][] = [
  ["policies", "created_by", "TEXT"],
  ["tickets", "message_id", "TEXT"],
  ["tickets", "external_id", "TEXT"],
  ["tickets", "thread_references", "TEXT"],
  ["tickets", "attachment_note", "TEXT"],
  ["tickets", "reply_sent_at", "TEXT"],
  ["tickets", "internal_note", "TEXT"],
  ["tickets", "needs_follow_up", "INTEGER NOT NULL DEFAULT 0"],
  ["tickets", "reply_ledger_snapshot", "TEXT"],
  ["tickets", "inbound_kind", "TEXT"],
  ["tickets", "confirmation_link", "TEXT"],
  ["tickets", "confirmation_code", "TEXT"],

  ["agents", "freeze_explanation", "TEXT"],
  ["ledger", "currency", "TEXT NOT NULL DEFAULT 'USD'"],
  ["ledger", "agent_id", "TEXT"],
  ["ledger", "facts", "TEXT"],
  ["ledger", "policy_id", "INTEGER"],
  ["ledger", "approved_amount", "REAL"],
  ["ledger", "decline_reason", "TEXT"],
  ["ledger", "expires_at", "TEXT"],
  ["ledger", "reminded_at", "TEXT"],
  ["ledger", "idempotency_key", "TEXT"],
  ["ledger", "source", "TEXT"],
  ["ledger", "execution_started_at", "TEXT"],
  ["agents", "max_per_action", "REAL"],
  ["agents", "budget", "REAL"],
  ["agents", "budget_period", "TEXT"],
  ["agents", "payees", "TEXT"],
  ["agents", "expires_at", "TEXT"],
  ["agents", "created_at", "TEXT"],
  ["grants", "base_paid", "REAL NOT NULL DEFAULT 0"],
];

/** Opens (and creates or upgrades) one workspace's database. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec(SCHEMA);
  const have = new Map<string, Set<string>>();
  for (const [table, col, type] of COLUMNS) {
    if (!have.has(table)) have.set(table, new Set((d.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name)));
    if (!have.get(table)!.has(col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS ledger_idempotency ON ledger (agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS ticket_message_id ON tickets(message_id) WHERE message_id IS NOT NULL; CREATE UNIQUE INDEX IF NOT EXISTS ticket_external_id ON tickets(external_id) WHERE external_id IS NOT NULL;");
  return d;
}

/** The current workspace's database. */
export const db = () => ctx().ws.db;

let local: Workspace | null = null;
setDefaultWorkspace(() => (local ??= {
  id: "local",
  name: "Local workspace",
  db: openDb(config.dbPath),
  paypal: config.paypal.clientId && config.paypal.clientSecret ? { clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret } : null,
  demo: true,
}));

const nowIso = () => new Date().toISOString();

export function activePolicy(): { id: number; text: string; policy: Policy } {
  const row = db().prepare("SELECT id, text, json FROM policies ORDER BY id DESC LIMIT 1").get() as any;
  if (row) return { id: row.id, text: row.text, policy: JSON.parse(row.json) };
  return savePolicy(DEFAULT_POLICY_TEXT, DEFAULT_POLICY);
}

export function savePolicy(text: string, policy: Policy) {
  const r = db().prepare("INSERT INTO policies (text, json, created_at, created_by) VALUES (?, ?, ?, ?)").run(text, JSON.stringify(policy), nowIso(), ctx().actor.name);
  return { id: Number(r.lastInsertRowid), text, policy };
}

export function policyVersions(): { id: number; text: string; policy: Policy; created_at: string; created_by: string | null }[] {
  return (db().prepare("SELECT id, text, json, created_at, created_by FROM policies ORDER BY id DESC LIMIT 20").all() as any[])
    .map((r) => ({ id: r.id, text: r.text, policy: JSON.parse(r.json), created_at: r.created_at, created_by: r.created_by }));
}

export function policyVersion(id: number) {
  return policyVersions().find((v) => v.id === id);
}

// ---------------------------------------------------------------- agents
export type Agent = {
  id: string;
  name: string;
  role: string;
  can_refund: number;
  can_payout: number;
  status: "active" | "frozen";
  status_changed_at: string | null;
  /** Hold any single action above this (USD); null = only the workspace rules apply. */
  max_per_action: number | null;
  /** This agent's own rolling budget, on top of the workspace budget. */
  budget: number | null;
  budget_period: "day" | "week" | "month" | null;
  /** JSON list of emails this agent may pay; null = anyone the workspace rules allow. */
  payees: string | null;
  /** After this the agent can't move money at all. */
  expires_at: string | null;
  created_at: string | null;
};

export type AgentControls = Pick<Agent, "max_per_action" | "budget" | "budget_period" | "expires_at"> & { payees: string[] | null };

export function agents(): Agent[] {
  return db().prepare("SELECT * FROM agents ORDER BY rowid").all() as any;
}

export function agent(id: string): Agent | undefined {
  return db().prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
}

export function upsertAgent(a: Pick<Agent, "id" | "name" | "role" | "can_refund" | "can_payout">) {
  db().prepare(`INSERT INTO agents (id, name, role, can_refund, can_payout, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, can_refund = excluded.can_refund, can_payout = excluded.can_payout`)
    .run(a.id, a.name, a.role, a.can_refund, a.can_payout, nowIso());
}

export function setAgentControls(id: string, c: AgentControls) {
  return db().prepare("UPDATE agents SET max_per_action = ?, budget = ?, budget_period = ?, payees = ?, expires_at = ? WHERE id = ?").run(
    c.max_per_action, c.budget, c.budget ? (c.budget_period ?? "week") : null, c.payees?.length ? JSON.stringify(c.payees) : null, c.expires_at, id,
  ).changes === 1;
}

/** Agents with history stay (the ledger points at them); freeze those instead. */
export function deleteAgent(id: string): boolean {
  const used = db().prepare("SELECT 1 FROM ledger WHERE agent_id = ? LIMIT 1").get(id);
  if (used) throw new Error("This agent has history in the ledger. Freeze it instead; its record stays.");
  return db().prepare("DELETE FROM agents WHERE id = ?").run(id).changes === 1;
}

export function setAgentStatus(id: string, status: Agent["status"], explanation?: unknown) {
  const at = nowIso();
  const reason = status === "frozen" ? JSON.stringify(explanation ?? { check: "owner_freeze", evidence: { at, changed_by: ctx().actor.name }, next_step: "Review the agent, then unfreeze it on the Agents page." }) : null;
  return db().prepare("UPDATE agents SET status = ?, status_changed_at = ?, freeze_explanation = ? WHERE id = ?").run(status, at, reason, id).changes === 1;
}

/** Money this agent moved (executed or approved) since a moment, for its own budget. */
export function agentSpent(id: string, sinceIso: string): number {
  const row = db().prepare(`SELECT COALESCE(SUM(COALESCE(approved_amount, amount)), 0) AS total FROM ledger
    WHERE agent_id = ? AND status IN ('executed', 'approved') AND COALESCE(decided_at, created_at) >= ?`).get(id, sinceIso) as any;
  return row.total;
}

// ---------------------------------------------------------------- temporary allowances
/**
 * "Let the agent pay this person on its own for N days, up to $X more." base_paid is what they had been paid in
 * the last 30 days when the allowance was given, so the allowance adds X on top of it.
 */
export type Grant = {
  id: number; kind: "payout"; counterparty: string; max_amount: number; base_paid: number; expires_at: string;
  created_by: string; created_at: string; ledger_id: number | null; revoked_at: string | null;
};

export function addGrant(g: { counterparty: string; maxAmount: number; days: number; createdBy: string; ledgerId?: number }): number {
  const expires = new Date(Date.now() + g.days * 86_400_000).toISOString();
  const base = paidToPayee(g.counterparty, 30).total;
  return Number(db().prepare("INSERT INTO grants (kind, counterparty, max_amount, base_paid, expires_at, created_by, created_at, ledger_id) VALUES ('payout', ?, ?, ?, ?, ?, ?, ?)")
    .run(g.counterparty.toLowerCase(), g.maxAmount, base, expires, g.createdBy, nowIso(), g.ledgerId ?? null).lastInsertRowid);
}

export function activeGrants(): Grant[] {
  return db().prepare("SELECT * FROM grants WHERE revoked_at IS NULL AND expires_at > ? ORDER BY id DESC").all(nowIso()) as any;
}

export function revokeGrant(id: number): boolean {
  return db().prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id).changes === 1;
}

// ---------------------------------------------------------------- workspace settings
export function setting<T>(key: string, fallback: T): T {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key: string, value: unknown) {
  db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

export type OrderRow = {
  invoice_id: string;
  customer_name: string;
  customer_email: string;
  order_id: string;
  capture_id: string;
  amount: number;
  items: string;
  tracking: string | null;
  created_at: string;
};

export function upsertOrder(o: OrderRow) {
  db().prepare(`INSERT OR REPLACE INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    o.invoice_id, o.customer_name, o.customer_email, o.order_id, o.capture_id, o.amount, o.items, o.tracking, o.created_at,
  );
}

export function ordersFor(email: string): OrderRow[] {
  return db().prepare("SELECT * FROM orders WHERE lower(customer_email) = lower(?) ORDER BY created_at DESC").all(email) as any;
}

export function orderByCapture(captureId: string): OrderRow | undefined {
  return db().prepare("SELECT * FROM orders WHERE capture_id = ?").get(captureId) as any;
}

export function allOrders(): OrderRow[] {
  return db().prepare("SELECT * FROM orders ORDER BY created_at DESC").all() as any;
}

export type Ticket = {
  id: string;
  /** "relay": a message an agent says it received, passed in over the API or MCP (never stored as a ticket). */
  channel: "email" | "task" | "relay";
  from_name: string;
  from_email: string;
  subject: string;
  body: string;
  received_at: string;
  status: "open" | "handled";
  reply: string | null;
  internal_note?: string | null;
  needs_follow_up?: number;
  reply_ledger_snapshot?: string | null;
  current_payment_snapshot?: string;
  reply_stale?: boolean;
  message_id?: string | null;
  external_id?: string | null;
  thread_references?: string | null;
  attachment_note?: string | null;
  reply_sent_at?: string | null;
  inbound_kind?: string | null;
  confirmation_link?: string | null;
  confirmation_code?: string | null;

};

export function upsertTicket(t: Omit<Ticket, "status" | "reply">) {
  db().prepare(`INSERT OR REPLACE INTO tickets (id, channel, from_name, from_email, subject, body, received_at, status, reply) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL)`).run(
    t.id, t.channel, t.from_name, t.from_email, t.subject, t.body, t.received_at,
  );
}

export function tickets(): Ticket[] {
  return (db().prepare("SELECT * FROM tickets ORDER BY received_at ASC").all() as unknown as Ticket[]).map(readTicketReply);
}

export function ticket(id: string): Ticket | undefined {
  const row = db().prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Ticket | undefined;
  return row ? readTicketReply(row) : undefined;
}

/** Older drafts sometimes mixed owner-only sections into customer text. */
export function splitTicketReply(reply: string | null) {
  const customer: string[] = [], internal: string[] = [];
  let ownerOnly = false;
  for (const line of (reply ?? "").split("\n")) {
    const heading = /^\s*(?:#{1,6}\s*)?(?:[-*]\s+)?(Owner(?:['’]s)? to[- ]do notes?|Internal notes?|Customer reply(?: draft)?|Reply to (?:the )?customer(?:\s*[—–-]\s*not sent)?)(?:\s*\([^\n)]*\))?(?:\s*[:—–-]\s*|\s*$)(.*)$/i.exec(line.replaceAll("**", ""));
    if (heading) {
      ownerOnly = /^(owner|internal)/i.test(heading[1]);
      if (heading[2]) (ownerOnly ? internal : customer).push(heading[2]);
    } else (ownerOnly ? internal : customer).push(line);
  }
  return { reply: customer.join("\n").trim(), internalNote: internal.join("\n").trim() };
}

export function ticketReplySnapshot(id: string): string {
  return JSON.stringify(db().prepare(`SELECT id, status, amount, approved_amount, currency, paypal_ref, decided_at, decline_reason
    FROM ledger WHERE ticket_id = ? ORDER BY id`).all(id));
}

function readTicketReply(row: Ticket): Ticket {
  const parts = splitTicketReply(row.reply);
  const current = ticketReplySnapshot(row.id);
  return { ...row, reply: row.reply === null ? null : parts.reply,
    internal_note: [row.internal_note, parts.internalNote].filter(Boolean).join("\n\n") || null,
    current_payment_snapshot: current,
    // Without a legacy snapshot, any recorded payment needs a fresh review.
    reply_stale: !!parts.reply && (row.reply_ledger_snapshot ?? "[]") !== current };
}

export function closeTicket(id: string, reply: string, options: { internalNote?: string; needsFollowUp?: boolean; snapshot?: string } = {}) {
  const parts = splitTicketReply(reply);
  db().prepare(`UPDATE tickets SET status = 'handled', reply = ?, internal_note = ?, needs_follow_up = ?,
    reply_ledger_snapshot = ?, reply_sent_at = NULL WHERE id = ?`).run(parts.reply,
    [options.internalNote, parts.internalNote].filter(Boolean).join("\n\n") || null,
    options.needsFollowUp ? 1 : 0, options.snapshot ?? ticketReplySnapshot(id), id);
}

/** Editing wording alone must not mark an older draft as current. */
export function saveTicketReply(id: string, reply: string, snapshot?: string) {
  const t = ticket(id);
  if (!t) throw new Error("No ticket reply to edit");
  const parts = splitTicketReply(reply);
  db().prepare(`UPDATE tickets SET reply = ?, internal_note = ?, reply_ledger_snapshot = ?,
    reply_sent_at = CASE WHEN reply = ? THEN reply_sent_at ELSE NULL END WHERE id = ?`).run(parts.reply,
    [t.internal_note, parts.internalNote].filter(Boolean).join("\n\n") || null,
    snapshot ?? t.reply_ledger_snapshot ?? null, parts.reply, id);
  return ticket(id)!;
}

export type LedgerStatus = "executed" | "awaiting_approval" | "executing" | "approved" | "declined" | "blocked" | "failed";

export type LedgerRow = {
  id: number;
  ticket_id: string | null;
  agent_id: string | null;
  facts: string | null;
  policy_id: number | null;
  approved_amount: number | null;
  tool: string;
  kind: string;
  params: string;
  currency: string;
  amount: number;
  counterparty: string | null;
  justification: string | null;
  decision: string;
  checks: string;
  review: string | null;
  status: LedgerStatus;
  paypal_ref: string | null;
  paypal_result: string | null;
  error: string | null;
  created_at: string;
  execution_started_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decline_reason: string | null;
  expires_at: string | null;
  reminded_at: string | null;
  idempotency_key: string | null;
  /** Where the request came from: "inbox" (the built-in agents), "api" or "mcp". */
  source: string | null;
};

export function recordProposal(p: {
  ticketId?: string;
  agentId?: string;
  facts?: unknown;
  policyId?: number;
  tool: string;
  kind: string;
  params: unknown;
  currency?: string;
  amount: number;
  counterparty?: string;
  justification?: string;
  decision: string;
  checks: Check[];
  review?: unknown;
  status: LedgerStatus;
  expiresAt?: string;
  idempotencyKey?: string;
  source?: string;
}): number {
  const r = db().prepare(`INSERT INTO ledger (ticket_id, agent_id, tool, kind, params, amount, counterparty, justification, decision, checks, review, status, created_at, facts, policy_id, expires_at, idempotency_key, source, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.ticketId ?? null, p.agentId ?? null, p.tool, p.kind, JSON.stringify(p.params), p.amount, p.counterparty ?? null, p.justification ?? null,
    p.decision, JSON.stringify(p.checks), p.review ? JSON.stringify(p.review) : null, p.status, nowIso(),
    p.facts === undefined ? null : JSON.stringify(p.facts), p.policyId ?? null, p.expiresAt ?? null, p.idempotencyKey ?? null, p.source ?? null, p.currency ?? "USD",
  );
  return Number(r.lastInsertRowid);
}

export function updateLedger(id: number, u: { status: LedgerStatus; paypalRef?: string; paypalResult?: unknown; error?: string; decidedBy?: string }) {
  db().prepare(`UPDATE ledger SET status = ?, paypal_ref = COALESCE(?, paypal_ref), paypal_result = COALESCE(?, paypal_result),
    error = ?, decided_by = COALESCE(?, decided_by), decided_at = CASE WHEN ? IS NOT NULL THEN ? ELSE decided_at END WHERE id = ?`).run(
    u.status, u.paypalRef ?? null, u.paypalResult ? JSON.stringify(u.paypalResult) : null, u.error ?? null,
    u.decidedBy ?? null, u.decidedBy ?? null, nowIso(), id,
  );
}

/** Moves an entry from one status to another only if it is still in the expected one (no double execution). */
export function transition(id: number, from: LedgerStatus, to: LedgerStatus): boolean {
  return db().prepare("UPDATE ledger SET status = ? WHERE id = ? AND status = ?").run(to, id, from).changes === 1;
}

export function setPaypalResult(id: number, result: unknown) {
  db().prepare("UPDATE ledger SET paypal_result = ? WHERE id = ?").run(JSON.stringify(result), id);
}

export function ledger(): LedgerRow[] {
  return db().prepare("SELECT * FROM ledger ORDER BY id DESC").all() as any;
}

/** Money moves checked since the start of this calendar month (UTC), for plan limits. */
export function actionsThisMonth(): number {
  const d = new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  return (db().prepare("SELECT COUNT(*) AS n FROM ledger WHERE created_at >= ?").get(start) as { n: number }).n;
}

export function ledgerByIdempotencyKey(agentId: string, key: string): LedgerRow | undefined {
  return db().prepare("SELECT * FROM ledger WHERE agent_id = ? AND idempotency_key = ?").get(agentId, key) as any;
}

export function setDeclineReason(id: number, reason: string) {
  db().prepare("UPDATE ledger SET decline_reason = ? WHERE id = ?").run(reason, id);
}

export function markReminded(id: number) {
  db().prepare("UPDATE ledger SET reminded_at = ? WHERE id = ?").run(nowIso(), id);
}

/** Held requests nobody answered in time. */
export function overdueRequests(): LedgerRow[] {
  return db().prepare("SELECT * FROM ledger WHERE status = 'awaiting_approval' AND expires_at IS NOT NULL AND expires_at <= ?").all(nowIso()) as any;
}

export function ledgerEntry(id: number): LedgerRow | undefined {
  return db().prepare("SELECT * FROM ledger WHERE id = ?").get(id) as any;
}

/** Money the agent actually moved (executed or approved), for rolling budgets. */
export function spendHistory(): Spend[] {
  const rows = db().prepare("SELECT kind, COALESCE(approved_amount, amount) AS amount, COALESCE(decided_at, created_at) AS at FROM ledger WHERE status IN ('executed', 'approved')").all() as any[];
  return rows.map((r) => ({ kind: r.kind, amount: r.amount, at: r.at }));
}

export function setApprovedAmount(id: number, amount: number) {
  db().prepare("UPDATE ledger SET approved_amount = ? WHERE id = ?").run(amount, id);
}

export function refundsToCustomer30d(email: string): number {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const row = db().prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind = 'refund' AND status IN ('executed', 'approved')
    AND lower(counterparty) = lower(?) AND COALESCE(decided_at, created_at) >= ?`).get(email, since) as any;
  return row.n;
}

export function paidToPayee(email: string, days: number): { total: number; amounts: { amount: number; at: string }[] } {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db().prepare(`SELECT COALESCE(approved_amount, amount) AS amount, COALESCE(decided_at, created_at) AS at FROM ledger WHERE kind = 'payout' AND status IN ('executed', 'approved')
    AND lower(counterparty) = lower(?) AND COALESCE(decided_at, created_at) >= ?`).all(email, since) as any[];
  return { total: rows.reduce((t, r) => t + r.amount, 0), amounts: rows };
}

/** Clears the sample shop. The audit log stays: it is append-only, and the reset itself is recorded there. */
export function resetDemo() {
  db().exec("DELETE FROM shadow_results; DELETE FROM shadow_policy; DELETE FROM ledger; DELETE FROM tickets; DELETE FROM policies; DELETE FROM orders; DELETE FROM agents; DELETE FROM grants; DELETE FROM incidents; DELETE FROM settings WHERE key LIKE 'learn.%';");
}
