// Signed outbound webhooks (Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature headers),
// with a delivery log and retries. Endpoints and deliveries live in the core database so one worker
// covers every workspace, including ones nobody has opened since a restart.
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Webhook } from "standardwebhooks";
import { config } from "./config.ts";
import { seal, unseal } from "./crypto.ts";
import { subscribe, type AllowanceEvent } from "./events.ts";
import { core } from "./workspaces.ts";

core.exec(`
CREATE TABLE IF NOT EXISTS webhook_endpoint (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id TEXT PRIMARY KEY,
  ws_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS webhook_delivery_due ON webhook_delivery (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_delivery_endpoint ON webhook_delivery (endpoint_id, created_at);
`);

export type Endpoint = { id: string; ws_id: string; url: string; description: string | null; events: string[]; enabled: boolean; created_by: string; created_at: string };
export type Delivery = {
  id: string; endpoint_id: string; event_id: string; event_type: string; payload: string; status: "pending" | "succeeded" | "failed";
  attempts: number; next_attempt_at: string | null; last_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null;
};

const view = (r: any): Endpoint => ({ ...r, events: JSON.parse(r.events), enabled: Boolean(r.enabled), secret: undefined });

// Retries after 10 s, 1 min, 5 min, 30 min, 2 h and 6 h; then the delivery is marked failed.
const BACKOFF_S = [10, 60, 300, 1800, 7200, 21600];

/** Webhooks may only reach the public internet (no loopback, private or link-local addresses). */
export async function assertPublicUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That isn't a valid URL.");
  }
  const local = !config.production && ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("Webhook URLs must use https.");
  if (local) return;
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Can't resolve ${u.hostname}.`);
  for (const { address } of addrs) if (privateAddress(address)) throw new Error("Webhook URLs must point to a public address.");
}

function privateAddress(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
}

export async function createEndpoint(o: { wsId: string; url: string; description?: string; events: string[]; createdBy: string }) {
  await assertPublicUrl(o.url);
  const id = `we_${randomBytes(8).toString("hex")}`;
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  core.prepare("INSERT INTO webhook_endpoint (id, ws_id, url, description, secret, events, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, o.wsId, o.url, o.description ?? null, seal(secret, "webhook-secret"), JSON.stringify(o.events), o.createdBy, new Date().toISOString());
  return { endpoint: endpoint(o.wsId, id)!, secret };
}

export function endpoint(wsId: string, id: string): Endpoint | undefined {
  const r = core.prepare("SELECT * FROM webhook_endpoint WHERE ws_id = ? AND id = ?").get(wsId, id);
  return r ? view(r) : undefined;
}

export function endpoints(wsId: string): Endpoint[] {
  return (core.prepare("SELECT * FROM webhook_endpoint WHERE ws_id = ? ORDER BY created_at DESC").all(wsId) as any[]).map(view);
}

export function updateEndpoint(wsId: string, id: string, u: { enabled?: boolean; events?: string[]; description?: string }) {
  const e = endpoint(wsId, id);
  if (!e) return undefined;
  core.prepare("UPDATE webhook_endpoint SET enabled = ?, events = ?, description = ? WHERE id = ?")
    .run((u.enabled ?? e.enabled) ? 1 : 0, JSON.stringify(u.events ?? e.events), u.description ?? e.description, id);
  return endpoint(wsId, id);
}

export function deleteEndpoint(wsId: string, id: string): boolean {
  return core.prepare("DELETE FROM webhook_endpoint WHERE ws_id = ? AND id = ?").run(wsId, id).changes === 1;
}

/** The signing secret, for the owner to copy again. */
export function endpointSecret(wsId: string, id: string): string | undefined {
  const r = core.prepare("SELECT secret FROM webhook_endpoint WHERE ws_id = ? AND id = ?").get(wsId, id) as { secret: string } | undefined;
  return r ? unseal(r.secret, "webhook-secret") : undefined;
}

export function deliveries(wsId: string, endpointId: string, limit = 50): Delivery[] {
  return core.prepare("SELECT * FROM webhook_delivery WHERE ws_id = ? AND endpoint_id = ? ORDER BY created_at DESC LIMIT ?").all(wsId, endpointId, limit) as any;
}

function enqueue(e: AllowanceEvent, endpointId: string) {
  const body = JSON.stringify({ id: e.id, type: e.type, created_at: e.created_at, workspace_id: e.workspace_id, data: e.data });
  core.prepare(`INSERT INTO webhook_delivery (id, ws_id, endpoint_id, event_id, event_type, payload, status, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(`wd_${randomBytes(8).toString("hex")}`, e.workspace_id, endpointId, e.id, e.type, body, e.created_at, e.created_at);
}

/** Queues a test event to one endpoint. */
export function sendTest(wsId: string, endpointId: string) {
  enqueue({ id: `evt_test_${randomBytes(6).toString("hex")}`, type: "action.held" as any, workspace_id: wsId, created_at: new Date().toISOString(), data: { test: true, message: "A test event from Allowance." } }, endpointId);
  void work();
}

/** Sends a delivery again from scratch (after the receiver was fixed). */
export function redeliver(wsId: string, deliveryId: string): boolean {
  const ok = core.prepare("UPDATE webhook_delivery SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE ws_id = ? AND id = ?").run(new Date().toISOString(), wsId, deliveryId).changes === 1;
  if (ok) void work();
  return ok;
}

subscribe((e) => {
  const subs = endpoints(e.workspace_id).filter((x) => x.enabled && (x.events.includes("*") || x.events.includes(e.type)));
  for (const s of subs) enqueue(e, s.id);
  if (subs.length) void work();
});

let running = false;

/** Sends what is due. One pass at a time; the timer and new events both call it. */
export async function work() {
  if (running) return;
  running = true;
  try {
    const due = core.prepare("SELECT * FROM webhook_delivery WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20").all(new Date().toISOString()) as Delivery[];
    await Promise.all(due.map(attempt));
  } finally {
    running = false;
  }
}

async function attempt(d: Delivery) {
  const ep = core.prepare("SELECT * FROM webhook_endpoint WHERE id = ?").get(d.endpoint_id) as any;
  const done = (status: Delivery["status"], code: number | null, error: string | null) => {
    const attempts = d.attempts + 1;
    const retry = status === "pending" && attempts <= BACKOFF_S.length;
    core.prepare("UPDATE webhook_delivery SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?, delivered_at = ? WHERE id = ?").run(
      status === "pending" && !retry ? "failed" : status, attempts, code, error,
      retry ? new Date(Date.now() + BACKOFF_S[attempts - 1] * 1000).toISOString() : null,
      status === "succeeded" ? new Date().toISOString() : null, d.id,
    );
  };
  if (!ep || !ep.enabled) return done("failed", null, "Endpoint removed or disabled");
  try {
    await assertPublicUrl(ep.url);
    const now = new Date();
    const signature = new Webhook(unseal(ep.secret, "webhook-secret")).sign(d.event_id, now, d.payload);
    const res = await fetch(ep.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Allowance-Webhooks/1.0",
        "webhook-id": d.event_id,
        "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
        "webhook-signature": signature,
      },
      body: d.payload,
    });
    if (res.ok) return done("succeeded", res.status, null);
    done("pending", res.status, `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
  } catch (e: any) {
    done("pending", null, String(e.message ?? e).slice(0, 300));
  }
}

setInterval(() => void work(), 5_000).unref();
