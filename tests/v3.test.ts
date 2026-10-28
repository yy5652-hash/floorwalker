// Agent limits, idempotency, temporary allowances, expiry, the audit chain, agent keys and webhook signatures.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.FLOORWALKER_DB = ":memory:";
process.env.FLOORWALKER_CORE_DB = ":memory:";
process.env.ANTHROPIC_API_KEY = "test";
process.env.PAYPAL_CLIENT_ID = "test";
process.env.PAYPAL_CLIENT_SECRET = "test";
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret";

const store = await import("../server/db.ts");
const guard = await import("../server/guard/index.ts");
const { audit, auditLog, verifyAudit } = await import("../server/audit.ts");
const { DEFAULT_POLICY, DEFAULT_POLICY_TEXT } = await import("../server/guard/policy.ts");
const { createKey, revokeKey, verifyKey } = await import("../server/keys.ts");
const { seal, unseal, sha256 } = await import("../server/crypto.ts");
const { core } = await import("../server/workspaces.ts");

const capture = {
  id: "CAP1", status: "COMPLETED", amount: { value: "94.00" }, create_time: new Date().toISOString(),
  links: [{ rel: "up", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD1" }],
};
const order = {
  id: "ORD1", payer: { email_address: "maya.chen@example.com" },
  purchase_units: [{ invoice_id: "JO-1", items: [{ name: "Speckled Mug", quantity: "2", unit_amount: { value: "24.00" } }], payments: { refunds: [] } }],
};
const email: import("../server/db.ts").Ticket = {
  id: "T1", channel: "email", from_name: "Maya Chen", from_email: "maya.chen@example.com", subject: "Chipped mug",
  body: "One mug arrived chipped, please refund it.", received_at: new Date().toISOString(), status: "open", reply: null,
};
const todo: import("../server/db.ts").Ticket = { ...email, id: "T3", channel: "task", from_name: "Owner", from_email: "owner@example.com", body: "Pay the new cleaner." };
const refund = (value: string) => ({ capture_id: "CAP1", amount: { currency_code: "USD", value } });

let paypalCalls: string[] = [];

beforeEach(() => {
  store.resetDemo();
  store.savePolicy(DEFAULT_POLICY_TEXT, DEFAULT_POLICY);
  store.upsertAgent({ id: "bot", name: "Helpdesk bot", role: "refunds", can_refund: 1, can_payout: 1 });
  paypalCalls = [];
  guard.deps.getCapture = async () => capture;
  guard.deps.getOrder = async () => order;
  guard.deps.reviewAction = async () => ({ verdict: "approve" as const, matches_request: true, injection_detected: false, concerns: [], summary: "Fine.", cited_rule: "" });
  guard.deps.callToolkit = async (name: string, input: any) => {
    paypalCalls.push(`${name}:${input.amount?.value}`);
    return { id: `REF${paypalCalls.length}`, status: "COMPLETED", amount: input.amount };
  };
  guard.deps.sendPayout = (async (p: any) => {
    paypalCalls.push(`payout:${p.email}:${p.amount.value}`);
    return { batch_header: { payout_batch_id: `B${paypalCalls.length}`, batch_status: "PENDING" } };
  }) as any;
});

const checksOf = (id: number) => JSON.parse(store.ledgerEntry(id)!.checks) as { id: string; outcome: string }[];

test("an agent's own cap per action sends a refund the workspace rules would allow to the owner", async () => {
  store.setAgentControls("bot", { max_per_action: 15, budget: null, budget_period: null, payees: null, expires_at: null });
  const out = await guard.guard("create_refund", refund("20.00"), { ticket: email, agentId: "bot", justification: "x" });
  assert.equal(out.row.status, "awaiting_approval");
  assert.ok(checksOf(out.row.id).some((c) => c.id === "agent_cap" && c.outcome === "hold"));
  assert.equal(paypalCalls.length, 0);
});

test("an agent's own budget counts what it already moved", async () => {
  store.setAgentControls("bot", { max_per_action: null, budget: 30, budget_period: "week", payees: null, expires_at: null });
  const first = await guard.guard("create_refund", refund("20.00"), { ticket: email, agentId: "bot", justification: "x" });
  assert.equal(first.row.status, "executed");
  const second = await guard.guard("create_refund", refund("20.00"), { ticket: email, agentId: "bot", justification: "x" });
  assert.equal(second.row.status, "awaiting_approval");
  assert.ok(checksOf(second.row.id).some((c) => c.id === "agent_budget" && c.outcome === "hold"));
});

test("an expired agent and a payee outside the agent's list are blocked", async () => {
  store.setAgentControls("bot", { max_per_action: null, budget: null, budget_period: null, payees: ["priya.shah@example.com"], expires_at: null });
  const off = await guard.guard("send_payout", { email: "sam.rivera@example.com", amount: 20, note: "x" }, { ticket: todo, agentId: "bot", justification: "x" });
  assert.equal(off.row.status, "blocked");
  store.setAgentControls("bot", { max_per_action: null, budget: null, budget_period: null, payees: null, expires_at: new Date(Date.now() - 1000).toISOString() });
  const expired = await guard.guard("create_refund", refund("10.00"), { ticket: email, agentId: "bot", justification: "x" });
  assert.equal(expired.row.status, "blocked");
  assert.equal(paypalCalls.length, 0);
});

test("a retried call with the same idempotency key returns the first result and pays once", async () => {
  const a = await guard.guard("create_refund", refund("10.00"), { ticket: email, agentId: "bot", justification: "x", idempotencyKey: "k-1" });
  const b = await guard.guard("create_refund", refund("10.00"), { ticket: email, agentId: "bot", justification: "x", idempotencyKey: "k-1" });
  assert.equal(a.row.id, b.row.id);
  assert.equal(paypalCalls.length, 1);
  assert.equal(store.ledger().length, 1);
});

test("approving a payout with a temporary allowance lets the agent pay that person alone, until it is revoked", async () => {
  const p = structuredClone(DEFAULT_POLICY);
  p.payouts.unknown_payee = "ask";
  store.savePolicy("ask about new people", p);
  const ask = await guard.guard("send_payout", { email: "new.cleaner@example.com", amount: 30, note: "Windows" }, { ticket: todo, agentId: "bot", justification: "Owner's to-do" });
  assert.equal(ask.row.status, "awaiting_approval");
  await guard.approve(ask.row.id, "Owner", { allowPayeeDays: 7 });
  const [grant] = store.activeGrants();
  assert.equal(grant.counterparty, "new.cleaner@example.com");
  // A different amount: the same amount to the same person within a day is held as a possible duplicate.
  const again = await guard.guard("send_payout", { email: "new.cleaner@example.com", amount: 25, note: "Windows" }, { ticket: todo, agentId: "bot", justification: "Owner's to-do" });
  assert.equal(again.row.status, "executed");
  store.revokeGrant(grant.id);
  const after = await guard.guard("send_payout", { email: "new.cleaner@example.com", amount: 10, note: "Windows" }, { ticket: todo, agentId: "bot", justification: "Owner's to-do" });
  assert.equal(after.row.status, "awaiting_approval");
  assert.deepEqual(paypalCalls, ["payout:new.cleaner@example.com:30.00", "payout:new.cleaner@example.com:25.00"]);
});

test("a held request nobody answers in time is declined, never executed", async () => {
  const out = await guard.guard("create_refund", refund("86.00"), { ticket: email, agentId: "bot", justification: "x" });
  assert.ok(out.row.expires_at);
  store.db().prepare("UPDATE ledger SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), out.row.id);
  assert.equal(guard.expireOverdue(), 1);
  const row = store.ledgerEntry(out.row.id)!;
  assert.equal(row.status, "declined");
  assert.match(row.decline_reason ?? "", /automatically/);
  await assert.rejects(guard.approve(row.id, "Owner"), /not awaiting approval/);
  assert.equal(paypalCalls.length, 0);
});

test("a decline keeps its reason", async () => {
  const out = await guard.guard("create_refund", refund("86.00"), { ticket: email, agentId: "bot", justification: "x" });
  guard.declineRequest(out.row.id, "Owner", "Offer an exchange instead");
  assert.equal(store.ledgerEntry(out.row.id)!.decline_reason, "Offer an exchange instead");
});

test("the audit log records agents and people, is hash-chained, and refuses edits", async () => {
  await guard.guard("create_refund", refund("10.00"), { ticket: email, agentId: "bot", justification: "x" });
  audit("rules.updated", "rules_v2", { text: "new" });
  // The log outlives demo resets, so earlier tests' entries are there too; look at the last three.
  const rows = auditLog({ limit: 3 });
  assert.deepEqual(rows.map((r) => r.action).reverse(), ["action.allowed", "action.executed", "rules.updated"]);
  assert.equal(rows.at(-1)!.actor_kind, "agent");
  assert.equal(rows[0].actor_kind, "system");
  assert.equal(verifyAudit().ok, true);
  assert.throws(() => store.db().prepare("UPDATE audit SET actor_name = 'someone else' WHERE id = 1").run(), /append-only/);
  assert.throws(() => store.db().prepare("DELETE FROM audit").run(), /append-only/);
});

test("agent keys are shown once, stored as hashes, and stop working when revoked", () => {
  const { secret, key } = createKey({ wsId: "ws_test_1", agentId: "bot", name: "prod", createdBy: "Owner" });
  assert.match(secret, /^fw_[A-Za-z0-9_-]{32}$/);
  assert.equal(key.prefix, secret.slice(0, 12));
  assert.equal(key.prefix.length, 12);
  assert.equal(verifyKey(secret)?.id, key.id);
  assert.equal(verifyKey(`${secret.slice(0, -1)}x`), undefined);
  assert.ok(revokeKey("ws_test_1", key.id));
  assert.equal(verifyKey(secret), undefined);
});

test("previously issued agent keys retain their display prefix, verification and revocation", () => {
  const secret = `alw_${"a".repeat(32)}`;
  core.prepare("INSERT INTO api_key (id, ws_id, agent_id, name, prefix, hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("key_legacy", "ws_test_1", "bot", "legacy", secret.slice(0, 12), sha256(secret), "Owner", new Date().toISOString());
  const key = verifyKey(secret);
  assert.equal(key?.id, "key_legacy");
  assert.equal(key?.prefix, secret.slice(0, 12));
  assert.equal(key?.prefix.length, 12);
  assert.equal(verifyKey(`fw_${"a".repeat(32)}`), undefined);
  assert.ok(revokeKey("ws_test_1", "key_legacy"));
  assert.equal(verifyKey(secret), undefined);
});

test("sealed secrets round-trip and can't be opened for another purpose", () => {
  const s = seal("client-secret-value");
  assert.notEqual(s, "client-secret-value");
  assert.equal(unseal(s), "client-secret-value");
  assert.throws(() => unseal(s, "slack"));
});
