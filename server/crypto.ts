import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.ts";

let secret: string | null = null;

/** BETTER_AUTH_SECRET, or a random one kept next to the core database (never committed). */
export function serverSecret(): string {
  if (secret) return secret;
  if (config.authSecret) return (secret = config.authSecret);
  const file = join(dirname(config.coreDbPath), "server.secret");
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  }
  return (secret = readFileSync(file, "utf8").trim());
}

const key = (purpose: string) => Buffer.from(hkdfSync("sha256", serverSecret(), "allowance", purpose, 32));

/** AES-256-GCM; the output carries its own nonce and tag. */
export function seal(plain: string, purpose = "paypal-credentials"): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(purpose), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(sealed: string, purpose = "paypal-credentials"): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable sealed value");
  const d = createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
