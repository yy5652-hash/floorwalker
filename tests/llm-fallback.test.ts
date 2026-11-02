// DeepSeek stands in when the primary provider fails, only if opted in, and never repeats a tool call.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";

process.env.GEMINI_API_KEY = "test-gemini";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.DEEPSEEK_API_KEY = "test-deepseek";
process.env.FLOORWALKER_CORE_DB = ":memory:";

const { structured, toolLoop, aiRuntime } = await import("../server/llm.ts");

const realFetch = globalThis.fetch;
let geminiReplies: (() => Response)[] = [];
let deepseekReplies: (() => Response)[] = [];
let deepseekBodies: any[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const depleted = () => json({ error: { code: 402, message: "secret prompt quoted here" } }, 402);
const deepseekSays = (message: object) => () => json({ choices: [{ message: { role: "assistant", ...message } }] });

beforeEach(() => {
  process.env.FLOORWALKER_AI_FALLBACK = "deepseek";
  geminiReplies = []; deepseekReplies = []; deepseekBodies = [];
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("api.deepseek.com")) {
      deepseekBodies.push(JSON.parse(init.body));
      const next = deepseekReplies.shift();
      assert.ok(next, "unexpected DeepSeek call");
      return next();
    }
    return (geminiReplies.shift() ?? depleted)();
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const Schema = z.object({ verdict: z.enum(["approve", "escalate"]) });
const ask = () => structured({ model: "gemini-test", system: "s", prompt: "p", schema: Schema });
const tools = [{ name: "lookup", description: "d", input_schema: { type: "object", properties: {} } }];
const loop = (onCall: (c: any) => Promise<any>, notes: string[] = []) => toolLoop({ model: "gemini-test", system: "s", user: "u", tools, maxTurns: 5, onNote: (n) => notes.push(n), onCall });
const lookup = { id: "c1", type: "function", function: { name: "lookup", arguments: "{\"x\":1}" } };

test("a structured call falls back and its answer is validated against the schema", async () => {
  deepseekReplies = [deepseekSays({ content: "{\"verdict\":\"escalate\"}" })];
  assert.deepEqual(await ask(), { verdict: "escalate" });
  assert.equal(deepseekBodies[0].response_format.type, "json_object");
  assert.match(deepseekBodies[0].messages[0].content, /JSON Schema/);
  assert.equal(aiRuntime().usingFallback, true);
});

test("an off-schema answer gets one retry, then fails instead of being trusted", async () => {
  deepseekReplies = [deepseekSays({ content: "{\"verdict\":\"allow it\"}" }), deepseekSays({ content: "{\"verdict\":\"approve\"}" })];
  assert.deepEqual(await ask(), { verdict: "approve" });
  deepseekReplies = [deepseekSays({ content: "" }), deepseekSays({ content: "nope" })];
  await assert.rejects(ask(), /no valid output/);
});

test("without the opt-in, or without a key, nothing goes to DeepSeek", async () => {
  delete process.env.FLOORWALKER_AI_FALLBACK;
  await assert.rejects(ask());
  assert.equal(deepseekBodies.length, 0);
  assert.equal(aiRuntime().fallback, null);
});

test("when both providers fail the error doesn't carry the provider's response body", async () => {
  deepseekReplies = [() => json({ error: "secret prompt quoted here" }, 500)];
  await assert.rejects(ask(), (e: Error) => /unavailable/.test(e.message) && !/secret/.test(e.message));
});

test("the agent runs on the fallback from the start when the primary fails on its first turn", async () => {
  deepseekReplies = [deepseekSays({ content: "Checking.", tool_calls: [lookup] }), deepseekSays({ content: "All done." })];
  const calls: any[] = [], notes: string[] = [];
  assert.equal(await loop(async (c) => { calls.push(c); return { content: "found", isError: false }; }, notes), "All done.");
  assert.deepEqual(calls.map((c) => [c.name, c.input]), [["lookup", { x: 1 }]]);
  assert.deepEqual(notes, ["Checking."]);
  assert.deepEqual(deepseekBodies[1].messages.at(-1), { role: "tool", tool_call_id: "c1", content: "found" });
});

test("a provider failing mid-run hands over what already ran, so a money call isn't repeated", async () => {
  geminiReplies = [() => json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "g1", name: "lookup", args: { x: 2 } } }] } }] })];
  deepseekReplies = [deepseekSays({ content: "Finished." })];
  let ran = 0;
  assert.equal(await loop(async () => { ran++; return { content: "refunded", isError: false }; }), "Finished.");
  assert.equal(ran, 1);
  const history = deepseekBodies[0].messages;
  assert.equal(history.at(-2).tool_calls[0].function.name, "lookup");
  assert.deepEqual(JSON.parse(history.at(-2).tool_calls[0].function.arguments), { x: 2 });
  assert.equal(history.at(-1).content, "refunded");
});

test("a tool that throws is the tool's failure: it doesn't send the run to the fallback", async () => {
  geminiReplies = [() => json({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "g1", name: "lookup", args: {} } }] } }] })];
  await assert.rejects(loop(async () => { throw new Error("tool broke"); }), /tool broke/);
  assert.equal(deepseekBodies.length, 0);
});
