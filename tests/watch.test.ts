// Money that moved in PayPal without Floorwalker: matched against the ledger, raised once, agents frozen and restored.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.FLOORWALKER_DB = ":memory:";
process.env.FLOORWALKER_CORE_DB = ":memory:";
process.env.PAYPAL_CLIENT_ID = "watch-test";
process.env.PAYPAL_CLIENT_SECRET = "watch-test";

const store = await import("../server/db.ts");
const { DEMO_AGENTS } = await import("../server/demo.ts");
const { handlePayPalEvent, incidents, resolveIncident, sweepOrders } = await import("../server/watch.ts");

const refundEvent = (id: string, captureId: string, value = "25.00") => ({
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource: { id, amount: { value }, links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}` }] },
});

beforeEach(() => {
  store.resetDemo();
  DEMO_AGENTS.forEach(store.upsertAgent);
  store.upsertOrder({
    invoice_id: "JO-T-1", customer_name: "Maya Chen", customer_email: "maya.chen@example.com", order_id: "ORD1", capture_id: "CAP1",
    amount: 94, items: "[]", tracking: "{}", created_at: new Date().toISOString(),
  });
});

test("a failed PayPal read is attempted but not checked, and the sweep coverage is stored", async (t) => {
  store.upsertOrder({
    invoice_id: "JO-T-2", customer_name: "Sam", customer_email: "sam@example.com", order_id: "ORD2", capture_id: "CAP2",
    amount: 50, items: "[]", tracking: "{}", created_at: new Date().toISOString(),
  });
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/oauth2/token") return Response.json({ access_token: "stub", expires_in: 300 });
    reads.push(path);
    if (path === "/v2/checkout/orders/ORD2") throw new Error("PayPal unavailable");
    assert.equal(path, "/v2/checkout/orders/ORD1");
    return Response.json({ purchase_units: [{ payments: { refunds: [{ id: "REF-SWEEP", status: "COMPLETED", amount: { value: "25.00" } }] } }] });
  });
  const before = Date.now();
  const result = await sweepOrders();
  assert.equal(reads.length, 2);
  assert.equal(result.attempted, 2);
  assert.equal(result.checked, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.orders, result.checked);
  assert.equal(result.refunds, 1);
  assert.equal(result.incidents.length, 1);
  assert.ok(Date.parse(result.at) >= before && Date.parse(result.at) <= Date.now());
  const { incidents: found, ...coverage } = result;
  assert.deepEqual(store.setting("watch.last_sweep", null), coverage);
});

test("a successful sweep reports complete coverage", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown) => Response.json(String(url).endsWith("/v1/oauth2/token")
    ? { access_token: "stub", expires_in: 300 } : { purchase_units: [] }));
  const result = await sweepOrders();
  assert.equal(result.attempted, 1);
  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.orders, 1);
  assert.equal(result.refunds, 0);
});

test("a failed sweep reports zero checked orders", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: unknown) => {
    if (String(url).endsWith("/v1/oauth2/token")) return Response.json({ access_token: "stub", expires_in: 300 });
    throw new Error("PayPal unavailable");
  });
  const result = await sweepOrders();
  assert.equal(result.attempted, 1);
  assert.equal(result.checked, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.orders, 0);
  assert.equal(result.refunds, 0);
  assert.deepEqual(result.incidents, []);
});

test("a sweep with no recent orders attempts no PayPal reads", async (t) => {
  store.db().exec("DELETE FROM orders");
  store.upsertOrder({
    invoice_id: "JO-OLD", customer_name: "Sam", customer_email: "sam@example.com", order_id: "OLD", capture_id: "OLD-CAP",
    amount: 50, items: "[]", tracking: "{}", created_at: new Date(Date.now() - 181 * 86_400_000).toISOString(),
  });
  t.mock.method(globalThis, "fetch", async () => { assert.fail("No recent orders to read"); });
  const result = await sweepOrders();
  assert.equal(result.attempted, 0);
  assert.equal(result.checked, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.orders, 0);
  assert.equal(result.refunds, 0);
});

test("a refund Floorwalker made is matched and raises nothing", () => {
  const id = store.recordProposal({ tool: "create_refund", kind: "refund", params: { kind: "refund", captureId: "CAP1", amount: 24 }, amount: 24, counterparty: "maya.chen@example.com", decision: "allow", checks: [], status: "executing" } as any);
  store.updateLedger(id, { status: "executed", paypalRef: "REF-OURS" });
  assert.deepEqual(handlePayPalEvent(refundEvent("REF-OURS", "CAP1")), { matched: true, incident: null });
  assert.equal(incidents().length, 0);
});

test("a refund nobody can account for opens one incident and freezes every agent", () => {
  const out = handlePayPalEvent(refundEvent("REF-DIRECT", "CAP1"));
  assert.equal(out.matched, false);
  assert.ok(out.incident);
  assert.equal(out.incident.amount, 25);
  assert.equal(out.incident.counterparty, "maya.chen@example.com");
  assert.ok(store.agents().every((a) => a.status === "frozen"));
  // The same event delivered again (PayPal retries) does not open a second incident.
  assert.equal(handlePayPalEvent(refundEvent("REF-DIRECT", "CAP1")).incident, null);
  assert.equal(incidents().length, 1);
});

test("'that was me' runs the agents it froze again; 'not me' keeps them frozen", () => {
  const first = handlePayPalEvent(refundEvent("REF-A", "CAP1")).incident!;
  resolveIncident(first.id, "Elena", "mine");
  assert.ok(store.agents().every((a) => a.status === "active"));
  const second = handlePayPalEvent(refundEvent("REF-B", "CAP1")).incident!;
  resolveIncident(second.id, "Elena", "not_mine");
  assert.ok(store.agents().every((a) => a.status === "frozen"));
});

test("freezing can be turned off", () => {
  store.setSetting("incident_freeze", false);
  assert.ok(handlePayPalEvent(refundEvent("REF-C", "CAP1")).incident);
  assert.ok(store.agents().every((a) => a.status === "active"));
});

test("payout events update the ledger's payout and unknown batches open an incident", () => {
  const id = store.recordProposal({ tool: "send_payout", kind: "payout", params: { kind: "payout", email: "sam@example.com", amount: 40, note: "" }, amount: 40, counterparty: "sam@example.com", decision: "allow", checks: [], status: "executing" } as any);
  store.updateLedger(id, { status: "executed", paypalRef: "BATCH-OURS" });
  assert.equal(handlePayPalEvent({ event_type: "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", resource: { payout_batch_id: "BATCH-OURS", transaction_status: "UNCLAIMED" } }).matched, true);
  assert.equal(JSON.parse(store.ledgerEntry(id)!.paypal_result!).webhook_status, "UNCLAIMED");
  const out = handlePayPalEvent({ event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS", resource: { batch_header: { payout_batch_id: "BATCH-X", amount: { value: "150.00" } } } });
  assert.equal(out.incident?.kind, "payout");
});
