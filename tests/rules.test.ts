import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, validatePolicy } from "../server/guard/policy.ts";
import { checkPayout, checkRefund, checkInvoice, decide, type RefundFacts, type Spend } from "../server/guard/rules.ts";

const now = new Date("2026-10-24T12:00:00Z");
const facts = (over: Partial<RefundFacts> = {}): RefundFacts => ({
  captureFound: true,
  captureStatus: "COMPLETED",
  capturedAmount: 38,
  refundedSoFar: 0,
  capturedAt: "2026-10-20T12:00:00Z",
  buyerEmail: "maya@example.com",
  requesterEmail: "maya@example.com",
  customerRefunds30d: 0,
  ...over,
});

test("small refund from the buyer is allowed", () => {
  const checks = checkRefund({ kind: "refund", captureId: "C1", amount: 24 }, facts(), DEFAULT_POLICY, [], now);
  assert.equal(decide(checks), "allow");
});

test("refund requested by someone other than the buyer is blocked", () => {
  const checks = checkRefund({ kind: "refund", captureId: "C1", amount: 24 }, facts({ requesterEmail: "x@evil.test" }), DEFAULT_POLICY, [], now);
  assert.equal(decide(checks), "block");
  assert.equal(checks.find((c) => c.id === "buyer")?.outcome, "block");
});

test("refund above the refundable balance is blocked", () => {
  const checks = checkRefund({ kind: "refund", captureId: "C1", amount: 30 }, facts({ refundedSoFar: 10 }), DEFAULT_POLICY, [], now);
  assert.equal(decide(checks), "block");
});

test("full refund defaults to the remaining balance", () => {
  const checks = checkRefund({ kind: "refund", captureId: "C1" }, facts({ capturedAmount: 148 }), DEFAULT_POLICY, [], now);
  assert.equal(decide(checks), "hold");
  assert.match(checks.find((c) => c.id === "auto_limit")!.detail, /\$148\.00/);
});

test("refund over the hard limit is blocked even though approval exists as an option", () => {
  const checks = checkRefund({ kind: "refund", captureId: "C1", amount: 300 }, facts({ capturedAmount: 400 }), DEFAULT_POLICY, [], now);
  assert.equal(decide(checks), "block");
});

test("weekly refund allowance counts earlier refunds", () => {
  const history: Spend[] = [
    { kind: "refund", amount: 40, at: "2026-10-22T09:00:00Z" },
    { kind: "refund", amount: 40, at: "2026-10-23T09:00:00Z" },
    { kind: "refund", amount: 40, at: "2026-10-10T09:00:00Z" }, // outside the 7-day window
  ];
  const checks = checkRefund({ kind: "refund", captureId: "C1", amount: 35 }, facts(), DEFAULT_POLICY, history, now);
  assert.equal(checks.find((c) => c.id === "budget")?.outcome, "pass");
  const more = checkRefund({ kind: "refund", captureId: "C1", amount: 38 }, facts(), DEFAULT_POLICY, [...history, { kind: "refund", amount: 10, at: "2026-10-24T08:00:00Z" }], now);
  assert.equal(more.find((c) => c.id === "budget")?.outcome, "hold");
});

test("old orders and repeat refunds need approval", () => {
  assert.equal(decide(checkRefund({ kind: "refund", captureId: "C1", amount: 10 }, facts({ capturedAt: "2026-07-01T00:00:00Z" }), DEFAULT_POLICY, [], now)), "hold");
  assert.equal(decide(checkRefund({ kind: "refund", captureId: "C1", amount: 10 }, facts({ customerRefunds30d: 1 }), DEFAULT_POLICY, [], now)), "hold");
});

test("payout to a known payee within limits is allowed", () => {
  const checks = checkPayout({ kind: "payout", email: "sam.rivera@example.com", amount: 35, note: "Windows, Tue" }, { paidToPayee30d: 0, samePayeeSameAmount24h: false }, DEFAULT_POLICY, [], now);
  assert.equal(decide(checks), "allow");
});

test("payout to a changed bank address is blocked", () => {
  const checks = checkPayout({ kind: "payout", email: "sam.rivera.payments@gmail.com", amount: 35, note: "" }, { paidToPayee30d: 0, samePayeeSameAmount24h: false }, DEFAULT_POLICY, [], now);
  assert.equal(decide(checks), "block");
});

test("payout over the payee's monthly limit or duplicated needs approval", () => {
  assert.equal(decide(checkPayout({ kind: "payout", email: "sam.rivera@example.com", amount: 35, note: "" }, { paidToPayee30d: 70, samePayeeSameAmount24h: false }, DEFAULT_POLICY, [], now)), "hold");
  assert.equal(decide(checkPayout({ kind: "payout", email: "sam.rivera@example.com", amount: 35, note: "" }, { paidToPayee30d: 35, samePayeeSameAmount24h: true }, DEFAULT_POLICY, [], now)), "hold");
});

test("invoice discount above the cap needs approval", () => {
  assert.equal(decide(checkInvoice({ kind: "invoice", recipientEmail: "a@b.c", total: 200, discountPercent: 25 }, DEFAULT_POLICY)), "hold");
  assert.equal(decide(checkInvoice({ kind: "invoice", recipientEmail: "a@b.c", total: 200, discountPercent: 10 }, DEFAULT_POLICY)), "allow");
});

test("policy validation rejects an auto limit above the hard limit", () => {
  const bad = structuredClone(DEFAULT_POLICY);
  bad.refunds.auto_approve_up_to = 500;
  assert.throws(() => validatePolicy(bad), /auto-approve limit/);
  assert.doesNotThrow(() => validatePolicy(DEFAULT_POLICY));
});
