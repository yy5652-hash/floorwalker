import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI, type Content, type Part, ThinkingLevel } from "@google/genai";
import { z } from "zod/v4";
import { config, env } from "./config.ts";

// Floorwalker runs on Claude when ANTHROPIC_API_KEY is set, otherwise on Gemini.
let anthropicClient: Anthropic | null = null;
let geminiClient: GoogleGenAI | null = null;

function requireModel() {
  if (!config.ai.provider) throw new Error("Set ANTHROPIC_API_KEY or GEMINI_API_KEY (see .env.example)");
}

export function anthropic(): Anthropic {
  anthropicClient ??= new Anthropic();
  return anthropicClient;
}

export function gemini(): GoogleGenAI {
  geminiClient ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
}

/** One structured call: the model's answer is parsed and validated against the schema. */
export async function structured<S extends z.ZodType>(opts: StructuredOpts<S>): Promise<z.infer<S>> {
  requireModel();
  try {
    const out = await primaryStructured(opts);
    usingFallback = false;
    return out;
  } catch (e) {
    if (!fallbackEnabled()) throw e;
    noteFallback(e);
    return deepseekStructured(opts);
  }
}

type StructuredOpts<S extends z.ZodType> = {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  effort?: "low" | "medium" | "high";
  /** Gemini only: spend little time thinking. For small text edits; never for decisions. */
  quick?: boolean;
};

async function primaryStructured<S extends z.ZodType>(opts: StructuredOpts<S>): Promise<z.infer<S>> {
  if (config.ai.provider === "anthropic") {
    const res = await anthropic().messages.parse({
      model: opts.model,
      max_tokens: 8000,
      system: opts.system,
      output_config: { format: zodOutputFormat(opts.schema), effort: opts.effort ?? "low" },
      messages: [{ role: "user", content: opts.prompt }],
    });
    if (res.stop_reason === "refusal") throw new Error(`Model declined: ${res.stop_details?.explanation ?? "refusal"}`);
    if (!res.parsed_output) throw new Error("Model returned no parseable output");
    return res.parsed_output as z.infer<S>;
  }
  const res = await gemini().models.generateContent({
    model: opts.model,
    contents: opts.prompt,
    config: {
      systemInstruction: opts.system,
      responseMimeType: "application/json",
      responseJsonSchema: z.toJSONSchema(opts.schema),
      ...(opts.quick ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
    },
  });
  if (!res.text) throw new Error(`Model returned no output (${res.candidates?.[0]?.finishReason ?? "unknown"})`);
  return opts.schema.parse(JSON.parse(res.text));
}

export type ToolDef = { name: string; description?: string; input_schema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: any };
export type ToolReply = { content: string; isError: boolean };

/**
 * Runs a tool-using conversation to the end and returns the model's final text.
 * `onNote` gets text the model writes between tool calls; `onCall` executes a call.
 */
export async function toolLoop(opts: {
  model: string;
  system: string;
  user: string;
  tools: ToolDef[];
  maxTurns: number;
  onNote: (text: string) => void;
  onCall: (call: ToolCall) => Promise<ToolReply>;
}): Promise<string> {
  requireModel();
  // What already ran stays in the fallback's history, so a provider failing mid-run can't repeat a money call.
  const done: { call: ToolCall; reply: ToolReply }[] = [];
  let toolFailed = false;
  const tracked = {
    ...opts,
    onCall: async (call: ToolCall) => {
      try {
        const reply = await opts.onCall(call);
        done.push({ call, reply });
        return reply;
      } catch (e) {
        toolFailed = true;
        throw e;
      }
    },
  };
  try {
    const out = await (config.ai.provider === "anthropic" ? anthropicLoop(tracked) : geminiLoop(tracked));
    usingFallback = false;
    return out;
  } catch (e) {
    if (toolFailed || !fallbackEnabled()) throw e;
    noteFallback(e);
    return deepseekLoop(opts, done);
  }
}

/** Standing in for the primary provider when it fails, if the owner opted in with FLOORWALKER_AI_FALLBACK=deepseek. */
const fallbackEnabled = () => env("AI_FALLBACK") === "deepseek" && !!process.env.DEEPSEEK_API_KEY?.trim();
let usingFallback = false;
export const aiRuntime = () => ({ fallback: fallbackEnabled() ? "deepseek" : null, usingFallback });

function noteFallback(e: any) {
  // Status only: provider errors can quote the request.
  if (!usingFallback) console.warn(`AI: primary provider failed (${e?.status ?? e?.name ?? "error"}), using DeepSeek`);
  usingFallback = true;
}

type DeepSeekMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };

async function deepseek(body: Record<string, unknown>): Promise<DeepSeekMessage> {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY?.trim()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({ model: env("FALLBACK_MODEL") || "deepseek-flash", thinking: { type: "disabled" }, max_tokens: 8000, ...body }),
  });
  if (!res.ok) throw new Error(`The AI provider and its fallback are unavailable (DeepSeek ${res.status}).`);
  const message = (await res.json() as { choices?: { message?: DeepSeekMessage }[] }).choices?.[0]?.message;
  if (!message) throw new Error("DeepSeek returned no output");
  return message;
}

async function deepseekStructured<S extends z.ZodType>(opts: StructuredOpts<S>): Promise<z.infer<S>> {
  const messages = [
    { role: "system", content: `${opts.system}\n\nReply with one JSON object and nothing else. It must match this JSON Schema:\n${JSON.stringify(z.toJSONSchema(opts.schema))}` },
    { role: "user", content: opts.prompt },
  ];
  // JSON mode can come back empty or off-schema now and then; a second try is what DeepSeek's docs advise.
  for (let attempt = 1; ; attempt++) {
    const message = await deepseek({ messages, response_format: { type: "json_object" }, temperature: 0 });
    try {
      return opts.schema.parse(JSON.parse(message.content ?? ""));
    } catch (e) {
      if (attempt === 2) throw new Error("DeepSeek returned no valid output");
    }
  }
}

async function deepseekLoop(opts: Parameters<typeof toolLoop>[0], done: { call: ToolCall; reply: ToolReply }[]): Promise<string> {
  const messages: DeepSeekMessage[] = [{ role: "system", content: opts.system }, { role: "user", content: opts.user }];
  for (const { call, reply } of done) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] });
    messages.push({ role: "tool", tool_call_id: call.id, content: reply.isError ? `Error: ${reply.content}` : reply.content });
  }
  const tools = opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) } }));
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    const message = await deepseek({ messages, tools });
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    const text = message.content?.trim();
    if (!message.tool_calls?.length) return text ?? "";
    if (text) opts.onNote(text);
    for (const call of message.tool_calls) {
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Error: the arguments were not valid JSON." });
        continue;
      }
      const reply = await opts.onCall({ id: call.id, name: call.function.name, input });
      messages.push({ role: "tool", tool_call_id: call.id, content: reply.isError ? `Error: ${reply.content}` : reply.content });
    }
  }
  return "";
}

async function anthropicLoop(opts: Parameters<typeof toolLoop>[0]): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.user }];
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    const res = await anthropic().messages.create({
      model: opts.model,
      max_tokens: 16000,
      system: opts.system,
      tools: opts.tools as Anthropic.Tool[],
      output_config: { effort: "medium" },
      messages,
    });
    if (res.stop_reason === "refusal") throw new Error("The model declined this item.");
    const texts = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: res.content });
    if (!calls.length) return texts.join("\n\n");
    texts.forEach(opts.onNote);
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const r = await opts.onCall({ id: call.id, name: call.name, input: call.input });
      results.push({ type: "tool_result", tool_use_id: call.id, content: r.content, is_error: r.isError });
    }
    messages.push({ role: "user", content: results });
  }
  return "";
}

/** Gemini rejects a few JSON Schema keywords the PayPal toolkit's schemas carry. */
function geminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const { $schema, additionalProperties, default: _d, ...rest } = s;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, geminiSchema(v)]));
}

async function geminiLoop(opts: Parameters<typeof toolLoop>[0]): Promise<string> {
  const contents: Content[] = [{ role: "user", parts: [{ text: opts.user }] }];
  const functionDeclarations = opts.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: geminiSchema(t.input_schema) }));
  for (let turn = 0; turn < opts.maxTurns; turn++) {
    const res = await gemini().models.generateContent({
      model: opts.model,
      contents,
      // The guard and its reviewer make the decisions; the agent only needs to act quickly.
      config: { systemInstruction: opts.system, tools: [{ functionDeclarations }], thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
    });
    const content = res.candidates?.[0]?.content;
    if (!content) throw new Error(`Model returned no output (${res.candidates?.[0]?.finishReason ?? "unknown"})`);
    // Keep the whole turn, including thought signatures, as Gemini expects them back.
    contents.push(content);
    const parts = content.parts ?? [];
    const texts = parts.filter((p) => p.text && !p.thought).map((p) => p.text!.trim()).filter(Boolean);
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    if (!calls.length) return texts.join("\n\n");
    texts.forEach(opts.onNote);
    const replies: Part[] = [];
    for (const [i, call] of calls.entries()) {
      const id = call.id ?? `${call.name}-${turn}-${i}`;
      const r = await opts.onCall({ id, name: call.name!, input: call.args ?? {} });
      replies.push({ functionResponse: { id: call.id, name: call.name, response: r.isError ? { error: r.content } : { output: r.content } } });
    }
    contents.push({ role: "user", parts: replies });
  }
  return "";
}
