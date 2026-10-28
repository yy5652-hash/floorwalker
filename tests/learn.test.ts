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
