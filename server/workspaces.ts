import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import type { PayPalCreds, Workspace } from "./context.ts";
import { seal, unseal } from "./crypto.ts";
import { openDb } from "./db.ts";

if (config.coreDbPath !== ":memory:") mkdirSync(dirname(config.coreDbPath), { recursive: true });

/**
 * The core database: better-auth's tables (user, session, organization, member, invitation, passkey)
 * plus Allowance's own per-workspace settings. A workspace is a better-auth organization.
 */
export const core = new DatabaseSync(config.coreDbPath);

core.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  demo INTEGER NOT NULL DEFAULT 0,
  paypal_client_id TEXT,
  paypal_secret TEXT,
  paypal_verified_at TEXT,
  paypal_merchant TEXT,
  seed_status TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  subscription_id TEXT,
  subscription_status TEXT,
  created_by_ip TEXT,
  created_at TEXT NOT NULL
);
`);

export type WorkspaceRow = {
  id: string;
  demo: number;
  paypal_client_id: string | null;
  paypal_secret: string | null;
  paypal_verified_at: string | null;
  paypal_merchant: string | null;
  seed_status: string | null;
  plan: "free" | "pro" | "business";
  subscription_id: string | null;
  subscription_status: string | null;
  created_by_ip: string | null;
  created_at: string;
};

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const handles = new Map<string, DatabaseSync>();

export function workspaceRow(id: string): WorkspaceRow | undefined {
  return core.prepare("SELECT * FROM workspace WHERE id = ?").get(id) as any;
}

export function registerWorkspace(id: string, opts: { demo: boolean; ip?: string }) {
  if (!SAFE_ID.test(id)) throw new Error("Bad workspace id");
  core.prepare("INSERT OR IGNORE INTO workspace (id, demo, created_by_ip, created_at) VALUES (?, ?, ?, ?)")
    .run(id, opts.demo ? 1 : 0, opts.ip ?? null, new Date().toISOString());
}

/** Demo workspaces run on Allowance's own sandbox app; everyone else connects theirs. */
function credsFor(row: WorkspaceRow): PayPalCreds | null {
  if (row.paypal_client_id && row.paypal_secret) return { clientId: row.paypal_client_id, clientSecret: unseal(row.paypal_secret) };
  if (row.demo && config.paypal.clientId && config.paypal.clientSecret) return { clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret };
  return null;
}

export function openWorkspace(id: string): Workspace {
  const row = workspaceRow(id);
  if (!row || !SAFE_ID.test(id)) throw new Error("No such workspace");
  let db = handles.get(id);
  if (!db) handles.set(id, (db = openDb(join(config.dataDir, `${id}.db`))));
  const org = core.prepare("SELECT name FROM organization WHERE id = ?").get(id) as { name: string } | undefined;
  return { id, name: org?.name ?? "Workspace", db, paypal: credsFor(row), demo: Boolean(row.demo) };
}

/** Workspaces with an open database in this process (the ones in use since it started). */
export function openWorkspaces(): Workspace[] {
  return [...handles.keys()].flatMap((id) => (workspaceRow(id) ? [openWorkspace(id)] : []));
}

export function setWorkspacePayPal(id: string, creds: PayPalCreds | null, merchant?: string) {
  core.prepare("UPDATE workspace SET paypal_client_id = ?, paypal_secret = ?, paypal_verified_at = ?, paypal_merchant = ? WHERE id = ?").run(
    creds?.clientId ?? null, creds ? seal(creds.clientSecret) : null, creds ? new Date().toISOString() : null, merchant ?? null, id,
  );
}

export function setSeedStatus(id: string, status: string) {
  core.prepare("UPDATE workspace SET seed_status = ? WHERE id = ?").run(status, id);
}

export function setPlan(id: string, plan: WorkspaceRow["plan"], subscriptionId: string | null, status: string | null) {
  core.prepare("UPDATE workspace SET plan = ?, subscription_id = ?, subscription_status = ? WHERE id = ?").run(plan, subscriptionId, status, id);
}
