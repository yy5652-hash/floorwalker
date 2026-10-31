// Learning from the owner's decisions: changes are backed by approvals, stop below declines, and are backtested.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

process.env.FLOORWALKER_DB = ":memory:";
process.env.FLOORWALKER_CORE_DB = ":memory:";

const store = await import("../server/db.ts");
const { DEFAULT_POLICY, DEFAULT_POLICY_TEXT } = await import("../server/guard/policy.ts");
const { seedHistory } = await import("../server/history.ts");
const { learnedChanges, tapsByWeek, tapsPer100 } = await import("../server/guard/learn.ts");
const { simulate } = await import("../server/guard/simulate.ts");

beforeEach(() => {
  store.resetDemo();
  store.savePolicy(DEFAULT_POLICY_TEXT, DEFAULT_POLICY);
  seedHistory(DEFAULT_POLICY);
});

test("the demo history is simulated, decided by the rule engine and ends a month ago", () => {
  const rows = store.ledger();
  assert.ok(rows.length >= 30);
  assert.ok(rows.every((r) => r.source === "history" && r.paypal_ref === null));
  assert.ok(rows.every((r) => Date.now() - Date.parse(r.created_at) > 30 * 86_400_000));
  assert.ok(rows.some((r) => r.status === "declined" && r.decline_reason));
});

test("raises the refund limit to cover what the owner approved and stops below what they declined", () => {
  const change = learnedChanges(DEFAULT_POLICY).find((c) => c.id.startsWith("refunds.auto_approve_up_to"));
  assert.ok(change);
  assert.equal(change.draft.refunds.auto_approve_up_to, 60);
  assert.match(change.boundary ?? "", /\$72/);
  assert.equal(change.impact.declinedLetThrough, 0);
  assert.ok(change.impact.tapsSaved > 0);
  assert.ok(change.impact.tapsPer100.after < change.impact.tapsPer100.before);
});

test("no suggested change turns a declined request into an automatic one", () => {
  const declined = new Set(store.ledger().filter((r) => r.status === "declined").map((r) => r.id));
  for (const change of learnedChanges(DEFAULT_POLICY)) {
    for (const row of simulate(change.draft).rows) if (declined.has(row.id)) assert.notEqual(row.after, "allow", change.title);
  }
});

test("a declined request inside the range blocks the change", () => {
  // The owner declines a $50 refund that waited: refunds up to $60 can no longer be suggested.
  const id = store.ledger().find((r) => r.kind === "refund" && r.amount === 50)!.id;
  store.db().prepare("UPDATE ledger SET status = 'declined', decline_reason = 'test' WHERE id = ?").run(id);
  const change = learnedChanges(DEFAULT_POLICY).find((c) => c.id.startsWith("refunds.auto_approve_up_to"));
  assert.ok(!change || change.draft.refunds.auto_approve_up_to < 50);
});

test("dismissed changes stay dismissed", () => {
  const first = learnedChanges(DEFAULT_POLICY)[0];
  store.setSetting("learn.dismissed", [first.id]);
  assert.ok(!learnedChanges(DEFAULT_POLICY).some((c) => c.id === first.id));
});

test("taps per 100 money moves", () => {
  assert.equal(tapsPer100(["allow", "hold", "hold", "block"]), 50);
  assert.equal(tapsPer100([]), 0);
  const weeks = tapsByWeek(14);
  assert.equal(weeks.length, 14);
  assert.equal(weeks.reduce((t, w) => t + w.moves, 0), store.ledger().length);
});

test("declines older than 90 days still veto learning, while old approvals are not evidence", () => {
  const older = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const row = store.ledger().find((r) => r.kind === "refund" && r.amount === 50)!;
  const facts = JSON.parse(row.facts!);
  facts.rules.capturedAt = older;
  store.db().prepare("UPDATE ledger SET status = 'declined', created_at = ?, decided_at = ?, facts = ?, decline_reason = 'Never allow this' WHERE id = ?")
    .run(older, older, JSON.stringify(facts), row.id);
  const changes = learnedChanges(DEFAULT_POLICY);
  assert.ok(changes.every(c => !c.id.startsWith("refunds.auto_approve_up_to") || c.draft.refunds.auto_approve_up_to < 50));
  for (const c of changes) assert.notEqual(simulate(c.draft).rows.find(r => r.id === row.id)!.after, "allow");
  store.db().prepare("UPDATE ledger SET created_at = ?, decided_at = ? WHERE status IN ('approved', 'executed')").run(older, older);
  assert.deepEqual(learnedChanges(DEFAULT_POLICY), []);
});

test("an old decline vetoes a budget change through historical replay", () => {
  store.db().exec("DELETE FROM ledger");
  const now = Date.now(), old = now - 180 * 86_400_000;
  function row(at: number, amount: number, status: "approved" | "declined", holds: string[]) {
    const time = new Date(at).toISOString();
    const id = store.recordProposal({ tool: "create_refund", kind: "refund", params: { kind: "refund", captureId: `CAP-${at}`, amount }, amount,
      decision: "hold", status, checks: holds.map(id => ({ id, label: id, detail: "", outcome: "hold" })),
      facts: { rules: { captureFound: true, captureStatus: "COMPLETED", capturedAmount: 200, refundedSoFar: 0, capturedAt: time, buyerEmail: "buyer@example.com", requesterEmail: "buyer@example.com", customerRefunds30d: 0 } } });
    store.db().prepare("UPDATE ledger SET created_at = ?, decided_at = ?, decided_by = 'Owner' WHERE id = ?").run(time, time, id);
    return id;
  }
  row(old, 120, "approved", ["auto_limit"]);
  const declined = row(old + 60_000, 24, "declined", ["budget", "auto_limit"]);
  row(now - 600_000, 120, "approved", ["auto_limit"]);
  for (let i = 1; i <= 3; i++) row(now - (4 - i) * 60_000, 24, "approved", ["budget"]);
  assert.ok(!learnedChanges(DEFAULT_POLICY).some(c => c.id.startsWith("refunds.budget=")));
  // Without that old decline, the recent approvals really would propose a larger budget.
  store.db().prepare("UPDATE ledger SET status = 'blocked' WHERE id = ?").run(declined);
  const change = learnedChanges(DEFAULT_POLICY).find(c => c.id.startsWith("refunds.budget="));
  assert.ok(change);
  assert.equal(simulate(change.draft).rows.find(r => r.id === declined)!.after, "allow");
});
