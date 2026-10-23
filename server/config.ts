import { existsSync } from "node:fs";

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

export function paypalConfigured(): boolean {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}
