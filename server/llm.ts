import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import { config } from "./config.ts";

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!config.anthropic.configured) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");
  client ??= new Anthropic();
  return client;
}

/** One structured call: Claude's answer is parsed and validated against the schema. */
export async function structured<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  effort?: "low" | "medium" | "high";
}): Promise<z.infer<S>> {
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
