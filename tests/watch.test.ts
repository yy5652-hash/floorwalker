// Money that moved in PayPal without Floorwalker: matched against the ledger, raised once, agents frozen and restored.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.FLOORWALKER_DB = ":memory:";
process.env.FLOORWALKER_CORE_DB = ":memory:";

const store = await import("../server/db.ts");
const { DEMO_AGENTS } = await import("../server/demo.ts");
const { handlePayPalEvent, incidents, resolveIncident } = await import("../server/watch.ts");

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
