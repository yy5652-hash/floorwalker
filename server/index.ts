import express, { type Response } from "express";
import { existsSync } from "node:fs";
import { simulateHijack } from "./agent/attack.ts";
import { handleTicket, type AgentEvent } from "./agent/run.ts";
import { config, paypalConfigured } from "./config.ts";
import * as store from "./db.ts";
import { ensureAgents, seedDemo } from "./demo.ts";
import { compilePolicy } from "./guard/compile.ts";
import { approve, declineRequest } from "./guard/index.ts";
import { getPayoutBatch } from "./paypal/api.ts";
import { validatePolicy } from "./guard/policy.ts";
import { simulate } from "./guard/simulate.ts";

ensureAgents();

const app = express();
app.set("trust proxy", "loopback");
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

app.get("/api/state", (_req, res) => {
  const p = store.activePolicy();
  const rows = store.ledger();
  res.json({
    configured: { paypal: paypalConfigured(), ai: config.ai.configured, provider: config.ai.provider, agentModel: config.ai.agentModel, reviewModel: config.ai.reviewModel },
    policy: p,
    tickets: store.tickets(),
    orders: store.allOrders(),
    ledger: rows.map(parseRow),
    metrics: metrics(rows),
    agents: agentsWithStats(rows, p.policy),
  });
});

let busy = false;

async function stream(res: Response, work: (emit: (e: AgentEvent) => void) => Promise<void>) {
  if (busy) {
    res.status(409).json({ error: "The agent is already working on something." });
    return;
  }
  busy = true;
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const emit = (e: AgentEvent) => res.write(`${JSON.stringify(e)}\n`);
  try {
    await work(emit);
  } catch (e: any) {
    emit({ type: "error", message: e.message });
  } finally {
    busy = false;
    res.end();
  }
}

app.post("/api/tickets/:id/run", (req, res) => {
  if (!paypalConfigured() || !config.ai.configured) {
    res.status(400).json({ error: "Set PayPal sandbox credentials and an Anthropic or Gemini key in .env first." });
    return;
  }
  void stream(res, (emit) => handleTicket(req.params.id, emit));
});

app.post("/api/attack", (_req, res) => {
  void stream(res, (emit) => simulateHijack(emit));
});

app.post("/api/ledger/:id/approve", async (req, res) => {
  try {
    const amount = req.body?.amount === undefined ? undefined : Number(req.body.amount);
    res.json(parseRow(await approve(Number(req.params.id), "owner", amount)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/ledger/:id/decline", (req, res) => {
  try {
    res.json(parseRow(declineRequest(Number(req.params.id), "owner")));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/policy/compile", async (req, res) => {
  try {
    const text = String(req.body?.text ?? "").slice(0, 4000);
    res.json(await compilePolicy(text, store.activePolicy().policy));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/policy/simulate", (req, res) => {
  try {
    res.json(simulate(validatePolicy(req.body?.policy)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/policy/versions", (_req, res) => {
  res.json(store.policyVersions());
});

app.post("/api/policy/restore/:id", (req, res) => {
  const v = store.policyVersion(Number(req.params.id));
  if (!v) {
    res.status(404).json({ error: "No such version" });
    return;
  }
  res.json(store.savePolicy(v.text, v.policy));
});

app.post("/api/agents/:id/freeze", (req, res) => {
  if (!store.setAgentStatus(req.params.id, "frozen")) return void res.status(404).json({ error: "No such agent" });
  res.json(store.agent(req.params.id));
});

app.post("/api/agents/:id/unfreeze", (req, res) => {
  if (!store.setAgentStatus(req.params.id, "active")) return void res.status(404).json({ error: "No such agent" });
  res.json(store.agent(req.params.id));
});

app.post("/api/policy", (req, res) => {
  try {
    const policy = validatePolicy(req.body?.policy);
    res.json(store.savePolicy(String(req.body?.text ?? ""), policy));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/demo/reset", async (_req, res) => {
  if (busy) {
    res.status(409).json({ error: "The agent is busy." });
    return;
  }
  busy = true;
  const log: string[] = [];
  try {
    await seedDemo((s) => log.push(s));
    res.json({ ok: true, log });
  } catch (e: any) {
    res.status(500).json({ error: e.message, log });
  } finally {
    busy = false;
  }
});

if (config.production) {
  if (!existsSync("dist/web/index.html")) throw new Error("Run `npm run build` first");
  app.use(express.static("dist/web"));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile("index.html", { root: "dist/web" }));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

// Payout batches settle a few seconds after they are sent; keep the ledger's copy current.
setInterval(async () => {
  if (!paypalConfigured()) return;
  const pending = store.ledger().filter((r) => r.tool === "send_payout" && r.paypal_ref && ["executed", "approved"].includes(r.status)
    && ["PENDING", "PROCESSING"].includes(JSON.parse(r.paypal_result ?? "{}")?.batch_header?.batch_status));
  for (const r of pending.slice(0, 5)) {
    try {
      store.setPaypalResult(r.id, await getPayoutBatch(r.paypal_ref!));
    } catch {
      // Try again on the next tick.
    }
  }
}, 15_000).unref();

app.listen(config.port, () => {
  console.log(`Allowance on http://localhost:${config.port}  (PayPal sandbox: ${paypalConfigured() ? "ready" : "missing credentials"}, AI: ${config.ai.provider ?? "missing key"} ${config.ai.agentModel})`);
});
