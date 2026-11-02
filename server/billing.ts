import { actionsThisMonth } from "./db.ts";
// Plans and billing. Floorwalker bills with PayPal Subscriptions on its own sandbox app (the server's
// credentials), whatever PayPal app a workspace connects for its agents.
import { config } from "./config.ts";
import type { PayPalCreds } from "./context.ts";
import { paypal } from "./paypal/client.ts";
import { core, setPlan, workspaceRow, type WorkspaceRow } from "./workspaces.ts";

export const PLANS = {
  free: { name: "Free", price: 0, agents: 3, actionsPerMonth: 200, members: 3, webhooks: 1 },
  pro: { name: "Pro", price: 29, agents: 20, actionsPerMonth: 5_000, members: 10, webhooks: 10 },
  business: { name: "Business", price: 99, agents: Infinity, actionsPerMonth: 50_000, members: Infinity, webhooks: Infinity },
} as const;
export type PlanId = keyof typeof PLANS;

// Demo workspaces are sandboxes for trying everything, so they get the top plan's limits.
export function limitsFor(row: WorkspaceRow) {
  return PLANS[row.demo ? "business" : row.plan] ?? PLANS.free;
}

for (const col of ["plan_until TEXT", "plan_checked_at TEXT"]) {
  try {
    core.exec(`ALTER TABLE workspace ADD COLUMN ${col}`);
  } catch {
    // Already there.
  }
}
core.exec("CREATE TABLE IF NOT EXISTS billing_plan (plan TEXT PRIMARY KEY, paypal_plan_id TEXT NOT NULL, product_id TEXT NOT NULL)");

const floorwalkerApp = (): PayPalCreds => {
  if (!config.paypal.clientId || !config.paypal.clientSecret) throw new Error("Billing isn't set up on this server.");
  return { clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret };
};
const call = <T = any>(method: string, path: string, body?: unknown, requestId?: string) => paypal<T>(method, path, body, { requestId, creds: floorwalkerApp() });

/** The PayPal billing plan for a paid tier, created once on Floorwalker's sandbox app. */
async function paypalPlanId(plan: Exclude<PlanId, "free">): Promise<string> {
  const known = core.prepare("SELECT paypal_plan_id FROM billing_plan WHERE plan = ?").get(plan) as { paypal_plan_id: string } | undefined;
  if (known) return known.paypal_plan_id;
  let product = (core.prepare("SELECT product_id FROM billing_plan LIMIT 1").get() as { product_id: string } | undefined)?.product_id;
  if (!product) {
    const p = await call("POST", "/v1/catalogs/products", { name: "Floorwalker", description: "Floorwalker sits between AI agents and a business's PayPal account: every refund or payout is checked against PayPal's records and your rules, and it learns from your decisions when it no longer needs to ask you.", type: "SERVICE", category: "SOFTWARE" }, "floorwalker-product-v1");
    product = p.id as string;
  }
  const { name, price } = PLANS[plan];
  const created = await call("POST", "/v1/billing/plans", {
    product_id: product,
    name: `Floorwalker ${name}`,
    description: `Floorwalker ${name}, billed monthly`,
    billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: price.toFixed(2), currency_code: "USD" } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
  }, `floorwalker-plan-${plan}-v1`);
  core.prepare("INSERT OR REPLACE INTO billing_plan (plan, paypal_plan_id, product_id) VALUES (?, ?, ?)").run(plan, created.id, product);
  return created.id;
}

const base = () => config.baseUrl.replace(/\/$/, "");

/** Starts a PayPal subscription and returns the PayPal page where the customer approves it. */
export async function checkout(wsId: string, plan: Exclude<PlanId, "free">, subscriber?: { email?: string; name?: string }): Promise<{ approveUrl: string; subscriptionId: string }> {
  const sub = await call("POST", "/v1/billing/subscriptions", {
    plan_id: await paypalPlanId(plan),
    custom_id: wsId,
    ...(subscriber?.email && !subscriber.email.endsWith(".invalid") ? { subscriber: { email_address: subscriber.email } } : {}),
    application_context: {
      brand_name: "Floorwalker",
      user_action: "SUBSCRIBE_NOW",
      shipping_preference: "NO_SHIPPING",
      return_url: `${base()}/api/billing/return`,
      cancel_url: `${base()}/app#settings/billing`,
    },
  });
  const approveUrl = (sub.links as { rel: string; href: string }[]).find((l) => l.rel === "approve")?.href;
  if (!approveUrl) throw new Error("PayPal didn't return an approval link.");
  return { approveUrl, subscriptionId: sub.id };
}

const planFor = (paypalPlanId: string): PlanId | undefined =>
  (core.prepare("SELECT plan FROM billing_plan WHERE paypal_plan_id = ?").get(paypalPlanId) as { plan: PlanId } | undefined)?.plan;

/** Reads the subscription from PayPal and updates the workspace's plan to match. */
export async function syncSubscription(wsId: string, subscriptionId: string) {
  const sub = await call("GET", `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (sub.custom_id !== wsId) throw new Error("That subscription belongs to another workspace.");
  const plan = planFor(sub.plan_id);
  const status = String(sub.status);
  const until = sub.billing_info?.next_billing_time ?? null;
  if (plan && (status === "ACTIVE" || status === "APPROVED")) setPlan(wsId, plan, subscriptionId, status);
  else if (status === "CANCELLED" || status === "SUSPENDED" || status === "EXPIRED") {
    // Paid time already bought stays until the period ends.
    const keep = until && Date.parse(until) > Date.now() && plan;
    setPlan(wsId, keep ? plan : "free", subscriptionId, status);
  }
  core.prepare("UPDATE workspace SET plan_until = ?, plan_checked_at = ? WHERE id = ?").run(until, new Date().toISOString(), wsId);
  return billingView(wsId);
}

export async function cancel(wsId: string, reason: string) {
  const row = workspaceRow(wsId)!;
  if (!row.subscription_id) throw new Error("There's no subscription to cancel.");
  await call("POST", `/v1/billing/subscriptions/${encodeURIComponent(row.subscription_id)}/cancel`, { reason: reason.slice(0, 120) || "Cancelled in Floorwalker" });
  return syncSubscription(wsId, row.subscription_id);
}

/** Usage this calendar month against the plan's limits. */
export function billingView(wsId: string) {
  const row = workspaceRow(wsId)! as WorkspaceRow & { plan_until: string | null; plan_checked_at: string | null };
  return {
    plan: row.demo ? "demo" : row.plan,
    status: row.subscription_status,
    subscription_id: row.subscription_id,
    renews_or_ends_at: row.plan_until,
    limits: limitsFor(row),
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p, agents: Number.isFinite(p.agents) ? p.agents : null, members: Number.isFinite(p.members) ? p.members : null, webhooks: Number.isFinite(p.webhooks) ? p.webhooks : null })),
  };
}

/** Refreshes a paid workspace's status from PayPal at most once an hour (cancellations made on PayPal's side). */
export async function refreshIfStale(wsId: string) {
  const row = workspaceRow(wsId) as (WorkspaceRow & { plan_checked_at: string | null }) | undefined;
  if (!row?.subscription_id || (row.plan_checked_at && Date.now() - Date.parse(row.plan_checked_at) < 3_600_000)) return;
  await syncSubscription(wsId, row.subscription_id).catch(() => {});
}

export class QuotaError extends Error {
  readonly status = 402;
  readonly code = "plan_limit";
}

/** Stops a money move when the workspace has used its plan's checked actions for this month. Runs inside a workspace. */
export function assertActionQuota(wsId: string, monthCount: number) {
  const row = workspaceRow(wsId);
  if (!row) return;
  const { actionsPerMonth, name } = limitsFor(row);
  if (monthCount >= actionsPerMonth) throw new QuotaError(`This workspace has used all ${actionsPerMonth.toLocaleString("en-US")} checked actions in the ${name} plan this month. Upgrade under Settings → Billing.`);
}

export function assertBelow(wsId: string, what: "agents" | "webhooks", count: number) {
  const row = workspaceRow(wsId);
  if (!row) return;
  const limits = limitsFor(row);
  if (count >= limits[what]) throw new QuotaError(`The ${limits.name} plan includes ${limits[what]} ${what}. Upgrade under Settings → Billing for more.`);
}

/** Uses exactly the counter and effective plan limits enforced by assertActionQuota. */
export function billingUsage(wsId: string) {
  const row = workspaceRow(wsId)!;
  const limits = limitsFor(row);
  const actionsUsed = actionsThisMonth();
  const now = new Date();
  return { plan: row.demo ? "demo" : row.plan, planName: row.demo ? "Demo" : limits.name,
    actionsUsed, monthlyLimit: limits.actionsPerMonth,
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    warning: actionsUsed >= limits.actionsPerMonth * 0.8 ? "You have used at least 80% of this month's checked actions." : null };
}
