import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI, type Content, type Part, ThinkingLevel } from "@google/genai";
import { z } from "zod/v4";
import { config } from "./config.ts";

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
export async function structured<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  effort?: "low" | "medium" | "high";
}): Promise<z.infer<S>> {
  requireModel();
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
  return config.ai.provider === "anthropic" ? anthropicLoop(opts) : geminiLoop(opts);
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
