import { existsSync } from "node:fs";
import { ctx } from "./context.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

function readEnv(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

/** Prefer the current product prefix while keeping existing .env files working. */
export function env(name: string, fallback = ""): string {
  return (process.env[`FLOORWALKER_${name}`] ?? process.env[`ALLOWANCE_${name}`] ?? fallback).trim();
}

/** Claude when an Anthropic key is present, otherwise Gemini. */
function aiConfig() {
  const provider = readEnv("ANTHROPIC_API_KEY") || readEnv("ANTHROPIC_AUTH_TOKEN") ? "anthropic" : readEnv("GEMINI_API_KEY") ? "gemini" : null;
  const fallback = provider === "gemini" ? readEnv("GEMINI_MODEL", "gemini-3.8-flash") : "claude-sonnet-5-5";
  return {
    provider: provider as "anthropic" | "gemini" | null,
    configured: provider !== null,
    agentModel: env("AGENT_MODEL") || fallback,
    reviewModel: env("REVIEW_MODEL") || fallback,
  };
}

export const config = {
  port: Number(readEnv("PORT", "3000")),
  production: readEnv("NODE_ENV") === "production",
  dbPath: env("DB", !existsSync("data/floorwalker.db") && existsSync("data/allowance.db") ? "data/allowance.db" : "data/floorwalker.db"),
  // Accounts, sessions and the list of workspaces; each workspace's money data lives in its own file under dataDir.
  coreDbPath: env("CORE_DB", "data/core.db"),
  dataDir: env("DATA_DIR", "data/ws"),
  // Public URL of the app (passkeys and auth cookies are bound to it).
  baseUrl: env("BASE_URL", `http://localhost:${readEnv("PORT", "3000")}`),
  authSecret: readEnv("BETTER_AUTH_SECRET"),
  paypal: {
    clientId: readEnv("PAYPAL_CLIENT_ID"),
    clientSecret: readEnv("PAYPAL_CLIENT_SECRET"),
    // Sandbox only. There is deliberately no switch to the live API.
    baseUrl: "https://api-m.sandbox.paypal.com",
  },
  ai: aiConfig(),
  demo: {
    payeeEmail: readEnv("DEMO_PAYEE_EMAIL"),
  },
};

/** Whether the current workspace has connected a PayPal sandbox app. */
export function paypalConfigured(): boolean {
  return Boolean(ctx().ws.paypal);
}
