import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { anonymous, organization, emailOTP, magicLink } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertEmailConfigured, sendEmail } from "./email.ts";
import { createHash, randomBytes } from "node:crypto";
import { config, env } from "./config.ts";
import { inWorkspace } from "./context.ts";
import { serverSecret } from "./crypto.ts";
import { limitsFor } from "./billing.ts";
import { core, openWorkspace, registerWorkspace, removeWorkspace, setSeedStatus, workspaceRow } from "./workspaces.ts";

// ---------------------------------------------------------------- roles
// Owner: everything, including billing. Admin: everything but billing. Approver: answers spend
// requests. Viewer: reads. Agents never sign in; they use API keys scoped to one agent.
const statements = {
  ...defaultStatements,
  ledger: ["approve"],
  rules: ["update"],
  agents: ["manage"],
  developers: ["manage"],
  billing: ["manage"],
} as const;
export const ac = createAccessControl(statements);
const operate = { ledger: ["approve"], rules: ["update"], agents: ["manage"], developers: ["manage"] } as const;
export const roles = {
  owner: ac.newRole({ ...ownerAc.statements, ...operate, billing: ["manage"] }),
  admin: ac.newRole({ ...adminAc.statements, ...operate }),
  approver: ac.newRole({ ledger: ["approve"] }),
  viewer: ac.newRole({}),
};
export type Role = keyof typeof roles;
export type Permission = { [K in keyof typeof statements]?: (typeof statements)[K][number][] };

export function can(role: string | undefined, permission: Permission): boolean {
  const r = roles[role as Role];
  // A member can hold several roles ("admin,approver"); any one of them may grant the permission.
  if (!r) return (role ?? "").includes(",") && role!.split(",").some((one) => can(one.trim(), permission));
  return r.authorize(permission as any).success;
}

// ---------------------------------------------------------------- workspaces for new users
const DEMO_NAME = "Juniper & Oak Ceramics";

/** Runs the demo seed (real sandbox orders, the demo inbox) in the background; the UI shows progress. */
export function seedInBackground(id: string, seed: (ws: ReturnType<typeof openWorkspace>) => Promise<void>) {
  setSeedStatus(id, "seeding");
  const ws = openWorkspace(id);
  void inWorkspace(ws, { kind: "system", id: "seed", name: "Floorwalker" }, () => seed(ws))
    .then(() => setSeedStatus(id, "ready"))
    .catch((e: Error) => setSeedStatus(id, `failed: ${e.message.slice(0, 200)}`));
}

// demo.ts imports the store, which must not load before the context fallback is decided; load it lazily.
const seedDemo = async () => (await import("./demo.ts")).seedDemo();
const ensureAgents = async () => (await import("./demo.ts")).ensureAgents();

// Seeding a demo shop takes PayPal 10-20 seconds, so a few are kept ready, owned by a placeholder user that
// can't sign in (no password, no passkey). A demo visitor takes one over; the pool then refills in the background.
const POOL_USER = "allowance-demo-pool";
const POOL_SIZE = Number(env("DEMO_POOL", config.production ? "2" : "0"));

function claimPooledDemo(userId: string): string | null {
  for (let i = 0; i < 3; i++) {
    const row = core.prepare(`SELECT w.id FROM workspace w JOIN member m ON m.organizationId = w.id
      WHERE m.userId = ? AND w.seed_status = 'ready' ORDER BY w.created_at LIMIT 1`).get(POOL_USER) as { id: string } | undefined;
    if (!row) return null;
    const taken = core.prepare("UPDATE member SET userId = ?, createdAt = ? WHERE organizationId = ? AND userId = ?")
      .run(userId, new Date().toISOString(), row.id, POOL_USER).changes === 1;
    if (taken) return row.id;
  }
  return null;
}

/**
 * Ready demo shops left in the pool by an older release (before demo shops had earlier activity to learn from, or the request a learned rule covers) are
 * replaced, so every visitor gets the current demo.
 */
function retireStalePool() {
  const ids = core.prepare(`SELECT w.id FROM workspace w JOIN member m ON m.organizationId = w.id WHERE m.userId = ? AND w.seed_status = 'ready'`).all(POOL_USER) as { id: string }[];
  for (const { id } of ids) {
    try {
      const ws = openWorkspace(id);
      const current = inWorkspace(ws, { kind: "system", id: "pool", name: "Floorwalker" }, () => ws.db.prepare("SELECT 1 FROM ledger WHERE source = 'history' LIMIT 1").get() && ws.db.prepare("SELECT 1 FROM tickets WHERE id = 'T7'").get());
      if (!current) removeWorkspace(id);
    } catch (e: any) {
      console.error(`demo pool ${id}: ${e.message}`);
    }
  }
}

let filling = false;
let retired = false;
export async function refillDemoPool() {
  if (filling || POOL_SIZE <= 0) return;
  filling = true;
  try {
    if (!retired) {
      retired = true;
      retireStalePool();
    }
    core.prepare(`INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Demo pool', 'pool@demo.allowance.invalid', 0, ?, ?)`)
      .run(POOL_USER, new Date().toISOString(), new Date().toISOString());
    const count = () => (core.prepare(`SELECT COUNT(*) AS n FROM member m JOIN workspace w ON w.id = m.organizationId
      WHERE m.userId = ? AND (w.seed_status = 'ready' OR w.seed_status = 'seeding')`).get(POOL_USER) as { n: number }).n;
    while (count() < POOL_SIZE) await createDemoWorkspace(POOL_USER);
  } catch (e: any) {
    console.error(`demo pool: ${e.message}`);
  } finally {
    filling = false;
  }
}

async function createDemoWorkspace(userId: string) {
  const org = await auth.api.createOrganization({ body: { name: DEMO_NAME, slug: `ws-${randomBytes(6).toString("hex")}`, userId, metadata: { demo: true } } });
  if (!org) throw new Error("Could not create a workspace");
  seedInBackground(org.id, seedDemo);
}

async function createWorkspaceFor(user: { id: string; name: string; email: string; isAnonymous?: boolean | null }) {
  if (user.isAnonymous) {
    const pooled = claimPooledDemo(user.id);
    if (!pooled) await createDemoWorkspace(user.id);
    void refillDemoPool();
    return;
  }
  const first = user.name?.split(/\s+/)[0] || user.email.split("@")[0];
  // afterCreateOrganization registers it and gives it the default agents.
  const org = await auth.api.createOrganization({ body: { name: `${first}'s business`, slug: `ws-${randomBytes(6).toString("hex")}`, userId: user.id, metadata: { demo: false } } });
  if (!org) throw new Error("Could not create a workspace");
}

/** The workspace a fresh session opens in: the one the user joined most recently. */
export function latestWorkspaceOf(userId: string): string | null {
  const row = core.prepare(`SELECT m.organizationId AS id FROM member m JOIN workspace w ON w.id = m.organizationId
    WHERE m.userId = ? ORDER BY m.createdAt DESC LIMIT 1`).get(userId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Remove private workspaces through the same path as normal workspace removal. */
export function removeUserWorkspaces(userId: string) {
  const memberships = core.prepare("SELECT organizationId, role FROM member WHERE userId = ?").all(userId) as { organizationId: string; role: string }[];
  for (const membership of memberships) {
    if (!membership.role.split(",").some((r) => r.trim() === "owner")) continue;
    const others = core.prepare("SELECT role FROM member WHERE organizationId = ? AND userId != ?").all(membership.organizationId, userId) as { role: string }[];
    if (!others.some((m) => m.role.split(",").some((r) => r.trim() === "owner"))) removeWorkspace(membership.organizationId);
  }
  core.prepare("DELETE FROM member WHERE userId = ?").run(userId);
  core.prepare("DELETE FROM passkey WHERE userId = ?").run(userId);
}

// Persistent delivery budget and privacy-minimal sign-in events live in the core DB.
core.exec(`CREATE TABLE IF NOT EXISTS auth_event (
  id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, event TEXT NOT NULL,
  email TEXT NOT NULL, method TEXT
);
CREATE INDEX IF NOT EXISTS auth_event_email_time ON auth_event(email, timestamp);
CREATE TABLE IF NOT EXISTS auth_send_budget (email TEXT NOT NULL, timestamp INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_send_email_time ON auth_send_budget(email, timestamp);
CREATE TABLE IF NOT EXISTS auth_link_preference (hash TEXT PRIMARY KEY, keep_signed_in INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
export function authEvent(event: string, email: string, method?: string) {
  core.prepare("INSERT INTO auth_event(timestamp,event,email,method) VALUES (?,?,?,?)")
    .run(new Date().toISOString(), event, email.toLowerCase(), method ?? null);
}
export function reserveCodeSend(email: string, now = Date.now()) {
  // Synchronous transaction makes reservations safe across concurrent requests/processes.
  core.exec("BEGIN IMMEDIATE");
  try {
    core.prepare("DELETE FROM auth_send_budget WHERE timestamp <= ?").run(now - 86400000);
    const counts = core.prepare(`SELECT COUNT(*) AS day, SUM(timestamp > ?) AS hour FROM auth_send_budget WHERE email = ?`)
      .get(now - 3600000, email.toLowerCase()) as { day: number; hour: number };
    if (counts.hour >= 5 || counts.day >= 10) throw new APIError("TOO_MANY_REQUESTS", {
      message: counts.hour >= 5 ? "You've requested 5 codes this hour. Try again in an hour." : "You've requested 10 codes today. Try again tomorrow.",
    });
    core.prepare("INSERT INTO auth_send_budget VALUES (?,?)").run(email.toLowerCase(), now);
    core.exec("COMMIT");
  } catch (e) { core.exec("ROLLBACK"); throw e; }
}
const codeDelivery = new AsyncLocalStorage<{ otp: string; email: string; keep: boolean }>();
function emailError(e: unknown): never {
  if (e instanceof APIError) throw e;
  throw new APIError("BAD_REQUEST", { message: e instanceof Error ? e.message : "Email could not be sent." });
}
async function changedPassword(email: string) {
  await sendEmail({ to: email, subject: "Your password was changed", text: "Your Floorwalker password was changed. If this wasn't you, reset your password now.", html: "<p>Your Floorwalker password was changed. If this wasn't you, reset your password now.</p>", tag: "password-changed" });
}

const origin = config.baseUrl.replace(/\/$/, "");

const options = {
  appName: "Floorwalker",
  baseURL: origin,
  secret: serverSecret(),
  database: core,
  trustedOrigins: [origin],
  emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 200, autoSignIn: true, revokeSessionsOnPasswordReset: true, onPasswordReset: async ({ user }) => { await changedPassword(user.email); } },
  user: { deleteUser: { enabled: true, beforeDelete: async (user) => { removeUserWorkspaces(user.id); } } },
  // better-auth otherwise lets a fresh password session delete without a password.
  hooks: { before: createAuthMiddleware(async (ctx) => {
    if (ctx.path === "/sign-up/email" && ctx.request) throw new APIError("FORBIDDEN", { message: "Use an email code to sign in or sign up." });
    if (["/email-otp/send-verification-otp", "/email-otp/request-password-reset", "/email-otp/forget-password", "/email-otp/request-email-change"].includes(ctx.path)) {
      try { assertEmailConfigured(); } catch (e) { emailError(e); }
      reserveCodeSend(String(ctx.body.newEmail ?? ctx.body.email).toLowerCase());
    }
    if (ctx.path === "/magic-link/verify") {
      const hash = createHash("sha256").update(String(ctx.query?.token ?? "")).digest("base64url");
      const preference = core.prepare("SELECT keep_signed_in FROM auth_link_preference WHERE hash = ? AND expires_at > ?").get(hash, Date.now()) as { keep_signed_in: number } | undefined;
      (ctx.context as any).keepSignedIn = preference?.keep_signed_in !== 0;
      core.prepare("DELETE FROM auth_link_preference WHERE hash = ? OR expires_at <= ?").run(hash, Date.now());
    }
    if (ctx.path === "/email-otp/change-email") {
      const session = await getSessionFromCtx(ctx);
      (ctx.context as any).oldEmail = session?.user.email;
    }
    if (ctx.path === "/sign-in/magic-link" && !codeDelivery.getStore())
      throw new APIError("FORBIDDEN", { message: "Request a sign-in code first." });
    if (ctx.path === "/email-otp/send-verification-otp" && ctx.body?.type === "change-email")
      throw new APIError("BAD_REQUEST", { message: "Use the change email form." });
    if (ctx.path === "/sign-in/email-otp") (ctx.context as any).createdAccount = !core.prepare("SELECT 1 FROM user WHERE email = ?").get(String(ctx.body.email).toLowerCase());
    if (ctx.path === "/sign-in/email") {
      const user = core.prepare("SELECT id FROM user WHERE email = ?").get(String(ctx.body.email).toLowerCase()) as { id: string } | undefined;
      if (user && !core.prepare("SELECT 1 FROM account WHERE userId = ? AND providerId = 'credential' AND password IS NOT NULL").get(user.id))
        throw new APIError("BAD_REQUEST", { message: "This account doesn't have a password yet. Use a code to sign in." });
    }
    if (["/email-otp/reset-password", "/email-otp/request-password-reset", "/email-otp/request-email-change", "/change-password"].includes(ctx.path)) {
      try { assertEmailConfigured(); } catch (e) { emailError(e); }
    }
    if (ctx.path !== "/delete-user" && ctx.path !== "/delete-user/callback") return;
    const session = await getSessionFromCtx(ctx);
    if (!session) throw new APIError("UNAUTHORIZED", { message: "Sign in to continue." });
    if (session.user.isAnonymous) throw new APIError("FORBIDDEN", { message: "Create an account first." });
    const credential = core.prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'").get(session.user.id) as { password: string | null } | undefined;
    if (credential?.password && !ctx.body?.password) throw new APIError("BAD_REQUEST", { message: "Enter your password to delete your account." });
  }), after: createAuthMiddleware(async (ctx) => {
    if ((ctx.context as any).deliveryError) emailError((ctx.context as any).deliveryError);
    const result = ctx.context.returned;
    if (result instanceof APIError && /OTP|ATTEMPTS/.test(result.body?.code ?? result.body?.message ?? "")) {
      const email = String(ctx.body?.email ?? ctx.body?.newEmail ?? "").toLowerCase();
      authEvent("code_failed", email);
      if (result.body?.code === "OTP_EXPIRED") throw new APIError("BAD_REQUEST", { message: "That code has expired. Send a new code." });
      const type = ctx.path.includes("reset-password") ? "forget-password" : ctx.path.includes("change-email") ? "change-email" : "sign-in";
      const identifierEmail = type === "change-email" ? `${(ctx.context as any).oldEmail}-${ctx.body.newEmail.toLowerCase()}` : email;
      const row = core.prepare("SELECT value FROM verification WHERE identifier = ?").get(`${type}-otp-${identifierEmail}`) as { value: string } | undefined;
      const left = row ? Math.max(0, 5 - Number(row.value.split(":").at(-1))) : 0;
      throw new APIError("BAD_REQUEST", { code: "INVALID_OTP", message: `That code isn't right. ${left} tries left.` });
    }
    if (result instanceof APIError) return;
    if (ctx.path === "/email-otp/change-email" && (ctx.context as any).oldEmail)
      await sendEmail({ to: (ctx.context as any).oldEmail, subject: "Your Floorwalker email was changed", text: "Your sign-in email was changed. Contact support if this wasn't you.", html: "<p>Your sign-in email was changed. Contact support if this wasn't you.</p>", tag: "email-changed" });
    if (ctx.path === "/change-password" && ctx.context.session) await changedPassword(ctx.context.session.user.email);
    if (ctx.path === "/sign-in/email-otp" && result && !(result instanceof Response))
      return ctx.json({ ...(result as object), created: Boolean((ctx.context as any).createdAccount) });
  }) },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24, disableSessionRefresh: true },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    // Each demo visitor gets real sandbox orders, so new demo workspaces are rationed per IP.
    // Reads the app makes on every page load: a busy shared office network should not lock people out of their own menu.
    customRules: { "/sign-in/anonymous": { window: 3600, max: 6 }, "/sign-in/email": { window: 60, max: 10 }, "/sign-up/email": { window: 3600, max: 10 }, "/organization/list": { window: 60, max: 600 }, "/get-session": { window: 60, max: 600 } },
  },
  plugins: [
    emailOTP({
      otpLength: 6, expiresIn: 600, allowedAttempts: 5, storeOTP: "hashed", rateLimit: { window: 60, max: 60 },
      changeEmail: { enabled: true },
      sendVerificationOTP: async ({ email, otp, type }, ctx) => {
        try {
          assertEmailConfigured();
          if (type === "sign-in") {
            const next = String(ctx?.headers?.get("x-floorwalker-next") ?? "/app");
            const target = new URL(next, origin);
            if (target.origin !== origin || ["/signin", "/signup"].includes(target.pathname)) target.href = `${origin}/app`;
            target.searchParams.set("authNotice", "Signed in");
            const welcome = new URL(target); welcome.searchParams.set("authNotice", "Account created. Welcome!");
            await codeDelivery.run({ otp, email, keep: ctx?.headers?.get("x-floorwalker-keep-signed-in") !== "false" }, () => auth.api.signInMagicLink({ headers: ctx?.headers ?? new Headers(), body: {
              email, callbackURL: target.href, newUserCallbackURL: welcome.href,
            } }));
          } else await sendEmail({ to: email, subject: `Your Floorwalker code: ${otp}`, text: `${otp}\nValid for 10 minutes.`, html: `<p>${otp}</p><p>Valid for 10 minutes.</p>`, tag: "code" });
          authEvent("code_sent", email);
        } catch (e) {
          // 1.7.14 swallows background-task failures. Surface a sanitized error
          // in the request's after hook, without logging mail contents.
          if (ctx) (ctx.context as any).deliveryError = e; else emailError(e);
        }
      },
    }),
    magicLink({ expiresIn: 900, storeToken: "hashed", sendMagicLink: async ({ email, url, token }) => {
      const delivery = codeDelivery.getStore();
      if (!delivery || delivery.email !== email) throw new Error("Request a sign-in code first.");
      core.prepare("INSERT INTO auth_link_preference VALUES (?,?,?)").run(createHash("sha256").update(token).digest("base64url"), delivery.keep ? 1 : 0, Date.now() + 900000);
      await sendEmail({ to: email, subject: `Your Floorwalker code: ${delivery.otp}`,
        text: `${delivery.otp}\nValid for 10 minutes.\nOne-time sign-in link (15 minutes): ${url}`,
        html: `<p>${delivery.otp}</p><p>Valid for 10 minutes.</p><a href="${url.replaceAll("&", "&amp;").replaceAll('"', '&quot;')}">Sign in once (15 minutes)</a>`, tag: "code" });
    } }),
    organization({
      ac,
      roles,
      creatorRole: "owner",
      organizationLimit: 20,
      membershipLimit: async (_user, org) => {
        const row = workspaceRow(org.id);
        const n = row ? limitsFor(row).members : 3;
        return Number.isFinite(n) ? n : 10_000;
      },
      // There is no outbound email yet: the Team page shows each invite as a link to copy.
      sendInvitationEmail: async () => {},
      // Workspaces created from the app (the switcher's "New workspace") get their row and agents here.
      organizationHooks: {
        afterCreateOrganization: async ({ organization }: { organization: { id: string; metadata?: unknown } }) => {
          const meta = typeof organization.metadata === "string" ? JSON.parse(organization.metadata || "{}") : (organization.metadata ?? {});
          registerWorkspace(organization.id, { demo: Boolean((meta as { demo?: boolean }).demo) });
          if (!(meta as { demo?: boolean }).demo) await inWorkspace(openWorkspace(organization.id), { kind: "system", id: "setup", name: "Floorwalker" }, ensureAgents);
        },
      },
    }),
    anonymous({
      emailDomainName: "demo.floorwalker.invalid",
      generateName: () => "Demo owner",
      // Signing up from the demo keeps the demo workspace: it moves to the new account.
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        const demoId = anonymousUser.session.activeOrganizationId ?? latestWorkspaceOf(anonymousUser.user.id);
        core.prepare("UPDATE member SET userId = ? WHERE userId = ?").run(newUser.user.id, anonymousUser.user.id);
        if (demoId) {
          core.prepare("UPDATE session SET activeOrganizationId = ? WHERE id = ?").run(demoId, newUser.session.id);
          newUser.session.activeOrganizationId = demoId;
        }
      },
    }),
    passkey({ rpID: new URL(origin).hostname, rpName: "Floorwalker", origin }),
  ],
  advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
  databaseHooks: {
    user: { create: { after: async (user: any) => {
      await createWorkspaceFor(user);
      if (!user.isAnonymous) authEvent("signup_created", user.email);
    } } },
    session: {
      create: {
        before: async (session: any, ctx: any) => ({ data: { ...session,
          expiresAt: new Date(Date.now() + ((ctx?.body?.keepSignedIn === false || ctx?.headers?.get("x-floorwalker-keep-signed-in") === "false" || ctx?.context?.keepSignedIn === false) ? 7 : 30) * 86400000),
          activeOrganizationId: latestWorkspaceOf(session.userId) } }),
        after: async (session: any, ctx: any) => {
          core.prepare("DELETE FROM session WHERE userId = ? AND id NOT IN (SELECT id FROM session WHERE userId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 8)").run(session.userId, session.userId);
          const user = core.prepare("SELECT email, isAnonymous FROM user WHERE id = ?").get(session.userId) as unknown as { email: string; isAnonymous: boolean };
          if (user && !user.isAnonymous) authEvent("login_success", user.email,
            ctx?.path?.includes("email-otp") ? "code" : ctx?.path?.includes("magic-link") ? "continue" : ctx?.path?.includes("passkey") ? "passkey" : "password");
        },
      },
    },
  },
} satisfies BetterAuthOptions;

// Create or upgrade better-auth's tables before the instance starts (it checks the schema on start).
await (await getMigrations(options)).runMigrations();

export const auth = betterAuth(options);
