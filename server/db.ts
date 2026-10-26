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
`;

/** Opens (and creates or upgrades) one workspace's database. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const d = new DatabaseSync(path);
  d.exec(SCHEMA);
  // Columns added after the first release; older databases get them here.
  const ledgerCols = new Set((d.prepare("PRAGMA table_info(ledger)").all() as any[]).map((c) => c.name));
  for (const [col, type] of [["agent_id", "TEXT"], ["facts", "TEXT"], ["policy_id", "INTEGER"], ["approved_amount", "REAL"]] as const) {
    if (!ledgerCols.has(col)) d.exec(`ALTER TABLE ledger ADD COLUMN ${col} ${type}`);
  }
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
  const r = db().prepare("INSERT INTO policies (text, json, created_at) VALUES (?, ?, ?)").run(text, JSON.stringify(policy), nowIso());
  return { id: Number(r.lastInsertRowid), text, policy };
}

export function policyVersions(): { id: number; text: string; policy: Policy; created_at: string }[] {
  return (db().prepare("SELECT id, text, json, created_at FROM policies ORDER BY id DESC LIMIT 20").all() as any[])
    .map((r) => ({ id: r.id, text: r.text, policy: JSON.parse(r.json), created_at: r.created_at }));
}

export function policyVersion(id: number) {
  return policyVersions().find((v) => v.id === id);
}

// ---------------------------------------------------------------- agents
export type Agent = { id: string; name: string; role: string; can_refund: number; can_payout: number; status: "active" | "frozen"; status_changed_at: string | null };

export function agents(): Agent[] {
  return db().prepare("SELECT * FROM agents ORDER BY rowid").all() as any;
}

export function agent(id: string): Agent | undefined {
  return db().prepare("SELECT * FROM agents WHERE id = ?").get(id) as any;
}

export function upsertAgent(a: Omit<Agent, "status" | "status_changed_at">) {
  db().prepare(`INSERT INTO agents (id, name, role, can_refund, can_payout) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, can_refund = excluded.can_refund, can_payout = excluded.can_payout`)
    .run(a.id, a.name, a.role, a.can_refund, a.can_payout);
}

export function setAgentStatus(id: string, status: Agent["status"]) {
  return db().prepare("UPDATE agents SET status = ?, status_changed_at = ? WHERE id = ?").run(status, nowIso(), id).changes === 1;
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
  channel: "email" | "task";
  from_name: string;
  from_email: string;
  subject: string;
  body: string;
  received_at: string;
  status: "open" | "handled";
  reply: string | null;
};

export function upsertTicket(t: Omit<Ticket, "status" | "reply">) {
  db().prepare(`INSERT OR REPLACE INTO tickets (id, channel, from_name, from_email, subject, body, received_at, status, reply) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL)`).run(
    t.id, t.channel, t.from_name, t.from_email, t.subject, t.body, t.received_at,
  );
}

export function tickets(): Ticket[] {
  return db().prepare("SELECT * FROM tickets ORDER BY received_at ASC").all() as any;
}

export function ticket(id: string): Ticket | undefined {
  return db().prepare("SELECT * FROM tickets WHERE id = ?").get(id) as any;
}

export function closeTicket(id: string, reply: string) {
  db().prepare("UPDATE tickets SET status = 'handled', reply = ? WHERE id = ?").run(reply, id);
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
  decided_at: string | null;
  decided_by: string | null;
};

export function recordProposal(p: {
  ticketId?: string;
  agentId?: string;
  facts?: unknown;
  policyId?: number;
  tool: string;
  kind: string;
  params: unknown;
  amount: number;
  counterparty?: string;
  justification?: string;
  decision: string;
  checks: Check[];
  review?: unknown;
  status: LedgerStatus;
}): number {
  const r = db().prepare(`INSERT INTO ledger (ticket_id, agent_id, tool, kind, params, amount, counterparty, justification, decision, checks, review, status, created_at, facts, policy_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    p.ticketId ?? null, p.agentId ?? null, p.tool, p.kind, JSON.stringify(p.params), p.amount, p.counterparty ?? null, p.justification ?? null,
    p.decision, JSON.stringify(p.checks), p.review ? JSON.stringify(p.review) : null, p.status, nowIso(),
    p.facts === undefined ? null : JSON.stringify(p.facts), p.policyId ?? null,
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

export function resetDemo() {
  db().exec("DELETE FROM ledger; DELETE FROM tickets; DELETE FROM policies; DELETE FROM orders; DELETE FROM agents;");
}
