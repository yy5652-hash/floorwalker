import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Evaluate the actual pure helpers without importing browser-only chart modules.
function helper(file: string, start: string, end: string, name: string) {
  const source = readFileSync(new URL(`../web/src/${file}`, import.meta.url), "utf8");
  assert.ok(source.includes(start) && source.includes(end));
  return runInNewContext(stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end)).replaceAll("export function", "function") + `\n${name}`));
}

test("overview scopes preserve the automation formula and separate blocks from owner declines", () => {
  const metrics = helper("pages/Overview.tsx", "const scopes =", "const demoRequests =", "overviewMetrics");
  const rows = [
    { id: 1, status: "executed", source: "inbox" },
    { id: 2, status: "approved", source: "api", created_at: "2026-11-10T10:00:00Z", decided_at: "2026-11-10T10:04:00Z" },
    { id: 3, status: "declined", source: "inbox", created_at: "2026-11-10T10:00:00Z", decided_at: "2026-11-10T10:08:00Z" },
    { id: 4, status: "blocked", source: "mcp" },
    { id: 5, status: "awaiting_approval", source: null },
    { id: 6, status: "declined", source: "history" },
    { id: 7, status: "executed", source: "history" },
    { id: 8, status: "failed", source: "api" },
  ];
  const session = metrics(rows, "This session"), history = metrics(rows, "Example history");
  assert.equal(session.automationRate, 1 / 4); // Blocked and failed requests stay out of the denominator.
  assert.equal(session.medianApprovalMinutes, 8);
  assert.equal(session.blocked.length, 1);
  assert.equal(session.declined.length, 1);
  assert.equal(session.waiting.length, 1);
  assert.equal(history.blocked.length, 0);
  assert.equal(history.declined.length, 1);
  assert.equal(history.automationRate, 1 / 2);
  assert.equal(metrics([], "This session").automationRate, null);
});

test("tap summaries and weekly points split source while retaining the learning window and hold decisions", () => {
  const scopedTaps = helper("components/TapsChart.tsx", "export function scopedTaps", "export function TapsChart", "scopedTaps");
  const now = Date.parse("2026-11-10T12:00:00Z"), weeks = [{ week: "2026-11-08" }];
  const rows = [
    { kind: "refund", decision: "allow", source: "inbox", created_at: "2026-11-10T10:00:00Z" },
    { kind: "refund", decision: "hold", source: "api", created_at: "2026-11-10T10:00:00Z" },
    { kind: "payout", decision: "block", source: null, created_at: "2026-11-09T10:00:00Z" },
    { kind: "refund", decision: "hold", source: "history", created_at: "2026-11-09T10:00:00Z" },
    { kind: "invoice", decision: "hold", source: "api", created_at: "2026-11-09T10:00:00Z" },
    { kind: "refund", decision: "hold", source: "inbox", created_at: "2026-01-01T10:00:00Z" },
  ];
  const session = scopedTaps(rows, weeks, 90, now, "This session");
  assert.equal(session.summary.moves, 3);
  assert.equal(session.summary.taps, 1);
  assert.equal(session.summary.per100, 33);
  assert.equal(session.weeks[0].per100, 33);
  const history = scopedTaps(rows, weeks, 90, now, "Example history");
  assert.equal(history.summary.moves, 1);
  assert.equal(history.summary.per100, 100);
  assert.equal(history.weeks[0].taps, 1);
  assert.equal(scopedTaps([], weeks, 90, now, "This session").summary.per100, 0);
});

test("assistant request references link to ledger evidence and other text stays escaped", async () => {
  // Vite 8.3.5 SSR; disable env files and HMR so this test needs neither secrets nor a port.
  const vite = await createServer({ envDir: false, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom", logLevel: "error" });
  try {
    const { AssistantText } = await vite.ssrLoadModule("/src/components/Assistant.tsx");
    const html = renderToStaticMarkup(createElement(AssistantText, { content: 'Request #35 was blocked; request 2 was declined. See [details](/app#ledger/35), /app#ledger/2 and act_9. <img src=x> https://evil.test' }));
    assert.match(html, /href="\/app#ledger\/35">Request #35<\/a>/);
    assert.match(html, /href="\/app#ledger\/2">request 2<\/a>/);
    assert.match(html, /href="\/app#ledger\/35">details<\/a>/);
    assert.match(html, /href="\/app#ledger\/9">act_9<\/a>/);
    assert.match(html, /&lt;img src=x&gt;/);
    assert.doesNotMatch(html, /href="https:|<img/);
  } finally { await vite.close(); }
});
