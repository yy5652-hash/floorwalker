import type { Request, Response } from "express";
import { ctx } from "./context.ts";
import { db } from "./db.ts";

const sensitive = /secret|password|token|authorization|slack.*(?:url|webhook)|(?:api|private)[_-]?key|(?:key|secret)[_-]?hash/i;
// JSON columns can themselves contain credentials; apply the same filter within them.
export function withoutSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^v1\.[\w-]+\.[\w-]+\./.test(value)) return "[redacted]";
    try {
      if (/^\s*[\[{]/.test(value)) return withoutSecrets(JSON.parse(value));
    } catch { /* Preserve non-JSON text. */ }
    return value.replace(/https:\/\/hooks\.slack\.com\/[^\s"<>]+/g, "[redacted]");
  }
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive.test(key)).map(([key, v]) => [key, withoutSecrets(v)]));
  return value;
}

export function workspaceExport() {
  const d = db();
  // Read directly: the UI helpers deliberately cap rules versions and audit rows.
  const rows = (table: string) => d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const settings = Object.fromEntries((rows("settings") as { key: string; value: string }[])
    .filter((r) => !sensitive.test(r.key)).map((r) => [r.key, withoutSecrets(JSON.parse(r.value))]));
  return {
    workspace: { name: ctx().ws.name },
    rules: withoutSecrets(d.prepare("SELECT * FROM policies ORDER BY id DESC LIMIT 1").get() ?? null),
    rules_versions: withoutSecrets(rows("policies")),
    agents: withoutSecrets(rows("agents")),
    ledger: withoutSecrets(rows("ledger")),
    inbox: withoutSecrets(rows("tickets")),
    incidents: withoutSecrets(rows("incidents")),
    audit_log: withoutSecrets(rows("audit")),
    settings,
  };
}

export function downloadWorkspace(_req: Request, res: Response) {
  res.setHeader("Content-Disposition", 'attachment; filename="floorwalker-workspace.json"');
  res.setHeader("Cache-Control", "no-store");
  res.json(workspaceExport());
}
