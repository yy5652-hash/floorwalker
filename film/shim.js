// Installed before the app's own scripts run. The app's API calls are answered from the recorded live run
// (film/data/run.json), so the film shows the real UI with the real events, released on the film clock:
//   GET  /api/state                 -> window.__film.state (the director swaps in each step's snapshot)
//   POST /api/tickets/:id/run       -> a streaming response; __film.push(key, seconds) releases recorded events
//   POST /api/attack                   (key "ATTACK") up to that many seconds after the request
//   POST /api/ledger/:id/approve    -> held until __film.release('approve'), then the recorded response
//   POST /api/policy/compile        -> held until __film.release('compile'), then the recorded response
//   POST /api/policy/simulate       -> held until __film.release('simulate'), then the recorded response
//   POST /api/agents/:id/freeze     -> ok at once (the director swaps in the recorded state after the click)
//   GET  /api/policy/versions       -> the active version from the current state
//   GET  /api/keys, /api/audit, …   -> the recorded responses in __film.responses (keys, audit, auditVerify), or
//                                      what an untouched workspace answers (settings, billing, webhooks, …)
(() => {
  if (window.__film) return;
  // The director passes each scene's data in window.__filmInit, set by a script that runs right after this one.
  const F = (window.__film = { state: null, streams: {}, responses: {}, open: {}, waiting: {} });
  const load = () => { if (window.__filmInit && !F.inited) { Object.assign(F, window.__filmInit); F.inited = true; } };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init.method || 'GET').toUpperCase();
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    load();
    if (url.pathname === '/api/state') return Promise.resolve(json(F.state));
    if (url.pathname === '/api/policy/versions') return Promise.resolve(json(F.state?.policy ? [{ ...F.state.policy, created_at: new Date().toISOString() }] : []));
    if (method === 'GET') {
      const reads = {
        '/api/keys': () => F.responses.keys ?? [],
        '/api/audit': () => F.responses.audit ?? [],
        '/api/audit/verify': () => F.responses.auditVerify ?? { ok: true, entries: (F.responses.audit ?? []).length },
        '/api/webhooks': () => [],
        '/api/grants': () => [],
        '/api/settings/slack': () => ({ configured: false, events: ['action.held', 'action.blocked'] }),
        '/api/me/notifications': () => ({ prefs: { push_held: true, push_blocked: true, push_reminders: true, push_executed: false }, devices: [] }),
        '/api/push/key': () => ({ publicKey: '' }),
        '/api/settings': () => ({ approval_ttl_hours: 72, step_up_over: 250, reminder_after_minutes: 60, paypal: { connected: true, own: false, client_id_hint: null, verified_at: null, app: null } }),
      };
      const read = reads[url.pathname];
      if (read) return Promise.resolve(json(read()));
    }
    if (method === 'POST' && /^\/api\/agents\/[^/]+\/(freeze|unfreeze)$/.test(url.pathname)) return Promise.resolve(json({ ok: true }));
    const run = url.pathname.match(/^\/api\/tickets\/([^/]+)\/run$/);
    if (method === 'POST' && (run || url.pathname === '/api/attack')) {
      const key = run ? run[1] : 'ATTACK';
      const events = F.streams[key];
      if (!events) return Promise.reject(new Error(`film: no recorded run for ${key}`));
      const stream = new ReadableStream({ start(ctl) { F.open[key] = { ctl, events, sent: 0, enc: new TextEncoder() }; } });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    }
    const hold = url.pathname.match(/\/approve$/) ? 'approve' : url.pathname === '/api/policy/compile' ? 'compile' : url.pathname === '/api/policy/simulate' ? 'simulate' : null;
    if (method === 'POST' && hold) return new Promise(resolve => { F.waiting[hold] = () => resolve(json(F.responses[hold])); });
    return Promise.reject(new Error(`film: unexpected request ${method} ${url.pathname}`));
  };
  // Releases every recorded event of `key` that arrived within `t` seconds of the request; closes the stream at the end.
  F.push = (key, t) => {
    const o = F.open[key];
    if (!o) return -1;
    while (o.sent < o.events.length && o.events[o.sent].t <= t) o.ctl.enqueue(o.enc.encode(JSON.stringify(o.events[o.sent++].event) + '\n'));
    if (o.sent === o.events.length && !o.closed) { o.ctl.close(); o.closed = true; }
    return o.sent;
  };
  F.release = name => { const f = F.waiting[name]; delete F.waiting[name]; if (f) f(); return Boolean(f); };
})();
