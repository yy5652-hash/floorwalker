import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";
const dir = mkdtempSync(join(tmpdir(), "floorwalker-launch-"));
process.env.FLOORWALKER_CORE_DB = join(dir, "core.db");
process.env.FLOORWALKER_DATA_DIR = dir;
process.env.FLOORWALKER_DB = ":memory:";
process.env.BETTER_AUTH_SECRET = "launch-account-test-secret-long-enough";
process.env.DEMO_POOL = "0";
process.env.BASE_URL = "http://localhost:3000";
const { auth, can } = await import("../server/auth.ts");
const { core, openWorkspace, workspaceRow, removeWorkspace } = await import("../server/workspaces.ts");
const { inWorkspace } = await import("../server/context.ts");
const store = await import("../server/db.ts");
const { downloadWorkspace } = await import("../server/account-export.ts");
const { health, healthEndpoint } = await import("../server/health.ts");
const { createKey } = await import("../server/keys.ts");
after(() => { core.close(); rmSync(dir, { recursive: true, force: true }); });

function response() {
  const result = { status: 200, body: undefined as any, headers: {} as Record<string, string> };
  const res = { status(code: number) { result.status = code; return this; }, setHeader(key: string, value: string) { result.headers[key] = value; return this; }, json(body: unknown) { result.body = body; return this; } } as unknown as Response;
  return { result, res };
}

test("delete-user requires password, removes sole-owner workspace, preserves shared workspace and ends every session", async () => {
  const password = "correct-password-123";
  const signed = await auth.api.signUpEmail({ body: { email: "delete@example.com", name: "Delete test", password } });
  const other = await auth.api.signUpEmail({ body: { email: "other@example.com", name: "Other owner", password } });
  const userId = signed.user.id;
  const sole = core.prepare("SELECT organizationId AS id FROM member WHERE userId = ?").get(userId) as { id: string };
  openWorkspace(sole.id);
  const shared = await auth.api.createOrganization({ body: { name: "Shared", slug: "shared-test", userId } });
  assert.ok(shared);
  core.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)").run("second-owner", shared.id, other.user.id, "viewer,owner", new Date().toISOString());
  const signIn = async () => {
    const res = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: signed.user.email, password }) }));
    assert.equal(res.status, 200);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  };
  const cookie = await signIn();
  const otherCookie = await signIn();
  const revokedCookie = await signIn();
  const headers = new Headers({ cookie });
  const sessions = await auth.api.listSessions({ headers });
  assert.ok(sessions.length >= 3);
  const revokedSession = await auth.api.getSession({ headers: new Headers({ cookie: revokedCookie }) });
  assert.ok(revokedSession);
  await auth.api.revokeSession({ headers, body: { token: revokedSession.session.token } });
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: revokedCookie }) }), null);
  assert.ok(await auth.api.getSession({ headers }));
  core.prepare(`INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("test-passkey", "Laptop", "public", userId, "credential-id", 0, "singleDevice", 0, Date.now());
  const deletion = (body: object) => auth.handler(new Request("http://localhost:3000/api/auth/delete-user", { method: "POST", headers: { cookie, origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await deletion({})).status, 400);
  assert.equal((await deletion({ password: "wrong-password" })).status, 400);
  assert.ok(workspaceRow(sole.id));
  assert.equal((await deletion({ password })).status, 200);
  assert.equal(workspaceRow(sole.id), undefined);
  assert.equal(existsSync(join(dir, `${sole.id}.db`)), false);
  assert.ok(workspaceRow(shared.id));
  assert.ok(core.prepare("SELECT 1 FROM member WHERE organizationId = ? AND userId = ?").get(shared.id, other.user.id));
  assert.equal(core.prepare("SELECT 1 FROM member WHERE userId = ?").get(userId), undefined);
  for (const table of ["user", "session", "passkey", "account"]) {
    assert.equal(core.prepare(`SELECT 1 FROM ${table} WHERE ${table === "user" ? "id" : "userId"} = ?`).get(userId), undefined);
  }
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: otherCookie }) }), null);
  removeWorkspace(shared.id);
});

test("owner export includes complete history and excludes credentials and hashes", async () => {
  const signed = await auth.api.signUpEmail({ body: { email: "export@example.com", name: "Export test", password: "export-password-123" } });
  const { id } = core.prepare("SELECT organizationId AS id FROM member WHERE userId = ?").get(signed.user.id) as { id: string };
  const ws = openWorkspace(id);
  const { secret } = createKey({ wsId: id, agentId: "bot", name: "Private key", createdBy: signed.user.id });
  inWorkspace(ws, { kind: "user", id: signed.user.id, name: "Export" }, () => {
    store.upsertAgent({ id: "bot", name: "Bot", role: "Support", can_refund: 1, can_payout: 0 });
    for (let n = 0; n < 25; n++) store.savePolicy(`Rules ${n}`, store.activePolicy().policy);
    store.setSetting("slack_webhook", "slack-secret-value");
    store.setSetting("paypal_client_secret", "paypal-secret-value");
    store.setSetting("webhook_secret", "webhook-secret-value");
    store.setSetting("custom", { nested: { client_secret: "nested-secret-value", visible: true } });
    store.setSetting("approval_ttl_hours", 72);
    const { result, res } = response();
    downloadWorkspace({} as Request, res);
    assert.match(result.headers["Content-Disposition"], /attachment/);
    const json = JSON.stringify(result.body);
    const keyHash = (core.prepare("SELECT hash FROM api_key WHERE ws_id = ?").get(id) as { hash: string }).hash;
    for (const forbidden of [secret, keyHash, "slack-secret-value", "paypal-secret-value", "webhook-secret-value", "nested-secret-value"]) assert.ok(!json.includes(forbidden));
    assert.ok(result.body.rules_versions.length >= 25);
    assert.equal(result.body.workspace.name, ws.name);
    assert.equal(result.body.agents.find((a: any) => a.id === "bot").name, "Bot");
    assert.equal(result.body.settings.approval_ttl_hours, 72);
    for (const key of ["ledger", "inbox", "incidents", "audit_log"]) assert.ok(Array.isArray(result.body[key]));
  });
  assert.equal(can("owner", { organization: ["delete"] }), true);
  for (const role of ["admin", "viewer", "approver"]) assert.equal(can(role, { organization: ["delete"] }), false);
  removeWorkspace(id);
});

test("healthz returns only public health fields and reports database failures", (t) => {
  const { result, res } = response();
  healthEndpoint({} as Request, res);
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ["core_db", "ok", "uptime_s", "version", "workspaces"]);
  assert.equal(result.body.core_db, "ok");
  assert.equal(result.body.workspaces, (core.prepare("SELECT COUNT(*) AS n FROM workspace").get() as { n: number }).n);
  const failed = health({ prepare() { throw new Error("private database path"); } } as any);
  assert.equal(failed.ok, false);
  assert.equal(failed.core_db, "error");
  assert.ok(!JSON.stringify(failed).includes("private"));
  t.mock.method(core, "prepare", () => { throw new Error("private database path"); });
  const unavailable = response();
  healthEndpoint({} as Request, unavailable.res);
  assert.equal(unavailable.result.status, 503);
  assert.deepEqual(unavailable.result.body, failed);
});
