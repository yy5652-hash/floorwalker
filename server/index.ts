import { toNodeHandler } from "better-auth/node";
import express, { type Response } from "express";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { simulateHijack } from "./agent/attack.ts";
import { handleTicket, type AgentEvent } from "./agent/run.ts";
import { auth } from "./auth.ts";
import { config, paypalConfigured } from "./config.ts";
import { ctx, inWorkspace, setDefaultWorkspace } from "./context.ts";
import * as store from "./db.ts";
import { seedDemo } from "./demo.ts";
import { audit } from "./audit.ts";
import { publish } from "./events.ts";
import { handle, HttpError, need, signedIn } from "./http.ts";
import { manage, stepUpOver } from "./manage.ts";
import { remindWaiting } from "./notify.ts";
import { v1 } from "./v1.ts";
import { core, openWorkspace, openWorkspaces, workspaceRow } from "./workspaces.ts";
import { compilePolicy } from "./guard/compile.ts";
import { approve, declineRequest, expireOverdue } from "./guard/index.ts";
import { getPayoutBatch } from "./paypal/api.ts";
import { validatePolicy } from "./guard/policy.ts";
import { simulate } from "./guard/simulate.ts";

// Every request names its workspace; nothing falls back to a shared database.
setDefaultWorkspace(null);

const app = express();
app.set("trust proxy", "loopback");
app.use(helmet({
  contentSecurityPolicy: config.production
    ? { directives: {
      "default-src": ["'self'"], "img-src": ["'self'", "data:", "blob:"], "style-src": ["'self'", "'unsafe-inline'"], "font-src": ["'self'", "data:"], "frame-ancestors": ["'self'"],
      "upgrade-insecure-requests": config.baseUrl.startsWith("https:") ? [] : null,
    } }
    : false,
  strictTransportSecurity: config.baseUrl.startsWith("https:"),
  crossOriginEmbedderPolicy: false,
}));
// better-auth reads its own request bodies, so it is mounted before the JSON parser.
app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json({ limit: "200kb" }));

// A hosted demo spends real model calls, so each visitor gets a fair share per hour.
const RUNS_PER_HOUR = Number(process.env.ALLOWANCE_RUNS_PER_HOUR ?? 60);
const runLog = new Map<string, number[]>();
app.use(["/api/tickets", "/api/attack", "/api/demo/reset", "/api/policy/compile"], (req, res, next) => {
  if (req.method !== "POST") return next();
  const key = req.ip ?? "local";
  const since = Date.now() - 3_600_000;
  const recent = (runLog.get(key) ?? []).filter((t) => t > since);
  if (recent.length >= RUNS_PER_HOUR) {
    res.status(429).json({ error: "That's a lot of runs for one hour. Please try again a little later." });
    return;
  }
  runLog.set(key, [...recent, Date.now()]);
  next();
});

function parseRow(r: store.LedgerRow) {
  return {
    ...r,
    params: JSON.parse(r.params),
    checks: JSON.parse(r.checks),
    review: r.review ? JSON.parse(r.review) : null,
    paypal_result: r.paypal_result ? JSON.parse(r.paypal_result) : null,
  };
}

const moved = (r: store.LedgerRow) => r.approved_amount ?? r.amount;
const sum = (rows: store.LedgerRow[]) => rows.reduce((t, r) => t + moved(r), 0);

/** The numbers an owner checks first: money moved, waiting and stopped, how much ran without them, how fast they answer. */
function metrics(rows: store.LedgerRow[]) {
  const by = (...st: store.LedgerStatus[]) => rows.filter((r) => st.includes(r.status));
  const auto = by("executed"), approved = by("approved"), declined = by("declined"), waiting = by("awaiting_approval"), blocked = by("blocked");
  const decided = [...approved, ...declined].filter((r) => r.decided_at).map((r) => (Date.parse(r.decided_at!) - Date.parse(r.created_at)) / 60_000).sort((a, b) => a - b);
  const reachable = auto.length + approved.length + declined.length + waiting.length;
  return {
    moved: sum([...auto, ...approved]),
    movedCount: auto.length + approved.length,
    waiting: sum(waiting),
    waitingCount: waiting.length,
    stopped: sum([...blocked, ...declined]),
    stoppedCount: blocked.length + declined.length,
    automationRate: reachable ? auto.length / reachable : null,
    medianApprovalMinutes: decided.length ? decided[Math.floor(decided.length / 2)] : null,
    funnel: { auto: auto.length, approved: approved.length, declined: declined.length, waiting: waiting.length, blocked: blocked.length },
  };
}

function agentsWithStats(rows: store.LedgerRow[], policy: ReturnType<typeof store.activePolicy>["policy"]) {
  return store.agents().map((a) => {
    const mine = rows.filter((r) => r.agent_id === a.id);
    const budget = a.can_refund && !a.can_payout ? policy.refunds.budget : a.can_payout && !a.can_refund ? policy.payouts.budget : null;
    const days = budget ? ({ day: 1, week: 7, month: 30 } as const)[budget.period] : 7;
    const since = Date.now() - days * 86_400_000;
    const spent = sum(mine.filter((r) => (r.status === "executed" || r.status === "approved") && Date.parse(r.decided_at ?? r.created_at) >= since));
    return { ...a, budget, spent, metrics: metrics(mine), last: mine[0]?.created_at ?? null };
  });
}

// Agents call /v1 with an agent key.
app.use("/v1", v1);

// Everything under /api below needs a signed-in member and runs inside their active workspace.
app.use("/api", signedIn);
app.use("/api", manage);

app.get("/api/state", (req, res) => {
  expireOverdue();
  const p = store.activePolicy();
  const rows = store.ledger();
  const { ws } = ctx();
  const w = workspaceRow(ws.id)!;
  res.json({
    me: req.me,
    workspace: {
      id: ws.id, name: ws.name, demo: ws.demo, plan: w.plan, seedStatus: w.seed_status,
      paypal: { connected: Boolean(ws.paypal), own: Boolean(w.paypal_client_id), clientIdHint: w.paypal_client_id ? `${w.paypal_client_id.slice(0, 6)}…${w.paypal_client_id.slice(-4)}` : null, verifiedAt: w.paypal_verified_at, merchant: w.paypal_merchant },
    },
    configured: { paypal: paypalConfigured(), ai: config.ai.configured, provider: config.ai.provider, agentModel: config.ai.agentModel, reviewModel: config.ai.reviewModel },
    policy: p,
    tickets: store.tickets(),
    orders: store.allOrders(),
    ledger: rows.map(parseRow),
    metrics: metrics(rows),
    agents: agentsWithStats(rows, p.policy),
  });
});

// One agent run at a time per workspace.
const busy = new Set<string>();

async function stream(res: Response, work: (emit: (e: AgentEvent) => void) => Promise<void>) {
  const id = ctx().ws.id;
  if (busy.has(id)) {
    res.status(409).json({ error: "The agent is already working on something." });
    return;
  }
  busy.add(id);
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const emit = (e: AgentEvent) => res.write(`${JSON.stringify(e)}\n`);
  try {
    await work(emit);
  } catch (e: any) {
    emit({ type: "error", message: e.message });
  } finally {
    busy.delete(id);
    res.end();
  }
}

app.post("/api/tickets/:id/run", need({ agents: ["manage"] }), (req, res) => {
  if (!paypalConfigured() || !config.ai.configured) {
    res.status(400).json({ error: "Connect a PayPal sandbox app in Settings first." });
    return;
  }
  void stream(res, (emit) => handleTicket(String(req.params.id), emit));
});

app.post("/api/attack", need({ agents: ["manage"] }), (_req, res) => {
  void stream(res, (emit) => simulateHijack(emit));
});

// Large approvals need a recent passkey sign-in from anyone who has a passkey (step-up, like a bank's).
const STEP_UP_WINDOW_MS = 10 * 60_000;
const hasPasskey = (userId: string) => Boolean(core.prepare("SELECT 1 FROM passkey WHERE userId = ? LIMIT 1").get(userId));

app.post("/api/ledger/:id/approve", need({ ledger: ["approve"] }), handle(async (req) => {
  const id = Number(req.params.id);
  const row = store.ledgerEntry(id);
  if (!row) throw new HttpError(404, `No request #${id}`);
  const amount = req.body?.amount === undefined ? undefined : Number(req.body.amount);
  const me = req.me!;
  if ((amount ?? row.amount) > stepUpOver() && hasPasskey(me.userId) && Date.now() - me.signedInAt > STEP_UP_WINDOW_MS) {
    throw new HttpError(401, `Approving more than $${stepUpOver()} needs a fresh passkey check.`, "step_up");
  }
  const allowPayeeDays = req.body?.allow_payee_days === undefined ? undefined : Number(req.body.allow_payee_days);
  return parseRow(await approve(id, me.name, { amount, allowPayeeDays, note: req.body?.note ? String(req.body.note).slice(0, 500) : undefined }));
}));

app.post("/api/ledger/:id/decline", need({ ledger: ["approve"] }), handle((req) =>
  parseRow(declineRequest(Number(req.params.id), req.me!.name, req.body?.reason ? String(req.body.reason) : undefined))));

app.post("/api/policy/compile", need({ rules: ["update"] }), handle(async (req) => {
  const text = String(req.body?.text ?? "").slice(0, 4000);
  return compilePolicy(text, store.activePolicy().policy);
}));

app.post("/api/policy/simulate", handle((req) => simulate(validatePolicy(req.body?.policy))));

app.get("/api/policy/versions", handle(() => store.policyVersions()));

app.post("/api/policy/restore/:id", need({ rules: ["update"] }), handle((req) => {
  const v = store.policyVersion(Number(req.params.id));
  if (!v) throw new HttpError(404, "No such version");
  const saved = store.savePolicy(v.text, v.policy);
  audit("rules.restored", `rules_v${saved.id}`, { from_version: v.id });
  publish("rules.updated", { id: saved.id, object: "rules", text: saved.text, policy: saved.policy });
  return saved;
}));

app.post("/api/policy", need({ rules: ["update"] }), handle((req) => {
  const policy = validatePolicy(req.body?.policy);
  const saved = store.savePolicy(String(req.body?.text ?? ""), policy);
  audit("rules.updated", `rules_v${saved.id}`, { text: saved.text });
  publish("rules.updated", { id: saved.id, object: "rules", text: saved.text, policy: saved.policy });
  return saved;
}));

/** Reloads the sample shop: fresh paid sandbox orders and the demo inbox. */
app.post("/api/demo/reset", need({ rules: ["update"] }), async (_req, res) => {
  const id = ctx().ws.id;
  if (!paypalConfigured()) return void res.status(400).json({ error: "Connect a PayPal sandbox app in Settings first." });
  if (busy.has(id)) return void res.status(409).json({ error: "The agent is busy." });
  busy.add(id);
  const log: string[] = [];
  try {
    await seedDemo((s) => log.push(s));
    audit("demo.reset");
    res.json({ ok: true, log });
  } catch (e: any) {
    res.status(500).json({ error: e.message, log });
  } finally {
    busy.delete(id);
  }
});

app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found" }));

if (config.production) {
  if (!existsSync("dist/web/index.html")) throw new Error("Run `npm run build` first");
  app.use(express.static("dist/web"));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile("index.html", { root: "dist/web" }));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

// Workspaces in use lately are opened at start, so expiry, reminders and webhooks keep running for them.
for (const { id } of core.prepare("SELECT id FROM workspace WHERE demo = 0 OR created_at > ?").all(new Date(Date.now() - 3 * 86_400_000).toISOString()) as { id: string }[]) {
  try {
    openWorkspace(id);
  } catch (e: any) {
    console.error(`workspace ${id}: ${e.message}`);
  }
}

// Held requests nobody answered in time are declined (fail closed); ones waiting a while get one reminder.
setInterval(() => {
  for (const ws of openWorkspaces()) {
    inWorkspace(ws, { kind: "system", id: "expiry", name: "Allowance" }, () => {
      expireOverdue();
      void remindWaiting().catch((e) => console.error(`reminders ${ws.id}: ${e.message}`));
    });
  }
}, 60_000).unref();

// Payout batches settle a few seconds after they are sent; keep the ledger's copy current.
setInterval(async () => {
  for (const ws of openWorkspaces()) {
    if (!ws.paypal) continue;
    await inWorkspace(ws, { kind: "system", id: "payout-poller", name: "Allowance" }, async () => {
      const pending = store.ledger().filter((r) => r.tool === "send_payout" && r.paypal_ref && ["executed", "approved"].includes(r.status)
        && ["PENDING", "PROCESSING"].includes(JSON.parse(r.paypal_result ?? "{}")?.batch_header?.batch_status));
      for (const r of pending.slice(0, 5)) {
        try {
          store.setPaypalResult(r.id, await getPayoutBatch(r.paypal_ref!));
        } catch {
          // Try again on the next tick.
        }
      }
    });
  }
}, 15_000).unref();

app.listen(config.port, () => {
  console.log(`Allowance on ${config.baseUrl}  (demo PayPal sandbox app: ${config.paypal.clientId ? "set" : "missing"}, AI: ${config.ai.provider ?? "missing key"} ${config.ai.agentModel})`);
});
