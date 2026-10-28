import { ctx } from "./context.ts";
import { sha256 } from "./crypto.ts";
import { db } from "./db.ts";

export type AuditRow = {
  id: number;
  at: string;
  actor_kind: string;
  actor_id: string;
  actor_name: string;
  on_behalf_of: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  prev_hash: string;
  hash: string;
};

const GENESIS = "0".repeat(64);

// The fields a row's hash covers, in a fixed order.
const body = (r: Omit<AuditRow, "id" | "prev_hash" | "hash">) =>
  JSON.stringify([r.at, r.actor_kind, r.actor_id, r.actor_name, r.on_behalf_of, r.action, r.target, r.detail, r.ip]);

/**
 * Appends one entry for the current actor. Each entry carries the hash of the one before it, so an edit
 * made outside Floorwalker (straight in the database file) breaks the chain and verifyAudit() shows where.
 */
export function audit(action: string, target?: string | number | null, detail?: unknown, as?: { kind: "agent"; id: string; name: string }) {
  const { actor } = ctx();
  const who = as ? { ...as, onBehalfOf: actor.kind === "user" ? actor.name : actor.onBehalfOf, ip: actor.ip } : actor;
  const d = db();
  const prev = (d.prepare("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined)?.hash ?? GENESIS;
  const row = {
    at: new Date().toISOString(),
    actor_kind: who.kind,
    actor_id: who.id,
    actor_name: who.name,
    on_behalf_of: who.onBehalfOf ?? null,
    action,
    target: target == null ? null : String(target),
    detail: detail === undefined ? null : JSON.stringify(detail),
    ip: who.ip ?? null,
  };
  d.prepare(`INSERT INTO audit (at, actor_kind, actor_id, actor_name, on_behalf_of, action, target, detail, ip, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.at, row.actor_kind, row.actor_id, row.actor_name, row.on_behalf_of, row.action, row.target, row.detail, row.ip, prev, sha256(prev + body(row)),
  );
}

export function auditLog(opts: { limit?: number; before?: number; action?: string } = {}): AuditRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.before) where.push("id < ?"), args.push(opts.before);
  if (opts.action) where.push("action LIKE ?"), args.push(`${opts.action}%`);
  return db().prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as any;
}

/** Recomputes the whole chain. */
export function verifyAudit(): { ok: boolean; entries: number; brokenAt?: number } {
  let prev = GENESIS;
  const rows = db().prepare("SELECT * FROM audit ORDER BY id").all() as AuditRow[];
  for (const r of rows) {
    if (r.prev_hash !== prev || sha256(prev + body(r)) !== r.hash) return { ok: false, entries: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}
