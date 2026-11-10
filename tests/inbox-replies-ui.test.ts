import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

test('inbox separates owner notes, editable customer draft and live ledger outcomes', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/app'), configurable: true });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
  try {
    const { TicketResult } = await vite.ssrLoadModule('/src/components/MessageEvidence.tsx');
    const { Inbox } = await vite.ssrLoadModule('/src/components/Inbox.tsx');
    const ticket = { id: 'T4', channel: 'email', from_name: 'Sam', from_email: 'sam@example.com', subject: 'Payment details', body: 'Please verify.', received_at: new Date().toISOString(), status: 'handled', reply: 'Awaiting review.', internal_note: 'Private verification task.', needs_follow_up: 1, reply_stale: true };
    const ledger = [{ id: 1, ticket_id: 'T4', status: 'executed', amount: 86, approved_amount: 64, currency: 'USD', paypal_ref: 'SANDBOX-REF' }];
    const props = { ticket, ledger, owner: true, disabled: false, refresh: async () => {}, notify: () => {} };
    const html = renderToStaticMarkup(createElement(TicketResult, props));
    assert.match(html, /Internal note/); assert.match(html, /Owner only/);
    assert.match(html, /Reply to customer — not sent/);
    assert.match(html, /<textarea[^>]*>Awaiting review\.<\/textarea>/);
    assert.match(html, /Payment status/); assert.match(html, /\$64\.00/); assert.match(html, /SANDBOX-REF/);
    assert.match(html, /Written before your decision — review before sending/);
    assert.match(html, /Update reply/);
    const member = renderToStaticMarkup(createElement(TicketResult, { ...props, owner: false }));
    assert.doesNotMatch(member, /Private verification task|Internal note/);
    const declined = renderToStaticMarkup(createElement(TicketResult, { ...props, ledger: [{ ...ledger[0], status: 'declined', paypal_ref: null }] }));
    assert.match(declined, /Declined/); assert.doesNotMatch(declined, /SANDBOX-REF/);
    const state = { tickets: [ticket], ledger: [], policy: { policy: {} }, agents: [], configured: { paypal: false, ai: false }, workspace: { demo: false }, me: { role: 'owner' } };
    const client = new QueryClient();
    const inbox = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Inbox, { state, refresh: async () => {}, notify: () => {} })));
    assert.match(inbox, /Needs your follow-up/);
    const primary = inbox.match(/<button[^>]*data-film="run"[^>]*>[\s\S]*?<\/button>/)?.[0];
    assert.match(primary!, /View result/); assert.doesNotMatch(primary!, / disabled=""/);
    assert.match(inbox, /Run again/); assert.doesNotMatch(inbox, /Let the Support agent handle it/);
  } finally {
    await vite.close();
    if (previous) Object.defineProperty(globalThis, 'location', previous); else Reflect.deleteProperty(globalThis, 'location');
  }
});
