import express, { type Response } from "express";
import { existsSync } from "node:fs";
import { simulateHijack } from "./agent/attack.ts";
import { handleTicket, type AgentEvent } from "./agent/run.ts";
import { config, paypalConfigured } from "./config.ts";
import * as store from "./db.ts";
import { seedDemo } from "./demo.ts";
import { compilePolicy } from "./guard/compile.ts";
import { approve, declineRequest } from "./guard/index.ts";
import { getPayoutBatch } from "./paypal/api.ts";
import { validatePolicy } from "./guard/policy.ts";

const app = express();
app.use(express.json({ limit: "200kb" }));

function parseRow(r: store.LedgerRow) {
  return {
    ...r,
    params: JSON.parse(r.params),
    checks: JSON.parse(r.checks),
    review: r.review ? JSON.parse(r.review) : null,
    paypal_result: r.paypal_result ? JSON.parse(r.paypal_result) : null,
  };
}

function stats() {
  const rows = store.ledger();
  const moved = rows.filter((r) => r.status === "executed" || r.status === "approved");
  return {
    moved: moved.reduce((t, r) => t + r.amount, 0),
    autoApproved: rows.filter((r) => r.status === "executed").length,
    awaiting: rows.filter((r) => r.status === "awaiting_approval").length,
    blocked: rows.filter((r) => r.status === "blocked").length,
    stopped: rows.filter((r) => r.status === "blocked" || r.status === "declined").reduce((t, r) => t + r.amount, 0),
  };
}

app.get("/api/state", (_req, res) => {
  const p = store.activePolicy();
  res.json({
    configured: { paypal: paypalConfigured(), ai: config.ai.configured, provider: config.ai.provider, agentModel: config.ai.agentModel, reviewModel: config.ai.reviewModel },
    policy: p,
    tickets: store.tickets(),
    orders: store.allOrders(),
    ledger: store.ledger().map(parseRow),
    stats: stats(),
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
    res.json(parseRow(await approve(Number(req.params.id), "owner")));
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
    res.json({ policy: await compilePolicy(text, store.activePolicy().policy) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
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
