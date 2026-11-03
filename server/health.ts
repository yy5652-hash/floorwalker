import type { Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { core } from "./workspaces.ts";
const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export function health(db: Pick<DatabaseSync, "prepare"> = core) {
  try {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM workspace").get() as { n: number };
    return { ok: true, version, uptime_s: Math.floor(process.uptime()), core_db: "ok" as const, workspaces: n };
  } catch {
    return { ok: false, version, uptime_s: Math.floor(process.uptime()), core_db: "error" as const, workspaces: 0 };
  }
}
export function healthEndpoint(_req: Request, res: Response) {
  const result = health();
  res.status(result.ok ? 200 : 503).json(result);
}
