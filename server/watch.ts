import { audit } from "./audit.ts";
import { config } from "./config.ts";
import { ctx, inWorkspace, type PayPalCreds, type Workspace } from "./context.ts";
import * as store from "./db.ts";
import { publish } from "./events.ts";
import { getOrder, refundCapture } from "./paypal/api.ts";
import { paypal, PayPalError } from "./paypal/client.ts";
import { openWorkspaces } from "./workspaces.ts";

/**
 * Floorwalker only protects money that goes through it, so it also watches PayPal for money that didn't: a refund or
 * payout made with the PayPal API key directly, by a leaked key, a script or an agent that bypassed Floorwalker.
 * Three sources feed the same check: PayPal webhooks (as it happens), a sweep of every order Floorwalker knows about
 * (minutes later, and without webhooks), and each event is matched against the ledger. Anything PayPal moved that the
 * ledger can't account for becomes an incident: the owner is alerted and, by default, every agent is frozen.
 */

export type Incident = {
  id: number;
  kind: "refund" | "payout";
  paypal_ref: string;
  amount: number;
  counterparty: string | null;
  capture_id: string | null;
  detail: string;
  detected_by: "webhook" | "order sweep";
  created_at: string;
  frozen_agents: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: "mine" | "not_mine" | null;
};

const SYSTEM = { kind: "system" as const, id: "watch", name: "Floorwalker" };
const RACE_MS = 5 * 60_000;
const money = (n: number) => `$${n.toFixed(2)}`;

export const incidents = (): Incident[] => store.db().prepare("SELECT * FROM incidents ORDER BY id DESC LIMIT 100").all() as Incident[];
export const openIncidents = () => incidents().filter((i) => !i.resolved_at);

/** True when the ledger accounts for this PayPal object, or a request on the same capture is being executed right now. */
function accountedFor(ref: string, captureId?: string | null): boolean {
  const rows = store.ledger();
  if (rows.some((r) => r.paypal_ref === ref)) return true;
  if (!captureId) return false;
  const recent = Date.now() - RACE_MS;
  return rows.some((r) => r.kind === "refund" && r.status === "executing" && Date.parse(r.execution_started_at ?? r.decided_at ?? r.created_at) >= recent && JSON.parse(r.params).captureId === captureId);
}

function raise(i: Omit<Incident, "id" | "created_at" | "frozen_agents" | "resolved_at" | "resolved_by" | "resolution">): Incident | null {
  const r = store.db().prepare(`INSERT OR IGNORE INTO incidents (kind, paypal_ref, amount, counterparty, capture_id, detail, detected_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(i.kind, i.paypal_ref, i.amount, i.counterparty, i.capture_id, i.detail, i.detected_by, new Date().toISOString());
  if (!r.changes) return null;
  const id = Number(r.lastInsertRowid);
  let frozen: string[] = [];
  if (store.setting<boolean>("incident_freeze", true)) {
    frozen = store.agents().filter((a) => a.status === "active").map((a) => a.id);
    for (const a of frozen) {
      store.setAgentStatus(a, "frozen");
      publish("agent.frozen", { id: a, object: "agent", status: "frozen", reason: `incident ${id}` });
    }
    store.db().prepare("UPDATE incidents SET frozen_agents = ? WHERE id = ?").run(JSON.stringify(frozen), id);
  }
  audit("incident.opened", `inc_${id}`, { kind: i.kind, paypal_ref: i.paypal_ref, amount: i.amount, detected_by: i.detected_by, frozen_agents: frozen });
  const incident = incident_(id)!;
  publish("incident.opened", { ...incident, object: "incident" });
  return incident;
}

const incident_ = (id: number) => store.db().prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Incident | undefined;

/**
 * "mine": the owner made it themselves (e.g. in the PayPal dashboard); the agents frozen by this incident run again.
 * "not_mine": the agents stay frozen; the owner should rotate the PayPal app's secret.
 */
export function resolveIncident(id: number, by: string, resolution: "mine" | "not_mine"): Incident {
  const i = incident_(id);
  if (!i) throw Object.assign(new Error("No such incident"), { status: 404 });
  if (i.resolved_at) return i;
  store.db().prepare("UPDATE incidents SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?").run(new Date().toISOString(), by, resolution, id);
  if (resolution === "mine") {
    for (const a of JSON.parse(i.frozen_agents ?? "[]") as string[]) {
      if (store.setAgentStatus(a, "active")) publish("agent.unfrozen", { id: a, object: "agent", status: "active" });
    }
  }
  audit("incident.resolved", `inc_${id}`, { resolution });
  const out = incident_(id)!;
  publish("incident.resolved", { ...out, object: "incident" });
  return out;
}

/** Reads every order Floorwalker knows about from PayPal and checks each refund on it against the ledger. */
export async function sweepOrders(): Promise<{ orders: number; refunds: number; incidents: Incident[] }> {
  const since = Date.now() - 180 * 86_400_000;
  const orders = store.allOrders().filter((o) => Date.parse(o.created_at) >= since);
  const found: Incident[] = [];
  let refunds = 0;
  for (const o of orders) {
    let order: any;
    try {
      order = await getOrder(o.order_id);
    } catch {
      continue;
    }
    for (const r of order.purchase_units?.flatMap((u: any) => u.payments?.refunds ?? []) ?? []) {
      refunds++;
      if (r.status === "CANCELLED" || r.status === "FAILED" || accountedFor(r.id, o.capture_id)) continue;
      const amount = Number(r.amount?.value ?? 0);
      const inc = raise({
        kind: "refund", paypal_ref: r.id, amount, counterparty: o.customer_email, capture_id: o.capture_id, detected_by: "order sweep",
        detail: `A ${money(amount)} refund to ${o.customer_email} on order ${o.invoice_id} was made in PayPal without Floorwalker.`,
      });
      if (inc) found.push(inc);
    }
  }
  store.setSetting("watch.last_sweep", { at: new Date().toISOString(), orders: orders.length, refunds });
  return { orders: orders.length, refunds, incidents: found };
}

/** Handles one verified PayPal webhook event inside its workspace. */
export function handlePayPalEvent(event: any): { matched: boolean; incident: Incident | null } {
  const type = String(event?.event_type ?? "");
  const res = event?.resource ?? {};
  store.setSetting("watch.last_event", { at: new Date().toISOString(), type });
  if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") {
    // The resource is the refund; its "up" link points at the capture.
    const captureId = String(res.links?.find((l: any) => l.rel === "up")?.href ?? "").split("/").pop() || null;
    if (accountedFor(res.id, captureId)) return { matched: true, incident: null };
    const order = captureId ? store.orderByCapture(captureId) : undefined;
    const amount = Number(res.amount?.value ?? res.seller_payable_breakdown?.total_refunded_amount?.value ?? 0);
    const who = order?.customer_email ?? null;
    return {
      matched: false,
      incident: raise({
        kind: "refund", paypal_ref: String(res.id), amount, counterparty: who, capture_id: captureId, detected_by: "webhook",
        detail: `PayPal reports a ${money(amount)} refund${who ? ` to ${who}` : ""}${order ? ` on order ${order.invoice_id}` : ""} that did not go through Floorwalker.`,
      }),
    };
  }
  if (type.startsWith("PAYMENT.PAYOUTSBATCH.") || type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const batchId = String(res.batch_header?.payout_batch_id ?? res.payout_batch_id ?? "");
    const row = store.ledger().find((r) => r.paypal_ref === batchId);
    if (row) {
      // Keep the ledger's copy of the payout's state current (e.g. UNCLAIMED or RETURNED after it was sent).
      const status = res.transaction_status ?? res.batch_header?.batch_status;
      const previous = JSON.parse(row.paypal_result ?? "{}");
      const time = Date.parse(event.create_time);
      const previousTime = Date.parse(previous.webhook_time ?? "");
      const terminal = new Set(["SUCCESS", "SUCCEEDED", "RETURNED", "FAILED", "DENIED", "BLOCKED", "REFUNDED", "REVERSED", "CANCELED", "CANCELLED"]);
      // An undated first delivery may initialize status, but cannot overwrite one. Terminal states stay.
      if (status && (Number.isFinite(time) ? (!Number.isFinite(previousTime) || time > previousTime) : !previous.webhook_status) && !terminal.has(previous.webhook_status)) {
        store.setPaypalResult(row.id, { ...previous, webhook_status: status, webhook_time: Number.isFinite(time) ? new Date(time).toISOString() : null });
      }
      return { matched: true, incident: null };
    }
    if (!type.startsWith("PAYMENT.PAYOUTSBATCH.")) return { matched: false, incident: null };
    const amount = Number(res.batch_header?.amount?.value ?? 0);
    return {
      matched: false,
      incident: raise({
        kind: "payout", paypal_ref: batchId, amount, counterparty: null, capture_id: null, detected_by: "webhook",
        detail: `PayPal reports a ${money(amount)} payout batch ${batchId} that did not go through Floorwalker.`,
      }),
    };
  }
  return { matched: false, incident: null };
}

// ---------------------------------------------------------------- PayPal webhooks

export const WEBHOOK_EVENTS = [
  "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS", "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.FAILED", "PAYMENT.PAYOUTS-ITEM.BLOCKED",
];

export const webhookUrl = (key: string) => `${config.baseUrl}/api/paypal/webhook/${key}`;
export const canReceiveWebhooks = () => config.baseUrl.startsWith("https://") && !config.baseUrl.includes("localhost");

/** Registers (or finds) the webhook for this URL on a PayPal app and returns its id. */
export async function ensureWebhook(creds: PayPalCreds, url: string): Promise<string> {
  const list = await paypal<{ webhooks: { id: string; url: string }[] }>("GET", "/v1/notifications/webhooks", undefined, { creds });
  const existing = list.webhooks?.find((w) => w.url === url);
  if (existing) return existing.id;
  const made = await paypal<{ id: string }>("POST", "/v1/notifications/webhooks", { url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) }, { creds });
  return made.id;
}

/** Asks PayPal whether a delivery really came from PayPal for this webhook. */
export async function verifyPayPalWebhook(creds: PayPalCreds, webhookId: string, headers: Record<string, string | string[] | undefined>, event: unknown): Promise<boolean> {
  const h = (k: string) => String(headers[k] ?? "");
  if (!h("paypal-transmission-sig")) return false;
  try {
    const out = await paypal<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"), webhook_id: webhookId, webhook_event: event,
    }, { creds });
    return out.verification_status === "SUCCESS";
  } catch (e) {
    // PayPal rejects malformed verification inputs with 400/422; these are invalid deliveries.
    // Keep outages/auth errors retryable rather than acknowledging an unverified event.
    if (e instanceof PayPalError && (e.status === 400 || e.status === 422)) return false;
    throw e;
  }
}

/**
 * Demo workspaces share one PayPal sandbox app, so its webhook is shared too: an event is routed to the demo workspace
 * that owns the capture or the payout batch.
 */
export function demoWorkspaceFor(event: any): Workspace | undefined {
  const res = event?.resource ?? {};
  const captureId = String(res.links?.find((l: any) => l.rel === "up")?.href ?? "").split("/").pop();
  const batchId = String(res.batch_header?.payout_batch_id ?? res.payout_batch_id ?? "");
  for (const ws of openWorkspaces()) {
    if (!ws.demo) continue;
    const mine = inWorkspace(ws, SYSTEM, () =>
      (captureId && store.orderByCapture(captureId)) || (batchId && store.ledger().some((r) => r.paypal_ref === batchId)));
    if (mine) return ws;
  }
  return undefined;
}

// ---------------------------------------------------------------- demo: a refund that skips Floorwalker

/**
 * For the demo only: refunds part of one of the shop's paid orders straight through the PayPal API, the way an agent
 * holding the PayPal key could, then sweeps the shop's orders. Floorwalker finds a refund its ledger can't account for.
 */
export async function simulateBypass(): Promise<{ refund: { id: string; amount: number; invoice: string }; incident: Incident | null }> {
  if (!ctx().ws.demo) throw Object.assign(new Error("Only in the demo"), { status: 400 });
  // An order no refund has touched yet (a blocked or declined attempt never reached PayPal).
  const refunded = (o: store.OrderRow) => store.ledger().some((r) => r.kind === "refund" && ["executed", "approved", "executing"].includes(r.status) && JSON.parse(r.params).captureId === o.capture_id);
  const order = store.allOrders().find((o) => o.amount >= 30 && !refunded(o) && !incidents().some((i) => i.capture_id === o.capture_id));
  if (!order) throw Object.assign(new Error("No untouched order left to refund. Reset the demo first."), { status: 409 });
  const amount = 25;
  const refund = await refundCapture(order.capture_id, { currency_code: "USD", value: amount.toFixed(2) }, "Refund", `bypass-${order.capture_id}`);
  const { incidents: found } = await sweepOrders();
  return { refund: { id: refund.id, amount, invoice: order.invoice_id }, incident: found.find((i) => i.paypal_ref === refund.id) ?? null };
}
