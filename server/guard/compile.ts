import { config } from "../config.ts";
import { structured } from "../llm.ts";
import { z } from "zod/v4";
import { PolicySchema, validatePolicy, type Policy } from "./policy.ts";

const CompileSchema = z.object({
  policy: PolicySchema,
  suggestions: z.array(z.object({
    kind: z.enum(["conflict", "gap", "unclear"]),
    text: z.string().describe("One short sentence to the owner: what is contradictory, missing or ambiguous, and how to fix it"),
  })).describe("Up to three issues with the owner's wording; empty when the rules are clear"),
});

export type Suggestion = z.infer<typeof CompileSchema>["suggestions"][number];

const SYSTEM = `You turn a small-business owner's plain-language spending rules for their AI agent into a structured policy.

- Use the numbers the owner states. Where the owner says nothing about a field, keep the value from the current policy.
- Payees: keep each listed person with their email from the current policy when the owner names them without an email. Never invent email addresses; if the owner names a new person without an email, leave them out and say so in notes.
- "Ask me" means above auto_approve_up_to. "Never" means hard_limit.
- Put soft guidance (tone, judgement calls, things to watch for) into notes, one short rule each.
- Then point out, as suggestions, anything contradictory (e.g. an auto-approve limit above a "never" limit), missing (e.g. no limit stated for a kind of payment the agent can make) or unclear. Keep it to the few that matter.`;

export async function compilePolicy(text: string, current: Policy): Promise<{ policy: Policy; suggestions: Suggestion[] }> {
  const out = await structured({
    model: config.ai.reviewModel,
    system: SYSTEM,
    prompt: `<current_policy>\n${JSON.stringify(current, null, 2)}\n</current_policy>\n\n<owner_rules>\n${text}\n</owner_rules>`,
    schema: CompileSchema,
    effort: "medium",
  });
  return { policy: validatePolicy(out.policy), suggestions: out.suggestions.slice(0, 3) };
}
