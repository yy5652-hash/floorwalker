import { randomBytes } from "node:crypto";
import { sha256 } from "./crypto.ts";
import { core } from "./workspaces.ts";

core.exec(`
CREATE TABLE IF NOT EXISTS api_key (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS api_key_ws ON api_key (ws_id);
`);

export type ApiKey = {
  id: string;
  ws_id: string;
  agent_id: string;
  name: string;
  prefix: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

const COLUMNS = "id, ws_id, agent_id, name, prefix, created_by, created_at, expires_at, last_used_at, revoked_at";

/** A new key for one agent. The secret is returned once; only its hash is kept. */
export function createKey(o: { wsId: string; agentId: string; name: string; createdBy: string; expiresInDays?: number }): { secret: string; key: ApiKey } {
  const secret = `alw_${randomBytes(24).toString("base64url")}`;
  const id = `key_${randomBytes(8).toString("hex")}`;
  const expires = o.expiresInDays ? new Date(Date.now() + o.expiresInDays * 86_400_000).toISOString() : null;
  core.prepare("INSERT INTO api_key (id, ws_id, agent_id, name, prefix, hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, o.wsId, o.agentId, o.name.slice(0, 80), secret.slice(0, 12), sha256(secret), o.createdBy, new Date().toISOString(), expires);
  return { secret, key: keyById(o.wsId, id)! };
}

export function keyById(wsId: string, id: string): ApiKey | undefined {
  return core.prepare(`SELECT ${COLUMNS} FROM api_key WHERE ws_id = ? AND id = ?`).get(wsId, id) as any;
}

export function listKeys(wsId: string): ApiKey[] {
  return core.prepare(`SELECT ${COLUMNS} FROM api_key WHERE ws_id = ? ORDER BY created_at DESC`).all(wsId) as any;
}

export function revokeKey(wsId: string, id: string): boolean {
  return core.prepare("UPDATE api_key SET revoked_at = ? WHERE ws_id = ? AND id = ? AND revoked_at IS NULL").run(new Date().toISOString(), wsId, id).changes === 1;
}

export function revokeKeysForAgent(wsId: string, agentId: string): number {
  return Number(core.prepare("UPDATE api_key SET revoked_at = ? WHERE ws_id = ? AND agent_id = ? AND revoked_at IS NULL").run(new Date().toISOString(), wsId, agentId).changes);
}

/** The live key for a presented secret, or undefined (unknown, revoked or expired). */
export function verifyKey(secret: string): ApiKey | undefined {
  if (!/^alw_[A-Za-z0-9_-]{32}$/.test(secret)) return undefined;
  const key = core.prepare(`SELECT ${COLUMNS} FROM api_key WHERE hash = ?`).get(sha256(secret)) as ApiKey | undefined;
  if (!key || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= Date.now())) return undefined;
  // Last use is shown to the owner; minute precision is plenty and saves a write per call.
  if (!key.last_used_at || Date.now() - Date.parse(key.last_used_at) > 60_000) {
    core.prepare("UPDATE api_key SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), key.id);
  }
  return key;
}
