// Workspace management for signed-in members: agents and their limits, agent keys, temporary allowances,
// the audit log and workspace settings (PayPal connection, approval expiry, step-up).
import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { audit, auditLog, verifyAudit } from "./audit.ts";
import { ctx } from "./context.ts";
import * as store from "./db.ts";
import { publish } from "./events.ts";
import { HttpError, handle, need } from "./http.ts";
import { createKey, listKeys, revokeKey, revokeKeysForAgent } from "./keys.ts";
import { verifyPayPalApp } from "./paypal/client.ts";
import { setWorkspacePayPal, workspaceRow } from "./workspaces.ts";

export const manage = Router();

const wsId = () => ctx().ws.id;
const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, z.prettifyError(r.error), "invalid_request");
  return r.data;
};

// ---------------------------------------------------------------- agents
const Controls = {
  max_per_action: z.number().positive().nullable().optional(),
  budget: z.number().positive().nullable().optional(),
  budget_period: z.enum(["day", "week", "month"]).nullable().optional(),
  payees: z.array(z.email()).max(200).nullable().optional(),
  expires_at: z.iso.datetime().nullable().optional(),
};
const AgentBody = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().max(200).default(""),
  can_refund: z.boolean().default(false),
  can_payout: z.boolean().default(false),
  ...Controls,
});

function applyControls(id: string, b: Partial<z.infer<typeof AgentBody>>) {
  const a = store.agent(id)!;
  store.setAgentControls(id, {
    max_per_action: b.max_per_action !== undefined ? b.max_per_action : a.max_per_action,
    budget: b.budget !== undefined ? b.budget : a.budget,
    budget_period: b.budget_period !== undefined ? b.budget_period : a.budget_period,
    payees: b.payees !== undefined ? b.payees : a.payees ? JSON.parse(a.payees) : null,
    expires_at: b.expires_at !== undefined ? b.expires_at : a.expires_at,
  });
}

manage.post("/agents", need({ agents: ["manage"] }), handle((req) => {
  const b = parse(AgentBody, req.body);
  const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";
  const id = `${slug}-${randomBytes(3).toString("hex")}`;
  store.upsertAgent({ id, name: b.name, role: b.role, can_refund: b.can_refund ? 1 : 0, can_payout: b.can_payout ? 1 : 0 });
  applyControls(id, b);
  audit("agent.created", id, b);
  return store.agent(id);
}));

manage.patch("/agents/:id", need({ agents: ["manage"] }), handle((req) => {
  const id = String(req.params.id);
  const a = store.agent(id);
  if (!a) throw new HttpError(404, "No such agent");
  const b = parse(AgentBody.partial(), req.body);
  store.upsertAgent({
    id, name: b.name ?? a.name, role: b.role ?? a.role,
    can_refund: b.can_refund === undefined ? a.can_refund : b.can_refund ? 1 : 0,
    can_payout: b.can_payout === undefined ? a.can_payout : b.can_payout ? 1 : 0,
  });
  applyControls(id, b);
  audit("agent.updated", id, b);
  return store.agent(id);
}));

manage.delete("/agents/:id", need({ agents: ["manage"] }), handle((req) => {
  const id = String(req.params.id);
  if (!store.deleteAgent(id)) throw new HttpError(404, "No such agent");
  revokeKeysForAgent(wsId(), id);
  audit("agent.deleted", id);
  return { ok: true };
}));

function setStatus(id: string, status: "active" | "frozen") {
  if (!store.setAgentStatus(id, status)) throw new HttpError(404, "No such agent");
  audit(status === "frozen" ? "agent.frozen" : "agent.unfrozen", id);
  publish(status === "frozen" ? "agent.frozen" : "agent.unfrozen", { id, object: "agent", status });
  return store.agent(id);
}

manage.post("/agents/:id/freeze", need({ agents: ["manage"] }), handle((req) => setStatus(String(req.params.id), "frozen")));
manage.post("/agents/:id/unfreeze", need({ agents: ["manage"] }), handle((req) => setStatus(String(req.params.id), "active")));

/** The kill switch: every agent stops moving money at once. */
manage.post("/agents/freeze-all", need({ agents: ["manage"] }), handle(() => {
  const active = store.agents().filter((a) => a.status === "active");
  for (const a of active) setStatus(a.id, "frozen");
  return { frozen: active.length };
}));

// ---------------------------------------------------------------- agent keys
manage.get("/keys", need({ developers: ["manage"] }), handle(() => listKeys(wsId())));

manage.post("/keys", need({ developers: ["manage"] }), handle((req) => {
  const b = parse(z.object({ agent_id: z.string(), name: z.string().trim().min(1).max(80), expires_in_days: z.number().int().min(1).max(365).optional() }), req.body);
  if (!store.agent(b.agent_id)) throw new HttpError(404, "No such agent");
  const out = createKey({ wsId: wsId(), agentId: b.agent_id, name: b.name, createdBy: req.me!.name, expiresInDays: b.expires_in_days });
  audit("key.created", out.key.id, { agent_id: b.agent_id, name: b.name, prefix: out.key.prefix });
  return out;
}));

manage.delete("/keys/:id", need({ developers: ["manage"] }), handle((req) => {
  if (!revokeKey(wsId(), String(req.params.id))) throw new HttpError(404, "No such key, or it is already revoked");
  audit("key.revoked", String(req.params.id));
  return { ok: true };
}));

// ---------------------------------------------------------------- temporary allowances
manage.get("/grants", handle(() => store.activeGrants()));

manage.delete("/grants/:id", need({ rules: ["update"] }), handle((req) => {
  if (!store.revokeGrant(Number(req.params.id))) throw new HttpError(404, "No such allowance");
  audit("grant.revoked", `grant_${req.params.id}`);
  return { ok: true };
}));

// ---------------------------------------------------------------- audit log
manage.get("/audit", handle((req) => auditLog({
  limit: Number(req.query.limit ?? 100), before: req.query.before ? Number(req.query.before) : undefined,
  action: typeof req.query.action === "string" ? req.query.action : undefined,
})));

manage.get("/audit/verify", handle(() => verifyAudit()));

manage.get("/audit.csv", (_req, res) => {
  const cell = (v: unknown) => (v == null ? "" : `"${String(v).replaceAll('"', '""')}"`);
  const rows = auditLog({ limit: 500 });
  const head = ["id", "at", "actor_kind", "actor_id", "actor_name", "on_behalf_of", "action", "target", "detail", "ip", "hash"];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="allowance-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([head.join(","), ...rows.map((r: any) => head.map((h) => cell(r[h])).join(","))].join("\n"));
});

// ---------------------------------------------------------------- settings
export const stepUpOver = () => store.setting<number>("step_up_over", 250);

function settingsView() {
  const w = workspaceRow(wsId())!;
  return {
    approval_ttl_hours: store.setting<number>("approval_ttl_hours", 72),
    step_up_over: stepUpOver(),
    reminder_after_minutes: store.setting<number>("reminder_after_minutes", 60),
    paypal: {
      connected: Boolean(ctx().ws.paypal),
      own: Boolean(w.paypal_client_id),
      client_id_hint: w.paypal_client_id ? `${w.paypal_client_id.slice(0, 6)}…${w.paypal_client_id.slice(-4)}` : null,
      verified_at: w.paypal_verified_at,
      app: w.paypal_merchant ? JSON.parse(w.paypal_merchant) : null,
    },
  };
}

manage.get("/settings", handle(() => settingsView()));

manage.patch("/settings", need({ organization: ["update"] }), handle((req) => {
  const b = parse(z.object({
    approval_ttl_hours: z.number().int().min(1).max(24 * 30).optional(),
    step_up_over: z.number().min(0).max(1_000_000).optional(),
    reminder_after_minutes: z.number().int().min(5).max(24 * 60).optional(),
  }), req.body);
  for (const [k, v] of Object.entries(b)) if (v !== undefined) store.setSetting(k, v);
  audit("settings.updated", null, b);
  return settingsView();
}));

/** Connects the workspace's own PayPal sandbox app after checking the credentials with PayPal. */
manage.post("/settings/paypal", need({ organization: ["update"] }), handle(async (req) => {
  const b = parse(z.object({ client_id: z.string().trim().min(10).max(200), client_secret: z.string().trim().min(10).max(200) }), req.body);
  const app = await verifyPayPalApp({ clientId: b.client_id, clientSecret: b.client_secret });
  setWorkspacePayPal(wsId(), { clientId: b.client_id, clientSecret: b.client_secret }, JSON.stringify(app));
  audit("paypal.connected", null, { client_id: `${b.client_id.slice(0, 6)}…${b.client_id.slice(-4)}`, app_id: app.appId, payouts: app.payouts });
  return { ...settingsView(), paypal: { ...settingsView().paypal, connected: true } };
}));

manage.delete("/settings/paypal", need({ organization: ["update"] }), handle(() => {
  setWorkspacePayPal(wsId(), null);
  audit("paypal.disconnected");
  return settingsView();
}));
