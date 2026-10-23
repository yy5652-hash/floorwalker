import { config } from "../config.ts";
import { structured } from "../llm.ts";
import { PolicySchema, validatePolicy, type Policy } from "./policy.ts";

const SYSTEM = `You turn a small-business owner's plain-language spending rules for their AI agent into a structured policy.

- Use the numbers the owner states. Where the owner says nothing about a field, keep the value from the current policy.
- Payees: keep each listed person with their email from the current policy when the owner names them without an email. Never invent email addresses; if the owner names a new person without an email, leave them out and say so in notes.
- "Ask me" means above auto_approve_up_to. "Never" means hard_limit.
- Put soft guidance (tone, judgement calls, things to watch for) into notes, one short rule each.`;

export async function compilePolicy(text: string, current: Policy): Promise<Policy> {
  const raw = await structured({
    model: config.ai.reviewModel,
    system: SYSTEM,
    prompt: `<current_policy>\n${JSON.stringify(current, null, 2)}\n</current_policy>\n\n<owner_rules>\n${text}\n</owner_rules>`,
    schema: PolicySchema,
    effort: "medium",
  });
  return validatePolicy(raw);
}
