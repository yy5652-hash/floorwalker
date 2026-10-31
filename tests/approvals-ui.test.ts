// Render the shared desktop/phone approval card using the installed Vite/React pipeline.
// APIs: https://vite.dev/guide/ssr and https://react.dev/reference/react-dom/server/renderToStaticMarkup
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('desktop and phone approvals show a freeze hold, disable approval and keep decline available', async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/app'), configurable: true, writable: true });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
  try {
    const { ApprovalCard } = await vite.ssrLoadModule('/src/components/Approvals.tsx');
    const entry = { id: 1, agent_id: 'bot', status: 'awaiting_approval', kind: 'refund', amount: 86, counterparty: 'buyer@example.com', created_at: new Date().toISOString(), expires_at: null, checks: [], review: null, source: 'inbox', justification: 'Damaged item' };
    for (const pathname of ['/app', '/approve']) {
      Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost' + pathname), configurable: true, writable: true });
      for (const status of ['frozen', 'active']) {
        const state = { agents: [{ id: 'bot', name: 'Support', status }], me: { role: 'owner' } };
        const html = renderToStaticMarkup(createElement(ApprovalCard, { entry, state, refresh: async () => {}, notify: () => {} }));
        const approve = html.match(/<button[^>]*data-film="approve"[^>]*>/)?.[0];
        const decline = html.match(/<button[^>]*data-film="decline"[^>]*>/)?.[0];
        const other = html.match(/<button[^>]*data-film="approve-other"[^>]*>/)?.[0];
        assert.ok(approve); assert.ok(decline); assert.ok(other);
        if (status === 'frozen') {
          assert.match(html, /Blocked by freeze/);
          assert.match(html, /This agent is frozen; unfreeze it first/);
          assert.match(html, /still waiting for approval/);
          assert.match(approve, / disabled=""/);
          assert.match(other, / disabled=""/);
        } else {
          assert.doesNotMatch(html, /Blocked by freeze/);
          assert.doesNotMatch(approve, / disabled=""/);
          assert.doesNotMatch(other, / disabled=""/);
        }
        assert.doesNotMatch(decline, / disabled=""/);
      }
    }
  } finally {
    await vite.close();
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
