import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { LedgerEntry } from "../../api";
import { aggregateCurrency, decisionAttribution, exportCell, exportColumns, formatAggregate, largestBlocked, outcomeLabels } from "./helpers";

const row = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 1, ticket_id: null, agent_id: "support", tool: "create_refund", kind: "refund", params: {},
  amount: 24, approved_amount: null, currency: "USD", counterparty: "buyer@example.com", justification: null,
  decision: "allow", checks: [], review: null, status: "executed", paypal_ref: "SANDBOX-REF", paypal_result: null,
  error: null, created_at: "2026-11-10T12:00:00.000Z", decided_at: null, decided_by: null, policy_id: 3, source: "inbox", ...overrides,
});

test("group totals include currency and preserve zero amounts", () => {
  assert.equal(formatAggregate(110, aggregateCurrency(["USD", "USD"])), "$110.00 USD");
  assert.equal(formatAggregate(0, "GBP"), "£0.00 GBP");
  assert.equal(formatAggregate(null, "USD"), "");
  assert.equal(aggregateCurrency([null, undefined]), "");
});

test("mixed currencies stay labelled through nested groups instead of displaying a sum", () => {
  const currency = aggregateCurrency([aggregateCurrency(["USD", "GBP"]), "USD"]);
  assert.equal(formatAggregate(110, currency), "Mixed currencies");
  assert.equal(aggregateCurrency(["GBP", "GBP"]), "GBP");
});

test("automatic and blocked rows use their recorded decision or creation time", () => {
  assert.deepEqual(decisionAttribution(row()), { text: "Decided automatically by your rules", at: row().created_at });
  const blocked = row({ decision: "block", status: "blocked", decided_at: "2026-11-10T12:01:00.000Z" });
  assert.deepEqual(decisionAttribution(blocked), { text: "Blocked by Floorwalker — nothing was sent to PayPal", at: blocked.decided_at });
});

test("owner attribution wins over initial AI review and unknown legacy rows remain unknown", () => {
  const approved = row({ decision: "hold", status: "approved", decided_by: "Owner", decided_at: "2026-11-10T12:02:00.000Z", review: { verdict: "escalate", matches_request: true, injection_detected: false, concerns: [], summary: "Ask the owner.", cited_rule: "Limit" } });
  assert.equal(decisionAttribution(approved).text, "Decided by Owner");
  assert.equal(approved.review?.summary, "Ask the owner.");
  assert.equal(decisionAttribution(row({ status: "approved", decided_by: null })).text, "Not recorded");
  assert.equal(decisionAttribution(row({ decision: "hold", status: "awaiting_approval" })).text, "Waiting for your decision");
});

test("investigation opens the largest blocked request, excluding larger declines and payments", () => {
  const blocked = row({ id: 3, status: "blocked", amount: 64 });
  assert.equal(largestBlocked([row({ amount: 500 }), row({ status: "declined", amount: 180 }), row({ status: "blocked", amount: 20 }), blocked]), blocked);
  assert.equal(largestBlocked([]), undefined);
  assert.equal(largestBlocked([row({ status: "declined" })]), undefined);
});

test("export columns include all audit fields without internal chart series", () => {
  for (const field of ["source", "policy_id", "decision", "decided_by", "decided_at", "paypal_ref", "currency"]) assert.ok(exportColumns.includes(field));
  assert.equal(exportColumns.some(column => column.startsWith("chart_")), false);
});

test("export distinguishes live sandbox references from simulated history", () => {
  const live = row();
  const history = row({ source: "history", paypal_ref: "FAKE-REF" });
  assert.equal(exportCell(live, "source", null), "Live session · inbox");
  assert.equal(exportCell(history, "source", null), "Demo history (simulated)");
  assert.equal(exportCell(history, "paypal_ref", null), "Simulated · not sent to PayPal");
  assert.equal(exportCell(live, "paypal_ref", null), "SANDBOX-REF");
});

test("export maps policy, decisions, adjusted amounts and currencies independently", () => {
  const entry = row({ currency: "GBP", approved_amount: 12 });
  assert.equal(exportCell(entry, "amount", null), "12");
  assert.equal(exportCell(entry, "currency", null), "GBP");
  assert.equal(exportCell(entry, "policy_id", null), "v3");
  assert.equal(exportCell(entry, "decision", null), "allow");
  assert.equal(exportCell(entry, "decided_by", null), "Decided automatically by your rules");
  assert.equal(exportCell(entry, "decided_at", null), entry.created_at);
  assert.equal(exportCell(row({ policy_id: null }), "policy_id", null), "Not recorded");
});

test("blocked and owner-declined outcomes have distinct exported labels", () => {
  assert.equal(exportCell(row({ status: "blocked" }), "status", null), "Blocked by Floorwalker");
  assert.equal(exportCell(row({ status: "declined" }), "status", null), "Declined by you");
  assert.notEqual(outcomeLabels.blocked, outcomeLabels.declined);
});

test("exports retain spreadsheet formula protection", () => {
  for (const value of ["=1+1", "+SUM(A1)", "@name", "-1+2", "\tformula", "  =1"]) assert.equal(exportCell(row(), "counterparty", value), `'${value}`);
  assert.equal(exportCell(row(), "counterparty", "buyer@example.com"), "buyer@example.com");
});

test("rendered decision traces separate current outcomes from intact initial AI reviews", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: new URL("http://localhost/app"), configurable: true });
  // Vite 8.3.5 SSR: no port or local env files are needed to render a component.
  const vite = await createServer({ envDir: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  try {
    const { DecisionTrace } = await vite.ssrLoadModule("/src/components/DecisionTrace.tsx");
    for (const entry of [row(), row({ decision: "block", status: "blocked" }), row({ decision: "hold", status: "approved", decided_by: "Owner", review: { verdict: "escalate", matches_request: true, injection_detected: false, concerns: [], summary: "Ask the owner.", cited_rule: "Original limit" } })]) {
      const html = renderToStaticMarkup(createElement(DecisionTrace, { entry }));
      assert.match(html, /Current outcome/);
      assert.match(html, /Initial AI review/);
      assert.ok(html.indexOf("Current outcome") < html.indexOf("Initial AI review"));
      assert.doesNotMatch(html, /Decided by Not recorded|Decision time not recorded/);
      assert.match(html, /datetime="2026-11-10T12:00:00.000Z"/i);
      if (entry.status === "executed") assert.match(html, /Decided automatically by your rules/);
      if (entry.status === "blocked") assert.match(html, /Blocked by Floorwalker — nothing was sent to PayPal/);
      if (entry.status === "approved") {
        assert.match(html, /Approved by you/);
        assert.match(html, /Decided by Owner/);
        assert.match(html, /Ask the owner\./);
        assert.match(html, /Original limit/);
        assert.match(html, /AI verdict: escalate/);
      }
    }
  } finally {
    await vite.close();
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
