import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { anonymous, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { randomBytes } from "node:crypto";
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
 * Ready demo shops left in the pool by an older release (before demo shops had earlier activity to learn from) are
 * replaced, so every visitor gets the current demo.
 */
function retireStalePool() {
  const ids = core.prepare(`SELECT w.id FROM workspace w JOIN member m ON m.organizationId = w.id WHERE m.userId = ? AND w.seed_status = 'ready'`).all(POOL_USER) as { id: string }[];
  for (const { id } of ids) {
    try {
      const ws = openWorkspace(id);
      const current = inWorkspace(ws, { kind: "system", id: "pool", name: "Floorwalker" }, () => ws.db.prepare("SELECT 1 FROM ledger WHERE source = 'history' LIMIT 1").get());
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

const origin = config.baseUrl.replace(/\/$/, "");

const options = {
  appName: "Floorwalker",
  baseURL: origin,
  secret: serverSecret(),
  database: core,
  trustedOrigins: [origin],
  emailAndPassword: { enabled: true, minPasswordLength: 10, autoSignIn: true },
  session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    // Each demo visitor gets real sandbox orders, so new demo workspaces are rationed per IP.
    customRules: { "/sign-in/anonymous": { window: 3600, max: 6 }, "/sign-up/email": { window: 3600, max: 10 } },
  },
  plugins: [
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
        core.prepare("UPDATE member SET userId = ? WHERE userId = ?").run(newUser.user.id, anonymousUser.user.id);
      },
    }),
    passkey({ rpID: new URL(origin).hostname, rpName: "Floorwalker", origin }),
  ],
  advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
  databaseHooks: {
    user: { create: { after: async (user: any) => createWorkspaceFor(user) } },
    session: {
      create: {
        before: async (session: any) => ({ data: { ...session, activeOrganizationId: latestWorkspaceOf(session.userId) } }),
      },
    },
  },
} satisfies BetterAuthOptions;

// Create or upgrade better-auth's tables before the instance starts (it checks the schema on start).
await (await getMigrations(options)).runMigrations();

export const auth = betterAuth(options);
