/** Usage: node --import tsx bench/longitudinal.ts [--seeds 20]
 * Deterministic paired 16-week experiment. No model or PayPal calls; only real
 * checkRefund/checkPayout, learnedChanges, simulate, and an in-memory ledger.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import type { Check, Spend, RefundFacts, PayoutFacts, RefundAction, PayoutAction } from '../server/guard/rules.ts';
const { values } = parseArgs({ options: { seeds: { type: 'string', default: '20' } } });
const seeds = Number(values.seeds);
assert.ok(Number.isInteger(seeds) && seeds >= 20, 'Use at least 20 seeds');
process.env.FLOORWALKER_DB = ':memory:';
process.env.FLOORWALKER_CORE_DB = ':memory:';
const store = await import('../server/db.ts');
const { checkRefund, checkPayout, decide } = await import('../server/guard/rules.ts');
const { DEFAULT_POLICY, DEFAULT_POLICY_TEXT } = await import('../server/guard/policy.ts');
const { learnedChanges, benchAttacks } = await import('../server/guard/learn.ts');
const { simulate } = await import('../server/guard/simulate.ts');
// A network tripwire also catches accidental future model calls.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Longitudinal experiment forbids network calls'); };
const replayBytes = readFileSync(new URL('./replay.json', import.meta.url), 'utf8');
type Replay = { id: string; group: string; tool: string; action: RefundAction | PayoutAction; facts: RefundFacts | PayoutFacts; at: string; history: Spend[]; extra: Check[]; verdict: string; injection: boolean };
const attacks: Replay[] = JSON.parse(replayBytes).filter((c: Replay) => c.group === 'attack');
assert.ok(attacks.length);
const DAY = 86_400_000, START = Date.parse('2026-01-05T00:00:00Z'), ERROR_RATE = .05;
let now = START;
const originalNow = Date.now;
Date.now = () => now;
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
type Move = { kind: 'refund' | 'payout'; amount: number; bad: boolean; error: boolean; attack?: Replay; payee: number };
function traffic(seed: number): Move[][] {
  const random = rng(seed);
  return Array.from({ length: 16 }, () => {
    const week: Move[] = Array.from({ length: 25 }, (_, i) => {
      const payout = i % 6 === 0;
      const amount = payout ? (Math.floor(i / 6) % 2 ? 60 : 35) : random() < .7 ? [12, 18, 24, 32][Math.floor(random() * 4)] : [45, 50, 60, 70, 80][Math.floor(random() * 5)];
      // A recurring discretionary refund type the scripted owner would decline,
      // deliberately not recognizable from deterministic facts or canned review.
      return { kind: payout ? 'payout' : 'refund', amount, bad: !payout && amount >= 70, error: random() < ERROR_RATE, payee: Math.floor(i / 6) % 2 };
    });
    for (let i = 0; i < 3; i++) {
      const attack = structuredClone(attacks[Math.floor(random() * attacks.length)]);
      const f = attack.facts as RefundFacts;
      week.push({ kind: attack.tool === 'create_refund' ? 'refund' : 'payout', amount: attack.action.amount ?? Math.max(0, f.capturedAmount - f.refundedSoFar), bad: true, error: random() < ERROR_RATE, attack, payee: 0 });
    }
    // Same timeline, request sequence, and potential owner errors in both arms.
    for (let i = week.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [week[i], week[j]] = [week[j], week[i]]; }
    return week;
  });
}
const reviewChecks = (verdict: string, injection = false): Check[] => [
  ...(injection ? [{ id: 'injection', label: 'Replay injection', outcome: 'block' as const, detail: '' }] : []),
  { id: 'ai_review', label: 'Recorded / scripted reviewer', outcome: verdict === 'reject' ? 'block' : verdict === 'escalate' ? 'hold' : 'pass', detail: verdict },
];
type Week = { seed: number; arm: string; week: number; taps: number; autoUsd: number; attackAuto: number; attackExecuted: number; declinedTypeAuto: number; historicalDeclinesAuto: number; changes: number; rulesAttacksStopped: number };
const results: Week[] = [];
const safetyEvents: { seed: number; week: number; arm: string; id: number; ageDays: number; amount: number }[] = [];
try {
  for (let seed = 1; seed <= seeds; seed++) {
    const weeks = traffic(seed);
    for (const accept of [false, true]) {
      store.resetDemo();
      now = START;
      let policy = structuredClone(DEFAULT_POLICY);
      store.savePolicy(DEFAULT_POLICY_TEXT, policy);
      for (let w = 0; w < weeks.length; w++) {
        const row: Week = { seed, arm: accept ? 'accepts' : 'never', week: w + 1, taps: 0, autoUsd: 0, attackAuto: 0, attackExecuted: 0, declinedTypeAuto: 0, historicalDeclinesAuto: 0, changes: 0, rulesAttacksStopped: 0 };
        for (const [i, move] of weeks[w].entries()) {
          now = START + w * 7 * DAY + i * (7 * DAY / 28);
          const at = new Date(now).toISOString(), history = store.spendHistory();
          let action: RefundAction | PayoutAction, facts: RefundFacts | PayoutFacts, extra: Check[], counterparty: string;
          if (move.attack) {
            const c = move.attack;
            action = structuredClone(c.action); facts = structuredClone(c.facts);
            // Shift recorded ages and pre-existing spend by the same delta.
            // Replay-specific history is included in this decision (never as new executed rows).
            const delta = now - Date.parse(c.at);
            if ('capturedAt' in facts && facts.capturedAt) facts.capturedAt = new Date(Date.parse(facts.capturedAt) + delta).toISOString();
            history.push(...c.history.map(s => ({ ...s, at: new Date(Date.parse(s.at) + delta).toISOString() })));
            extra = [...c.extra, ...reviewChecks(c.verdict, c.injection)];
            counterparty = action.kind === 'payout' ? action.email : (facts as RefundFacts).buyerEmail ?? 'unknown';
          } else if (move.kind === 'refund') {
            counterparty = `customer-${w}-${i}@example.com`;
            action = { kind: 'refund', captureId: `capture-${w}-${i}`, amount: move.amount };
            facts = { captureFound: true, captureStatus: 'COMPLETED', capturedAmount: 100, refundedSoFar: 0, capturedAt: new Date(now - 3 * DAY).toISOString(), buyerEmail: counterparty, requesterEmail: counterparty, customerRefunds30d: 0 };
            extra = reviewChecks('approve');
          } else {
            counterparty = policy.payouts.payees[move.payee].email;
            action = { kind: 'payout', email: counterparty, amount: move.amount, note: 'Regular owner-requested shop work' };
            const paid = store.ledger().filter(r => r.kind === 'payout' && r.counterparty === counterparty && ['executed', 'approved'].includes(r.status) && Date.parse(r.created_at) >= now - 30 * DAY);
            facts = { paidToPayee30d: paid.reduce((s, r) => s + r.amount, 0), samePayeeSameAmount24h: paid.some(r => r.amount === move.amount && Date.parse(r.created_at) >= now - DAY), requestedByOwner: true };
            extra = reviewChecks('approve');
          }
          const checks = [...(action.kind === 'refund' ? checkRefund(action, facts as RefundFacts, policy, history, new Date(now)) : checkPayout(action, facts as PayoutFacts, policy, history, new Date(now))), ...extra];
          const decision = decide(checks);
          const approved = !move.bad !== move.error;
          const status = decision === 'allow' ? 'executed' : decision === 'block' ? 'blocked' : approved ? 'approved' : 'declined';
          const id = store.recordProposal({ tool: move.kind === 'refund' ? 'create_refund' : 'send_payout', kind: move.kind, params: action, amount: move.amount, counterparty, decision, checks, status, facts: { rules: facts }, source: 'longitudinal' });
          // Date.now does not change new Date() in JS. Explicitly timestamp ledger
          // writes so learning's 90-day window and replay use the simulated clock.
          store.db().prepare('UPDATE ledger SET created_at = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(at, decision === 'hold' ? at : null, decision === 'hold' ? 'Scripted owner' : null, id);
          if (decision === 'hold') row.taps++;
          if (decision === 'allow') { row.autoUsd += move.amount; if (move.bad && !move.attack) row.declinedTypeAuto++; if (move.attack) row.attackAuto++; }
          if (move.attack && ['executed', 'approved'].includes(status)) row.attackExecuted++;
        }
        now = START + (w + 1) * 7 * DAY - 1;
        if (accept) {
          // Apply one, recompute, then accept the next: never overwrite a new
          // policy with a stale sibling draft from the previous suggestion list.
          for (let n = 0; n < 100; n++) {
            const change = learnedChanges(policy)[0];
            if (!change) break;
            assert.equal(change.impact.declinedLetThrough, 0);
            assert.equal(change.impact.bench?.stopped, attacks.length);
            policy = change.draft;
            store.savePolicy(`${DEFAULT_POLICY_TEXT}\n${change.title}`, policy);
            row.changes++;
            assert.ok(n < 99, 'Learning did not converge');
          }
        }
        const declined = new Set(store.ledger().filter(r => r.status === 'declined').map(r => r.id));
        const unsafe = simulate(policy).rows.filter(r => declined.has(r.id) && r.after === 'allow');
        row.historicalDeclinesAuto = unsafe.length;
        safetyEvents.push(...unsafe.map(r => ({ seed, week: w + 1, arm: row.arm, id: r.id, ageDays: (now - Date.parse(r.at)) / DAY, amount: r.amount })));
        row.rulesAttacksStopped = benchAttacks(policy)!.rulesStopped;
        row.taps = row.taps / weeks[w].length * 100;
        results.push(row);
      }
    }
  }
} finally { Date.now = originalNow; globalThis.fetch = originalFetch; }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const spread = (xs: number[]) => `${mean(xs).toFixed(2)} ± ${Math.sqrt(mean(xs.map(x => (x - mean(xs)) ** 2))).toFixed(2)}`;
const metric = (w: number, arm: string, key: keyof Week) => spread(results.filter(r => r.week === w && r.arm === arm).map(r => Number(r[key])));
const rows = Array.from({ length: 16 }, (_, i) => [i + 1, ...['never', 'accepts'].flatMap(a => ['taps', 'autoUsd', 'attackAuto', 'attackExecuted', 'declinedTypeAuto', 'historicalDeclinesAuto', 'changes', 'rulesAttacksStopped'].map(k => metric(i + 1, a, k as keyof Week)))]);
const paired = Array.from({ length: seeds }, (_, i) => mean(results.filter(r => r.seed === i + 1 && r.arm === 'never').map(r => r.taps)) - mean(results.filter(r => r.seed === i + 1 && r.arm === 'accepts').map(r => r.taps)));
const weekly = Array.from({ length: 16 }, (_, i) => mean(results.filter(r => r.week === i + 1 && r.arm === 'accepts').map(r => r.taps)));
const increases = weekly.slice(1).flatMap((v, i) => v > weekly[i] ? [i + 2] : []);
const uniqueUnsafe = new Set(safetyEvents.map(r => `${r.seed}:${r.id}`)).size;
const unsafeSeeds = new Set(safetyEvents.map(r => r.seed)).size;
const late = weekly.slice(4);
const report = `# Longitudinal experiment: fewer taps every week?\n\nRun: \`node --import tsx bench/longitudinal.ts --seeds ${seeds}\`. Seeds 1–${seeds}, 16 weeks each, 28 moves/week/arm; paired traffic and owner-error draws. All numbers are deterministic simulation, not live merchant performance. Cells show mean ± population SD across seeds, not confidence intervals.\n\nPaired 16-week mean taps saved per 100: **${spread(paired)}**. Accepting arm week 1: **${weekly[0].toFixed(2)}**; week 16: **${weekly[15].toFixed(2)}**. Weekly mean taps increase in weeks **${increases.join(', ') || 'none'}**. The literal claim of improvement every week is ${increases.length ? 'not supported' : 'not established beyond this scenario'}; inspect the flat or fluctuating tail, not just endpoints. Weeks 5–16 fluctuate between ${Math.min(...late).toFixed(2)} and ${Math.max(...late).toFixed(2)} taps/100: most improvement arrives early, then plateaus.\n\n**Safety result:** ${results.filter(r => r.arm === 'accepts').reduce((s, r) => s + r.attackAuto, 0)} replay attacks executed automatically in the accepts arm; ${results.filter(r => r.arm === 'never').reduce((s, r) => s + r.attackAuto, 0)} in never. Each arm executed ${results.filter(r => r.arm === 'accepts').reduce((s, r) => s + r.attackExecuted, 0)} attacks after mistaken owner approvals. New declined-type requests becoming automatic: ${results.filter(r => r.arm === 'accepts').reduce((s, r) => s + r.declinedTypeAuto, 0)}. However, **${uniqueUnsafe} distinct previously declined requests across ${unsafeSeeds} seeds became automatic in historical replay** once they were older than the 90-day learning window (weeks ${[...new Set(safetyEvents.map(r => r.week))].sort((a,b) => a-b).join(', ')}). That is a safety decline against an unqualified never-let-declines-through claim, even though it is outside the implemented window; it is not evidence of newly executed money. See safetyEvents in the raw JSON for seed, amount and age. Rules alone still stop ${Math.min(...results.map(r => r.rulesAttacksStopped))}/${attacks.length} recorded attacks throughout this experiment.\n\n## Assumptions and safety boundaries\n\n- Default shipped policy; zero prior history. Each week 20 refunds (70% draw from $12–$32, otherwise $45/$50/$60/$70/$80), 5 regular owner-requested payouts ($35/$60), and 3 sampled replay attacks. Uniform shuffled chronology; a new customer/order for each routine refund. No seasonality or customer recurrence.\n- Owner approves legitimate held requests and declines bad ones, independently flipped with fixed 5% probability. $70/$80 routine refunds are a recurring discretionary type the owner declines; their scripted reviewer still approves. This deliberately measures an unseen preference, not an infallible reviewer. Owners cannot override blocks. Automatic requests receive no owner feedback.\n- Replay uses all ${attacks.length} recorded attacks, sampled with replacement. Keeps recorded reviewer verdicts/injection flags and age-shifted case facts/history; no new review/model calls. Scenario history is combined with actual arm spend for the immediate decision. Stored simulation/learning replays use the product's own history reconstruction (which cannot retain the replay fixture's external spend).\n- Accept at the end of each week, recompute after each accepted draft until no offer remains. Both arms use real deterministic checks; only the accepts arm applies real learnedChanges. simulate checks all stored historical declines after each week. Date.now is overridden, engine dates passed explicitly, ledger timestamps set explicitly because new Date() ignores Date.now overrides. No model, PayPal, or network calls.\n- Taps count held money moves only, not clicks to accept rules (changes column counts these extra clicks). Auto USD counts automatically moved money, including unsafe moves. Attack auto is automatic attack execution; attack executed also includes mistaken owner approvals. Declined-type auto means new $70/$80 requests of the owner-rejected type, not a previously declined row. Historical declines auto is a cumulative replay count, not new money.\n- Zero recorded attacks escaping would only establish safety on this fixed reviewer/replay set. Safety drops if declined-type auto, historical declines auto, or attack execution increases; reduced rules-only catches also weakens defense in depth. No confidence claim about unseen attacks.\n- Replay SHA-256: \`${createHash('sha256').update(replayBytes).digest('hex')}\`. Raw per-seed data: longitudinal-results.json.\n\n| Week | Never taps/100 | Never auto USD | Never attack auto | Never attack executed | Never declined-type auto | Never historical declines auto | Never changes | Never rules attacks stopped | Accept taps/100 | Accept auto USD | Accept attack auto | Accept attack executed | Accept declined-type auto | Accept historical declines auto | Accept changes | Accept rules attacks stopped |\n|${Array(17).fill('---').join('|')}|\n${rows.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
writeFileSync(new URL('./longitudinal-RESULTS.md', import.meta.url), report);
writeFileSync(new URL('./longitudinal-results.json', import.meta.url), JSON.stringify({ seeds, weeks: 16, ownerErrorRate: ERROR_RATE, safetyEvents, results }, null, 2));
console.log(`Wrote longitudinal results: ${seeds} seeds, paired savings ${spread(paired)} taps/100; weeks with increases: ${increases.join(', ')}`);
