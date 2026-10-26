import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { ctx, type PayPalCreds } from "../context.ts";

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId: string | undefined,
    readonly details: unknown,
  ) {
    super(message);
  }
}

// One cached token per PayPal app (each workspace connects its own).
const tokens = new Map<string, { value: string; expiresAt: number }>();

/** The current workspace's PayPal sandbox app. */
export function paypalCreds(): PayPalCreds {
  const creds = ctx().ws.paypal;
  if (!creds) throw new Error("Connect a PayPal sandbox app in Settings first");
  return creds;
}

export async function accessToken(creds: PayPalCreds = paypalCreds()): Promise<string> {
  const cached = tokens.get(creds.clientId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.value;
  const res = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new PayPalError(`PayPal OAuth failed: ${body.error_description ?? res.status}`, res.status, undefined, body);
  }
  tokens.set(creds.clientId, { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 });
  return body.access_token;
}

type Options = {
  // PayPal-Request-Id makes POSTs idempotent: a retried request returns the original result.
  requestId?: string;
  headers?: Record<string, string>;
};

export async function paypal<T = any>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  const token = await accessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...opts.headers,
  };
  if (method !== "GET") headers["PayPal-Request-Id"] = opts.requestId ?? randomUUID();
  const res = await fetch(`${config.paypal.baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = data?.details?.[0];
    const msg = detail ? `${detail.issue}: ${detail.description ?? ""}` : (data?.message ?? data?.name ?? res.statusText);
    throw new PayPalError(`PayPal ${method} ${path} → ${res.status} ${msg}`, res.status, data?.debug_id, data);
  }
  return data as T;
}
