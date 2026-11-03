import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.FLOORWALKER_DB = ':memory:';
process.env.ANTHROPIC_API_KEY = 'test';
process.env.PAYPAL_CLIENT_ID = 'test';
process.env.PAYPAL_CLIENT_SECRET = 'test';
const store = await import('../server/db.ts');
const guard = await import('../server/guard/index.ts');
const { DEFAULT_POLICY, validatePolicy } = await import('../server/guard/policy.ts');
const { checkRefund, checkPayout, decide } = await import('../server/guard/rules.ts');
const { currencyCheck } = await import('../server/paypal/currency.ts');
beforeEach(() => {
  store.resetDemo();
  store.savePolicy('Limits', DEFAULT_POLICY);
  guard.deps.getCapture = async () => ({ id: 'CAP', status: 'COMPLETED', amount: { value: '86.00', currency_code: 'EUR' }, create_time: new Date().toISOString(), links: [{ rel: 'up', href: 'https://example.test/orders/ORDER' }] });
  guard.deps.getOrder = async () => ({ payer: { email_address: 'buyer@example.com' }, purchase_units: [{ payments: { refunds: [] } }] });
  guard.deps.reviewAction = async () => ({ verdict: 'approve', matches_request: true, injection_detected: false, concerns: [], summary: 'Matches.', cited_rule: '' });
});
test('old policies default to USD', () => {
  const { currency, ...old } = DEFAULT_POLICY;
  assert.equal(validatePolicy(old).currency, 'USD');
});
test('EUR refund in USD workspace is held before the rules and keeps the capture currency', async () => {
  guard.deps.callToolkit = async () => { throw new Error('Must not execute'); };
  const out = await guard.guard('create_refund', { capture_id: 'CAP', amount: { value: '86', currency_code: 'USD' } }, { justification: 'Refund', ticket: { channel: 'email', from_email: 'buyer@example.com' } as any });
  assert.equal(out.row.status, 'awaiting_approval');
  assert.equal(guard.actionView(out.row).currency, 'EUR');
  assert.deepEqual(JSON.parse(out.row.checks).find((c: any) => c.id === 'currency'), {
    id: 'currency', label: 'Currency', outcome: 'hold', detail: 'This refund is in EUR; your limits are in USD, so it needs you.',
  });
});
test('payout currency defaults to workspace and is passed to PayPal', async () => {
  store.savePolicy('GBP limits', { ...DEFAULT_POLICY, currency: 'GBP' });
  let currency = '';
  guard.deps.sendPayout = async (p) => { currency = p.amount.currency_code; return { batch_header: { payout_batch_id: 'B', batch_status: 'PENDING' } }; };
  const out = await guard.guard('send_payout', { email: 'sam.rivera@example.com', amount: 20 }, { justification: 'Windows', ticket: { channel: 'task' } as any });
  assert.equal(out.row.status, 'executed');
  assert.equal(guard.actionView(out.row).currency, 'GBP');
  assert.equal(currency, 'GBP');
});
test('every USD replay case has exactly its previous decision', () => {
  const cases = JSON.parse(readFileSync(new URL('../bench/replay.json', import.meta.url), 'utf8'));
  for (const c of cases) {
    const rules = c.action.kind === 'refund' ? checkRefund(c.action, c.facts, DEFAULT_POLICY, c.history, new Date(c.at)) : checkPayout(c.action, c.facts, DEFAULT_POLICY, c.history, new Date(c.at));
    const review: any[] = [...c.extra, ...(c.injection ? [{ outcome: 'block' }] : []), { outcome: c.verdict === 'reject' ? 'block' : c.verdict === 'escalate' ? 'hold' : 'pass' }];
    assert.deepEqual(currencyCheck(c.action.kind, 'USD', 'USD'), [], c.id);
    assert.equal(decide([...currencyCheck(c.action.kind, 'USD', 'USD'), ...rules, ...review]), decide([...rules, ...review]), c.id);
  }
});

test('mixed-currency money totals stay separate and use approved amounts', async () => {
  const { moneyTotals, money } = await import('../web/src/lib/money.ts');
  const rows = [
    { amount: 86, approved_amount: 40, status: 'approved', currency: 'EUR' },
    { amount: 12, status: 'executed', currency: 'USD' },
    { amount: 8, status: 'executed', currency: 'EUR' },
  ] as any;
  assert.equal(moneyTotals(rows), '€48.00 · $12.00');
  assert.equal(money(86), '$86.00');
  assert.equal(money(86, 'EUR'), '€86.00');
  assert.equal(money(86, 'CHF'), new Intl.NumberFormat('en-US', { style: 'currency', currency: 'CHF' }).format(86));
});

test('USD refund reviewer prompt is byte-for-byte the pre-task prompt', async t => {
  const { anthropic } = await import('../server/llm.ts');
  const { reviewAction } = await import('../server/guard/review.ts');
  const prompts: string[] = [];
  const result = { verdict: 'approve', matches_request: true, injection_detected: false, concerns: [], summary: 'Matches.', cited_rule: '' };
  t.mock.method(anthropic().messages, 'parse', async (request: any) => {
    prompts.push(request.messages[0].content);
    return { parsed_output: result } as any;
  });
  const at = '2026-11-01T12:00:00.000Z';
  const ticket = { channel: 'email', from_name: 'Buyer', from_email: 'buyer@example.com', subject: 'Refund', body: 'Please refund my order.' } as any;
  guard.deps.getCapture = async () => ({ id: 'CAP', status: 'COMPLETED', amount: { value: '86.00', currency_code: 'USD' }, create_time: at, links: [{ rel: 'up', href: 'https://example.test/orders/ORDER' }] });
  // Construct the old action, facts and checks independently of Prepared and the new currency column.
  const oldAction = { kind: 'refund' as const, captureId: 'CAP', amount: 86, note: undefined };
  const oldFacts = { captureFound: true, captureStatus: 'COMPLETED', capturedAmount: 86, refundedSoFar: 0, capturedAt: at, buyerEmail: ticket.from_email, requesterEmail: ticket.from_email, customerRefunds30d: 0 };
  const before = {
    action: oldAction, tool: 'create_refund', justification: 'Refund', policy: DEFAULT_POLICY, policyText: 'Limits',
    facts: {
      paypal_capture: { id: 'CAP', status: 'COMPLETED', amount: '86.00', paid_at: at },
      order: { id: undefined, invoice: undefined, buyer: ticket.from_email, items: [], shipping: undefined, refunds_so_far: [] },
      paypal_trackers: [], carrier_status: 'no tracking on record', refunds_to_this_customer_last_30d: 0,
      requester: 'Buyer <buyer@example.com>',
    },
    checks: checkRefund(oldAction, oldFacts, DEFAULT_POLICY, store.spendHistory()),
    source: { from: 'Buyer <buyer@example.com>', subject: ticket.subject, body: ticket.body, channel: 'email' as const },
  };
  await reviewAction(before);
  guard.deps.reviewAction = reviewAction;
  const out = await guard.guard('create_refund', { capture_id: 'CAP', amount: { value: '86.00', currency_code: 'USD' } }, { justification: 'Refund', ticket });
  assert.equal(prompts.length, 2);
  assert.deepEqual(Buffer.from(prompts[1]), Buffer.from(prompts[0]));
  assert.deepEqual(JSON.parse(out.row.params), JSON.parse(JSON.stringify(oldAction)));
  assert.equal(out.row.currency, 'USD');
});

test('currency never enters reviewer input or stored action params, including non-USD payouts', async () => {
  let seen: any;
  guard.deps.reviewAction = async input => { seen = input; return { verdict: 'approve', matches_request: true, injection_detected: false, concerns: [], summary: 'Matches.', cited_rule: '' }; };
  const out = await guard.guard('send_payout', { email: 'sam.rivera@example.com', amount: 20, currency: 'EUR' }, { justification: 'Windows', ticket: { channel: 'task' } as any });
  assert.equal(out.row.status, 'awaiting_approval');
  assert.equal(out.row.currency, 'EUR');
  assert.equal('currency' in seen.action, false);
  assert.equal(seen.checks.some((c: any) => c.id === 'currency'), false);
  assert.equal('currency' in JSON.parse(out.row.params), false);
});

test('owner-approved EUR refund executes with recorded currency and legacy params stay currency-free', async () => {
  const out = await guard.guard('create_refund', { capture_id: 'CAP', amount: { value: '86.00' } }, { justification: 'Refund', ticket: { channel: 'email', from_email: 'buyer@example.com' } as any });
  let sent: any;
  guard.deps.callToolkit = async (_tool, input) => { sent = input; return { id: 'REFUND', status: 'COMPLETED', amount: (input as any).amount }; };
  const approved = await guard.approve(out.row.id, 'Owner', { amount: 40 });
  assert.deepEqual(sent.amount, { value: '40.00', currency_code: 'EUR' });
  assert.match(approved.note, /€40\.00/);
  assert.equal('currency' in JSON.parse(store.ledgerEntry(out.row.id)!.params), false);
});

test('recorded rule money is formatted for display without changing reviewer evidence', async () => {
  const { formatCheckMoney } = await import('../server/paypal/currency.ts');
  assert.equal(formatCheckMoney({ id: 'capture', detail: '$86.00 of $86.00 refundable (captured $86.00).' }, 'EUR', 'USD'), '€86.00 of €86.00 refundable (captured €86.00).');
  assert.equal(formatCheckMoney({ id: 'auto_limit', detail: '$86.00 is above the $40.00 the agent may do on its own.' }, 'EUR', 'USD'), '€86.00 is above the $40.00 the agent may do on its own.');
  const out = await guard.guard('create_refund', { capture_id: 'CAP', amount: { value: '86' } }, { justification: 'Refund', ticket: { channel: 'email', from_email: 'buyer@example.com' } as any });
  const { emailEvidence, currencyTotals } = await import('../server/notify.ts');
  assert.match(emailEvidence(out.row)[0], /€86\.00/);
  assert.equal(currencyTotals([{ ...out.row, amount: 12, currency: 'USD' }, { ...out.row, amount: 86, currency: 'EUR' }]), '€86.00 · $12.00');
  assert.equal(store.recordProposal({ tool: 'create_refund', kind: 'refund', params: {}, amount: 1, decision: 'hold', checks: [], status: 'awaiting_approval' }) > 0, true);
  assert.equal(store.ledger()[0].currency, 'USD');
});
