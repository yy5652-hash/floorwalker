import { existsSync } from "node:fs";
import { ctx } from "./context.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

/** Claude when an Anthropic key is present, otherwise Gemini. */
function aiConfig() {
  const provider = env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN") ? "anthropic" : env("GEMINI_API_KEY") ? "gemini" : null;
  const fallback = provider === "gemini" ? env("GEMINI_MODEL", "gemini-3.8-flash") : "claude-sonnet-5-5";
  return {
    provider: provider as "anthropic" | "gemini" | null,
    configured: provider !== null,
    agentModel: env("ALLOWANCE_AGENT_MODEL") || fallback,
    reviewModel: env("ALLOWANCE_REVIEW_MODEL") || fallback,
  };
}

export const config = {
  port: Number(env("PORT", "3000")),
  production: env("NODE_ENV") === "production",
  dbPath: env("ALLOWANCE_DB", "data/allowance.db"),
  // Accounts, sessions and the list of workspaces; each workspace's money data lives in its own file under dataDir.
  coreDbPath: env("ALLOWANCE_CORE_DB", "data/core.db"),
  dataDir: env("ALLOWANCE_DATA_DIR", "data/ws"),
  // Public URL of the app (passkeys and auth cookies are bound to it).
  baseUrl: env("ALLOWANCE_BASE_URL", `http://localhost:${env("PORT", "3000")}`),
  authSecret: env("BETTER_AUTH_SECRET"),
  paypal: {
    clientId: env("PAYPAL_CLIENT_ID"),
    clientSecret: env("PAYPAL_CLIENT_SECRET"),
    // Sandbox only. There is deliberately no switch to the live API.
    baseUrl: "https://api-m.sandbox.paypal.com",
  },
  ai: aiConfig(),
  demo: {
    payeeEmail: env("DEMO_PAYEE_EMAIL"),
  },
};

/** Whether the current workspace has connected a PayPal sandbox app. */
export function paypalConfigured(): boolean {
  return Boolean(ctx().ws.paypal);
}
