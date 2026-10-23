import { randomUUID } from "node:crypto";
import { config } from "../config.ts";

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

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
  const { clientId, clientSecret, baseUrl } = config.paypal;
  if (!clientId || !clientSecret) throw new Error("PayPal sandbox credentials are not set (see .env.example)");
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new PayPalError(`PayPal OAuth failed: ${body.error_description ?? res.status}`, res.status, undefined, body);
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
  return cachedToken.value;
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
