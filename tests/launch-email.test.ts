import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'fw-email-'));
process.env.FLOORWALKER_CORE_DB = join(dir, 'core.db');
process.env.FLOORWALKER_DATA_DIR = dir;
process.env.FLOORWALKER_DB = ':memory:';
process.env.BETTER_AUTH_SECRET = 'email-tests-secret-that-is-long-enough';
process.env.FLOORWALKER_DEMO_POOL = '0';
process.env.FLOORWALKER_BASE_URL = 'http://localhost:3000';
const { auth, reserveCodeSend } = await import('../server/auth.ts');
const { core } = await import('../server/workspaces.ts');
const { config } = await import('../server/config.ts');
const { setEmailTransport, sendEmail, assertEmailConfigured } = await import('../server/email.ts');
const mail: import('../server/email.ts').Email[] = [];
setEmailTransport(async (email) => { mail.push(email); });
after(() => { core.close(); rmSync(dir, { recursive: true, force: true }); });
async function request(path: string, body: object, cookie = '') {
  return auth.handler(new Request(`http://localhost:3000/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', cookie }, body: JSON.stringify(body) }));
}
const cookies = (res: Response) => res.headers.getSetCookie().map((s) => s.split(';')[0]).join('; ');
const otp = () => mail.at(-1)!.text.split('\n')[0];
const send = (email: string, type = 'sign-in') => request('/email-otp/send-verification-otp', { email, type });
async function login(email: string, keepSignedIn = true) {
  assert.equal((await send(email)).status, 200);
  const res = await request('/sign-in/email-otp', { email, otp: otp(), keepSignedIn });
  assert.equal(res.status, 200, await res.clone().text());
  return res;
}
test('code creates only after verification, hashes codes, is single use, and signs in again', async () => {
  const email = 'new@example.com';
  assert.equal((await send(email)).status, 200);
  assert.equal(core.prepare('SELECT 1 FROM user WHERE email = ?').get(email), undefined);
  const code = otp();
  assert.match(mail.at(-1)!.subject, /^Your Floorwalker code: \d{6}$/);
  assert.match(mail.at(-1)!.text, /magic-link\/verify/);
  const stored = core.prepare('SELECT value FROM verification WHERE identifier = ?').get(`sign-in-otp-${email}`) as { value: string };
  assert.ok(!stored.value.includes(code));
  const res = await request('/sign-in/email-otp', { email, otp: code });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).created, true);
  assert.ok(await auth.api.getSession({ headers: new Headers({ cookie: cookies(res) }) }));
  assert.equal((await request('/sign-in/email-otp', { email, otp: code })).status, 400);
  assert.equal((await (await login(email)).json()).created, false);
});
test('wrong code retains attempt budget and locks on fifth failure', async () => {
  const email = 'wrong@example.com';
  await send(email); const valid = otp(); const wrong = valid === '000000' ? '999999' : '000000';
  for (let i = 1; i <= 5; i++) {
    const res = await request('/sign-in/email-otp', { email, otp: wrong });
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, new RegExp(`${5 - i} tries left`));
  }
  const locked = await request('/sign-in/email-otp', { email, otp: valid }); assert.ok(locked.status >= 400, await locked.text());
});
test('per-address send budgets persist, normalize case, and cover rolling hourly/daily limits', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await send('limits@example.com')).status, 200);
  const res = await send('LIMITS@example.com');
  assert.equal(res.status, 429, await res.clone().text());
  assert.match((await res.json()).message, /5 codes this hour/);
  const now = Date.now();
  for (let batch = 0; batch < 2; batch++) for (let i = 0; i < 5; i++) reserveCodeSend('daily@example.com', now + batch * 3600001);
  assert.throws(() => reserveCodeSend('daily@example.com', now + 7200002), /10 codes today/);
});
test('reset password ends every old session, notifies user, supports 8-character password then sign-in', async () => {
  const email = 'reset@example.com'; const first = cookies(await login(email)); const second = cookies(await login(email));
  await send(email, 'forget-password');
  const res = await request('/email-otp/reset-password', { email, otp: otp(), password: 'newpass8' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(mail.at(-1)!.subject, 'Your password was changed');
  for (const cookie of [first, second]) assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null);
  assert.equal((await request('/sign-in/email', { email, password: 'newpass8' })).status, 200);
});
test('seven-day choice and eight-session maximum are enforced on server', async () => {
  const email = 'sessions@example.com'; const first = await login(email, false);
  const data = await first.json();
  const session = await auth.api.getSession({ headers: new Headers({ cookie: cookies(first) }) });
  assert.ok(session); assert.ok(Math.abs(new Date(session.session.expiresAt).getTime() - Date.now() - 7 * 86400000) < 5000);
  // Make separate hour buckets available without changing the auth session clock.
  for (let i = 0; i < 8; i++) { core.prepare('DELETE FROM auth_send_budget WHERE email = ?').run(email); await login(email); }
  assert.equal((core.prepare('SELECT COUNT(*) AS n FROM session WHERE userId = ?').get(data.user.id) as { n: number }).n, 8);
  assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: cookies(first) }) }), null);
});
test('production missing mail configuration refuses clearly without logging secrets', async () => {
  const old = config.production; const baseUrl = config.baseUrl; const token = process.env.RESEND_API_KEY; const nodeEnv = process.env.NODE_ENV;
  const logs: unknown[] = []; const info = console.info; const error = console.error;
  try {
    config.production = true; process.env.NODE_ENV = 'production'; delete process.env.RESEND_API_KEY; setEmailTransport();
    console.info = (...values) => { logs.push(values); }; console.error = (...values) => { logs.push(values); };
    const outbox = join(dir, 'outbox.jsonl');
    const before = existsSync(outbox) ? readFileSync(outbox, 'utf8') : '';
    for (const url of ['https://floorwalker.example.com', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://localhost@evil.example', 'https://localhost', 'not a URL']) {
      config.baseUrl = url;
      assert.throws(assertEmailConfigured, /Email isn't set up on this server/);
      await assert.rejects(sendEmail({ to: 'prod@example.com', subject: 'Your Floorwalker code: 123456', text: '123456\nsecret-token', html: '<p>123456</p>', tag: 'code' }), /Email isn't set up on this server/);
    }
    assert.equal((await send('prod@example.com')).status, 400);
    assert.equal(existsSync(outbox) ? readFileSync(outbox, 'utf8') : '', before);
    assert.ok(!JSON.stringify(logs).includes('123456')); assert.ok(!JSON.stringify(logs).includes('secret-token'));
  } finally { config.production = old; config.baseUrl = baseUrl; if (token !== undefined) process.env.RESEND_API_KEY = token; if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv; console.info = info; console.error = error; setEmailTransport(async (email) => { mail.push(email); }); }
});
test('local production without a token appends emails beside the core DB and logs only the subject', async () => {
  const production = config.production; const baseUrl = config.baseUrl; const coreDbPath = config.coreDbPath;
  const token = process.env.RESEND_API_KEY; const nodeEnv = process.env.NODE_ENV; const info = console.info;
  const logs: string[] = []; const started = Date.now();
  const outbox = join(dir, 'local-outbox', 'outbox.jsonl');
  try {
    config.production = true; process.env.NODE_ENV = 'production'; delete process.env.RESEND_API_KEY; setEmailTransport();
    config.coreDbPath = join(dir, 'local-outbox', 'core.db');
    console.info = (message) => { logs.push(message); };
    const emails: import('../server/email.ts').Email[] = [];
    for (const url of ['http://localhost', 'http://127.0.0.1', 'http://localhost:18999', 'http://127.0.0.1:43210/']) {
      config.baseUrl = url;
      assert.doesNotThrow(assertEmailConfigured);
      const email = { to: 'local@example.com', subject: 'Your Floorwalker code: 123456', text: '123456\nprivate sign-in link', html: '<p>omitted</p>', tag: 'code' };
      emails.push(email);
      await sendEmail(email);
    }
    const contents = readFileSync(outbox, 'utf8'); assert.ok(contents.endsWith('\n'));
    const rows = contents.trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, emails.length);
    rows.forEach(({ at, ...email }, i) => {
      assert.ok(Date.parse(at) >= started && Date.parse(at) <= Date.now());
      const { html: _html, ...expected } = emails[i]; assert.deepEqual(email, expected);
    });
    assert.deepEqual(logs, emails.map((email) => `Email to ${email.to}: ${email.subject}`));
  } finally {
    config.production = production; config.baseUrl = baseUrl; config.coreDbPath = coreDbPath;
    if (token === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = token;
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    console.info = info; setEmailTransport(async (email) => { mail.push(email); });
  }
});
test('one-time sign-in link preserves destination and creates one session only', async () => {
  const email = 'link@example.com';
  const sent = await auth.handler(new Request('http://localhost:3000/api/auth/email-otp/send-verification-otp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorwalker-next': '/app?view=mine#rules', 'x-floorwalker-keep-signed-in': 'false' }, body: JSON.stringify({ email, type: 'sign-in' }) }));
  assert.equal(sent.status, 200);
  const url = mail.at(-1)!.text.split('One-time sign-in link (15 minutes): ')[1];
  const first = await auth.handler(new Request(url));
  assert.equal(first.status, 302, await first.clone().text());
  const dest = new URL(first.headers.get('location')!);
  assert.equal(dest.hash, '#rules'); assert.equal(dest.searchParams.get('view'), 'mine');
  assert.equal(dest.searchParams.get('authNotice'), 'Account created. Welcome!');
  const session = await auth.api.getSession({ headers: new Headers({ cookie: cookies(first) }) });
  assert.ok(session); assert.ok(Math.abs(new Date(session.session.expiresAt).getTime() - Date.now() - 7 * 86400000) < 5000);
  const second = await auth.handler(new Request(url));
  assert.ok(!second.headers.getSetCookie().some((cookie) => cookie.startsWith('better-auth.session_token=') && !cookie.includes('Max-Age=0')));
  assert.equal((core.prepare("SELECT COUNT(*) AS n FROM auth_event WHERE email = ? AND event = 'login_success' AND method = 'continue'").get(email) as { n: number }).n, 1);
});
test('change email requires code at new address, notifies old address, preserves sign-in', async () => {
  const oldEmail = 'old@example.com'; const newEmail = 'changed@example.com'; const cookie = cookies(await login(oldEmail));
  const missingPassword = await request('/sign-in/email', { email: oldEmail, password: 'anything8' });
  assert.match((await missingPassword.json()).message, /doesn't have a password yet/);
  const requested = await request('/email-otp/request-email-change', { newEmail }, cookie);
  assert.equal(requested.status, 200, await requested.clone().text());
  assert.equal(mail.at(-1)!.to, newEmail); const code = otp();
  assert.equal(core.prepare('SELECT email FROM user WHERE email = ?').get(oldEmail)?.email, oldEmail);
  const changed = await request('/email-otp/change-email', { newEmail, otp: code }, cookie);
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal(mail.at(-1)!.to, oldEmail);
  assert.equal(mail.at(-1)!.subject, 'Your Floorwalker email was changed');
  assert.equal(core.prepare('SELECT email FROM user WHERE email = ?').get(oldEmail), undefined);
  await login(newEmail);
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.ok(session);
  await auth.api.setPassword({ headers: new Headers({ cookie }), body: { newPassword: 'password8' } });
  const passwordLogin = await auth.handler(new Request('http://localhost:3000/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorwalker-keep-signed-in': 'false' }, body: JSON.stringify({ email: newEmail, password: 'password8' }) }));
  assert.equal(passwordLogin.status, 200);
  const shortSession = await auth.api.getSession({ headers: new Headers({ cookie: cookies(passwordLogin) }) });
  assert.ok(shortSession); assert.ok(Math.abs(new Date(shortSession.session.expiresAt).getTime() - Date.now() - 7 * 86400000) < 5000);
});
test('expired code cannot sign in and transport failures reach the UI', async () => {
  const email = 'expired@example.com'; await send(email); const code = otp();
  core.prepare('UPDATE verification SET expiresAt = ? WHERE identifier = ?').run(Date.now() - 1000, `sign-in-otp-${email}`);
  const res = await request('/sign-in/email-otp', { email, otp: code }); assert.ok(res.status >= 400);
  setEmailTransport(async () => { throw new Error('Email could not be sent. Please try again later.'); });
  try { const failed = await send('failed@example.com'); assert.equal(failed.status, 400); assert.match((await failed.json()).message, /Email could not be sent/); }
  finally { setEmailTransport(async (email) => { mail.push(email); }); }
});
test('anonymous visitor keeps the demo workspace and opens it after linking an account', async () => {
  const { createHmac } = await import('node:crypto');
  const id = 'anonymous-fixture'; const now = Date.now();
  core.prepare('INSERT INTO user (id,name,email,emailVerified,isAnonymous,createdAt,updatedAt) VALUES (?,?,?,0,1,?,?)').run(id, 'Demo owner', 'fixture@demo.floorwalker.invalid', now, now);
  const org = await auth.api.createOrganization({ body: { userId: id, name: 'Existing demo', slug: 'existing-demo-fixture', metadata: { demo: true } } });
  assert.ok(org);
  const context = await auth.$context; const anonymous = await context.internalAdapter.createSession(id);
  assert.ok(anonymous);
  const signature = createHmac('sha256', process.env.BETTER_AUTH_SECRET!).update(anonymous.token).digest('base64');
  const cookie = `better-auth.session_token=${encodeURIComponent(`${anonymous.token}.${signature}`)}`;
  assert.ok((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.isAnonymous);
  const email = 'demo-linked@example.com'; await send(email);
  const linked = await request('/sign-in/email-otp', { email, otp: otp() }, cookie);
  assert.equal(linked.status, 200, await linked.clone().text());
  const session = await auth.api.getSession({ headers: new Headers({ cookie: cookies(linked) }) });
  assert.ok(session); assert.equal(session.session.activeOrganizationId, org.id);
  assert.equal(core.prepare('SELECT userId FROM member WHERE organizationId = ?').get(org.id)?.userId, session.user.id);
});
test('Resend sends outbound payload and production delivery never logs codes, tokens or bodies', async () => {
  const production = config.production; const oldEnv = process.env.NODE_ENV; const oldToken = process.env.RESEND_API_KEY;
  const fetcher = globalThis.fetch; const info = console.info; const error = console.error; const logs: unknown[] = [];
  try {
    config.production = true; process.env.NODE_ENV = 'production'; process.env.RESEND_API_KEY = 'test-server-token'; setEmailTransport();
    console.info = (...args) => { logs.push(args); }; console.error = (...args) => { logs.push(args); };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.resend.com/emails'); assert.equal(options?.method, 'POST');
      assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-server-token');
      const body = JSON.parse(options!.body as string); assert.deepEqual(body.tags, [{ name: 'category', value: 'code' }]); assert.equal(body.from, config.mailFrom);
      assert.match(body.subject, /Your Floorwalker code: \d{6}/); assert.match(body.text, /magic-link/);
      return Response.json({ id: 'sent' });
    };
    const response = await send('delivery@example.com'); assert.equal(response.status, 200);
    assert.deepEqual(logs, []);
    globalThis.fetch = async () => new Response('secret-response-body', { status: 422 });
    const failed = await send('rejected@example.com'); assert.equal(failed.status, 400); assert.match((await failed.json()).message, /Email could not be sent/);
    assert.deepEqual(logs, []);
  } finally {
    config.production = production; if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
    if (oldToken === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = oldToken;
    globalThis.fetch = fetcher; console.info = info; console.error = error; setEmailTransport(async (email) => { mail.push(email); });
  }
});
test('public password sign-up cannot bypass email verification and auth events contain no code or IP', async () => {
  const email = 'unverified@example.com';
  const res = await request('/sign-up/email', { email, password: 'password8', name: 'Unverified' });
  assert.equal(res.status, 403); assert.equal(core.prepare('SELECT 1 FROM user WHERE email = ?').get(email), undefined);
  const columns = core.prepare('PRAGMA table_info(auth_event)').all().map((r) => r.name);
  assert.deepEqual(columns, ['id', 'timestamp', 'event', 'email', 'method']);
  for (const event of ['signup_created', 'login_success', 'code_sent', 'code_failed']) assert.ok(core.prepare('SELECT 1 FROM auth_event WHERE event = ?').get(event));
});
