import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate config imports from the developer's .env and real database files.
function readConfig(overrides: Record<string, string> = {}, files: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "floorwalker-config-"));
  try {
    mkdirSync(join(cwd, "data"));
    for (const file of files) writeFileSync(join(cwd, file), "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLOORWALKER_|ALLOWANCE_)/.test(key)));
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e",
      `const { config, env } = await import(${JSON.stringify(new URL("../server/config.ts", import.meta.url).href)});
       console.log(JSON.stringify({ db: config.dbPath, core: config.coreDbPath, dir: config.dataDir,
         url: config.baseUrl, agent: config.ai.agentModel, review: config.ai.reviewModel,
         pool: env("DEMO_POOL", "0"), runs: env("RUNS_PER_HOUR", "60") }));`,
    ], { cwd, env: { ...env, ...overrides }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("legacy product environment variables work, and new names take precedence", () => {
  const settings = { DB: "db", CORE_DB: "core", DATA_DIR: "dir", BASE_URL: "url", AGENT_MODEL: "agent", REVIEW_MODEL: "review", DEMO_POOL: "pool", RUNS_PER_HOUR: "runs" };
  const legacy = Object.fromEntries(Object.keys(settings).map((key) => [`ALLOWANCE_${key}`, `old-${key}`]));
  const current = Object.fromEntries(Object.keys(settings).map((key) => [`FLOORWALKER_${key}`, `new-${key}`]));
  const oldConfig = readConfig(legacy);
  const newConfig = readConfig({ ...legacy, ...current });
  for (const [key, field] of Object.entries(settings)) {
    assert.equal(oldConfig[field], `old-${key}`);
    assert.equal(newConfig[field], `new-${key}`);
  }
  assert.equal(readConfig({ ALLOWANCE_BASE_URL: "old", FLOORWALKER_BASE_URL: "" }).url, "");
});

test("default database prefers the new file, but keeps using an existing legacy file", () => {
  assert.equal(readConfig().db, "data/floorwalker.db");
  assert.equal(readConfig({}, ["data/allowance.db"]).db, "data/allowance.db");
  assert.equal(readConfig({}, ["data/allowance.db", "data/floorwalker.db"]).db, "data/floorwalker.db");
  assert.equal(readConfig({ FLOORWALKER_DB: ":memory:" }, ["data/allowance.db"]).db, ":memory:");
});
