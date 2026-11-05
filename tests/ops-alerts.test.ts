import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Operational scripts are standalone JavaScript, outside the TS project.
import { buildAlert, sendAlert } from '../deploy/alert.mjs';
// @ts-expect-error Operational scripts are standalone JavaScript, outside the TS project.
import { checkHealth, nextState } from '../deploy/healthcheck.mjs';

const now = new Date('2026-11-05T12:00:00.000Z');
const alert = buildAlert({ subject: 'site down', body: 'Two failures.', host: 'ops-host', now });
const env = {
  RESEND_API_KEY: 'test-secret-never-in-body',
  FLOORWALKER_MAIL_FROM: 'Floorwalker <ops@example.com>',
  FLOORWALKER_ALERT_EMAILS: ' first@example.com, ,second@example.com ',
  FLOORWALKER_ADMIN_EMAILS: 'admin@example.com',
};

test('buildAlert prefixes subject and includes body, hostname and ISO time', () => {
  assert.deepEqual(alert, {
    subject: '[Floorwalker] site down',
    text: 'Two failures.\n\nHostname: ops-host\nTime: 2026-11-05T12:00:00.000Z\n',
  });
  assert.equal(buildAlert({ subject: 'test', host: 'host', now }).text,
    'Hostname: host\nTime: 2026-11-05T12:00:00.000Z\n');
});

test('sendAlert posts plain text to Resend with Bearer auth and alert recipients', async () => {
  let calls = 0;
  await sendAlert(alert, { env, fetch: async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(options.body)), {
      from: env.FLOORWALKER_MAIL_FROM, to: ['first@example.com', 'second@example.com'], ...alert,
    });
    assert.ok(!String(options.body).includes(env.RESEND_API_KEY));
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true };
  } });
  assert.equal(calls, 1);
});

test('sendAlert falls back to comma-separated admins when alert recipients are absent or blank', async () => {
  for (const value of [undefined, '', ' , ']) {
    await sendAlert(alert, {
      env: { ...env, FLOORWALKER_ALERT_EMAILS: value, FLOORWALKER_ADMIN_EMAILS: ' admin@example.com, second-admin@example.com ' },
      fetch: async (_url: string, options: RequestInit) => {
        assert.deepEqual(JSON.parse(String(options.body)).to, ['admin@example.com', 'second-admin@example.com']);
        return { ok: true };
      },
    });
  }
});

test('sendAlert rejects missing key or recipients with exit code 2 without fetching', async () => {
  const fetch = async () => { assert.fail('must not fetch with missing configuration'); };
  await assert.rejects(sendAlert(alert, { env: { ...env, RESEND_API_KEY: '' }, fetch }),
    { message: 'RESEND_API_KEY is missing', exitCode: 2 });
  await assert.rejects(sendAlert(alert, {
    env: { ...env, FLOORWALKER_ALERT_EMAILS: ' , ', FLOORWALKER_ADMIN_EMAILS: '' }, fetch,
  }), { message: 'No recipients: set FLOORWALKER_ALERT_EMAILS or FLOORWALKER_ADMIN_EMAILS', exitCode: 2 });
});

test('sendAlert reports HTTP and transport failures without reflecting credentials', async () => {
  await assert.rejects(sendAlert(alert, { env, fetch: async () => ({ ok: false, status: 429 }) }),
    { message: 'Resend request failed (HTTP 429)' });
  await assert.rejects(sendAlert(alert, { env, fetch: async () => { throw new Error(env.RESEND_API_KEY); } }),
    { message: 'Resend request failed or timed out' });
});

test('nextState waits for two failures, alerts once and repeats only after six hours', () => {
  const first = nextState(null, { ok: false }, now);
  assert.equal(first.state.failures, 1);
  assert.equal(first.alert, null);
  const before = structuredClone(first.state);
  const second = nextState(first.state, { ok: false, detail: 'HTTP 503' }, now);
  assert.deepEqual(first.state, before, 'previous state is not mutated');
  assert.equal(second.state.failures, 2);
  assert.equal(second.alert.subject, 'site down');
  assert.match(second.alert.body, /HTTP 503/);
  assert.equal(second.state.lastAlertAt, now.toISOString());
  const third = nextState(second.state, { ok: false }, new Date(+now + 300_000));
  assert.equal(third.alert, null);
  const justBefore = nextState(third.state, { ok: false }, +now + 6 * 3600_000 - 1);
  assert.equal(justBefore.alert, null);
  const repeat = nextState(justBefore.state, { ok: false }, +now + 6 * 3600_000);
  assert.equal(repeat.alert.subject, 'site down');
  assert.equal(repeat.state.lastAlertAt, new Date(+now + 6 * 3600_000).toISOString());
  assert.equal(nextState(repeat.state, { ok: false }, +now + 6 * 3600_000 + 300_000).alert, null);
});

test('nextState recovers once after a down alert and resets the failure streak', () => {
  const first = nextState(null, { ok: false }, now);
  const down = nextState(first.state, { ok: false }, now);
  const recovered = nextState(down.state, { ok: true }, now);
  assert.equal(recovered.alert.subject, 'recovered');
  assert.deepEqual(recovered.state, { failures: 0, downAlerted: false, lastAlertAt: null });
  assert.equal(nextState(recovered.state, { ok: true }, now).alert, null);
  assert.equal(nextState(recovered.state, { ok: false }, now).alert, null);
});

test('nextState recovery without a prior down alert sends nothing', () => {
  assert.equal(nextState(null, { ok: true }, now).alert, null);
  const first = nextState(null, { ok: false }, now);
  const recovered = nextState(first.state, { ok: true }, now);
  assert.equal(recovered.alert, null);
  assert.equal(recovered.state.failures, 0);
});

test('checkHealth requires exactly HTTP 200 and JSON ok:true and sets a timeout signal', async () => {
  for (const [status, data, expected] of [
    [200, { ok: true }, true], [201, { ok: true }, false], [503, { ok: true }, false],
    [200, { ok: false }, false], [200, { ok: 'true' }, false], [200, null, false],
  ] as const) {
    const result = await checkHealth('https://health.example/healthz', async (url: string, options: RequestInit) => {
      assert.equal(url, 'https://health.example/healthz');
      assert.ok(options.signal instanceof AbortSignal);
      return { status, json: async () => data };
    });
    assert.equal(result.ok, expected);
  }
});

test('checkHealth treats network, timeout and invalid JSON errors as failures', async () => {
  for (const fetch of [
    async () => { throw new Error('network'); },
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => ({ status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } }),
  ]) {
    assert.equal((await checkHealth('https://health.example/healthz', fetch)).ok, false);
  }
});
