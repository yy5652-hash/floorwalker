import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

export type PayPalCreds = { clientId: string; clientSecret: string };

/** One business: its own database file and its own PayPal sandbox app. */
export type Workspace = {
  id: string;
  name: string;
  db: DatabaseSync;
  paypal: PayPalCreds | null;
  demo: boolean;
};

/** Who is acting: a signed-in person, an agent key, or Allowance itself (expiry, polling). */
export type Actor = { kind: "user" | "agent" | "system"; id: string; name: string; role?: string; onBehalfOf?: string; ip?: string };

type Ctx = { ws: Workspace; actor: Actor };

const als = new AsyncLocalStorage<Ctx>();
let fallback: (() => Workspace) | null = null;

/**
 * Scripts, tests, the benchmark and the stdio MCP server work on one local workspace.
 * The web server turns it off, so a request that forgot to pick a workspace fails
 * instead of reading someone else's data.
 */
export function setDefaultWorkspace(open: (() => Workspace) | null) {
  fallback = open;
}

export function ctx(): Ctx {
  const c = als.getStore();
  if (c) return c;
  if (fallback) return { ws: fallback(), actor: { kind: "system", id: "local", name: "Owner" } };
  throw new Error("No workspace for this request");
}

export function inWorkspace<T>(ws: Workspace, actor: Actor, fn: () => T): T {
  return als.run({ ws, actor }, fn);
}
