import { config } from "./config.ts";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ "application/json": { schema } });
const errors = {
  "400": { description: "Invalid request", content: json(ref("Error")) },
  "401": { description: "Missing or invalid API key", content: json(ref("Error")) },
  "429": { description: "Rate limited (120 calls a minute per key)", content: json(ref("Error")) },
};

const Action = {
  type: "object",
  properties: {
    id: { type: "string", example: "act_42" },
    object: { const: "action" },
    type: { enum: ["refund", "payout"] },
    status: { enum: ["executed", "awaiting_approval", "approved", "declined", "blocked", "failed", "executing"], description: "Where the request stands. awaiting_approval: poll GET /v1/actions/{id} or subscribe to webhooks." },
    decision: { enum: ["allow", "hold", "block"] },
    amount: { type: "number" },
    approved_amount: { type: ["number", "null"], description: "Set when the owner approved a smaller amount" },
    currency: { const: "USD" },
    counterparty: { type: ["string", "null"] },
    agent_id: { type: "string" },
    reason: { type: "string" },
    checks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, outcome: { enum: ["pass", "hold", "block"] }, detail: { type: "string" } } } },
    review: { type: ["object", "null"], properties: { verdict: { enum: ["approve", "escalate", "reject"] }, summary: { type: "string" }, cited_rule: { type: "string" }, injection_detected: { type: "boolean" } } },
    paypal_ref: { type: ["string", "null"], description: "PayPal refund id or payout batch id once money moved" },
    decline_reason: { type: ["string", "null"] },
    created_at: { type: "string", format: "date-time" },
    decided_at: { type: ["string", "null"], format: "date-time" },
    expires_at: { type: ["string", "null"], format: "date-time", description: "A held request not answered by then is declined" },
    message: { type: "string", description: "What the agent should do next, in words (only on create)" },
  },
};

/** OpenAPI 3.1 description of the agent API; request bodies come from the same schemas the server validates with. */
export function buildOpenApi(bodies: { refund: unknown; payout: unknown }) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Allowance agent API",
      version: "1.0.0",
      description: "Call Allowance instead of PayPal. Each money move is checked against the owner's rules and an AI review, then executed in PayPal, held for the owner, or blocked. PayPal sandbox only.",
    },
    servers: [{ url: `${config.baseUrl.replace(/\/$/, "")}/v1` }],
    security: [{ agentKey: [] }],
    paths: {
      "/agent": { get: { summary: "The agent this key belongs to, with its permissions and limits", responses: { "200": { description: "The agent" }, ...errors } } },
      "/refunds": {
        post: {
          summary: "Refund a PayPal capture",
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 }, description: "Retrying with the same key returns the first result and never moves money twice" }],
          requestBody: { required: true, content: json(bodies.refund) },
          responses: { "200": { description: "The action, executed, held or blocked", content: json(ref("Action")) }, ...errors },
        },
      },
      "/payouts": {
        post: {
          summary: "Pay someone with PayPal Payouts",
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 } }],
          requestBody: { required: true, content: json(bodies.payout) },
          responses: { "200": { description: "The action, executed, held or blocked", content: json(ref("Action")) }, ...errors },
        },
      },
      "/actions/{id}": {
        get: {
          summary: "One of this agent's actions",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "The action", content: json(ref("Action")) }, "404": { description: "Not found", content: json(ref("Error")) } },
        },
      },
      "/actions": {
        get: {
          summary: "This agent's recent actions",
          parameters: [{ name: "status", in: "query", required: false, schema: { type: "string" } }],
          responses: { "200": { description: "Up to 100 actions, newest first" } },
        },
      },
      "/mcp": { post: { summary: "MCP over Streamable HTTP (stateless) with the same tools and checks", responses: { "200": { description: "MCP response" } } } },
    },
    components: {
      securitySchemes: { agentKey: { type: "http", scheme: "bearer", description: "An agent key (alw_…) from Developers in Allowance" } },
      schemas: {
        Action,
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } } } },
      },
    },
  };
}
