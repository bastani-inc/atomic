import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { filterSpawnableModelCandidates } from "../../packages/subagents/src/runs/shared/model-candidate-filter.js";

function agentConfig(): AgentConfig {
  return {
    name: "fake-worker",
    description: "Fake worker",
    source: "project",
    filePath: "fake-worker.md",
    systemPrompt: "Work.",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    model: "provider-a/stalled",
    fallbackModels: ["provider-b/working"],
  };
}

async function withFakeCli<T>(script: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-watchdog-"));
  const scriptPath = join(dir, "fake-pi.js");
  const previousArgv1 = process.argv[1];
  const previousIdle = process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
  const previousWall = process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
  const previousKill = process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  process.argv[1] = scriptPath;
  process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = "250";
  process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "2000";
  process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS = "20";
  try {
    return await fn(dir);
  } finally {
    process.argv[1] = previousArgv1;
    if (previousIdle === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
    else process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = previousIdle;
    if (previousWall === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
    else process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = previousWall;
    if (previousKill === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS;
    else process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS = previousKill;
    rmSync(dir, { recursive: true, force: true });
  }
}

const successEvent = (text: string) => JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1 },
    timestamp: Date.now(),
  },
});

describe("subagent per-attempt watchdog", () => {
  test("kills a stalled model attempt and advances to the next fallback", async () => {
    await withFakeCli(`
      const fs = require("node:fs");
      const path = require("node:path");
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      fs.appendFileSync(path.join(process.cwd(), "models.log"), model + "\\n");
      if (model === "provider-a/stalled") setInterval(() => {}, 1000);
      else console.log(${JSON.stringify(successEvent("fallback ok"))});
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-fallback",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.deepEqual(readFileSync(join(dir, "models.log"), "utf8").trim().split("\n"), ["provider-a/stalled", "provider-b/working"]);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("resets the idle timer on child activity", async () => {
    await withFakeCli(`
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        process.stderr.write("tick " + ticks + "\\n");
        if (ticks === 3) {
          clearInterval(timer);
          console.log(${JSON.stringify(successEvent("activity ok"))});
        }
      }, 50);
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-activity",
        modelOverride: "provider-a/stalled",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /activity ok/);
      assert.equal(result.modelAttempts?.length, 1);
      assert.equal(result.modelAttempts?.[0]?.success, true);
    });
  });

  test("pre-spawn filtering skips known keyless providers but keeps unknowns and current model", () => {
    const filtered = filterSpawnableModelCandidates({
      candidates: ["provider-a/missing", "custom/model", "provider-b/ready", "provider-a/current"],
      availableModels: [{ provider: "provider-b", id: "ready", fullId: "provider-b/ready" }],
      knownModelProviders: ["provider-a", "provider-b"],
      currentModel: "provider-a/current",
    });

    assert.deepEqual(filtered.candidates, ["custom/model", "provider-b/ready", "provider-a/current"]);
    assert.deepEqual(filtered.skippedAttempts.map((attempt) => attempt.model), ["provider-a/missing"]);
    assert.match(filtered.skippedAttempts[0]?.error ?? "", /no configured API key\/auth/);

    const noAvailable = filterSpawnableModelCandidates({
      candidates: ["provider-a/missing", "custom/model"],
      availableModels: [],
      knownModelProviders: ["provider-a"],
    });
    assert.deepEqual(noAvailable.candidates, ["custom/model"]);
    assert.deepEqual(noAvailable.skippedAttempts.map((attempt) => attempt.model), ["provider-a/missing"]);
  });
});
