import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createStructuredOutputRuntime } from "../../packages/subagents/src/runs/shared/structured-output.js";

function agentConfig(): AgentConfig {
  return {
    name: "fake-reviewer",
    description: "Fake reviewer",
    source: "project",
    filePath: "fake-reviewer.md",
    systemPrompt: "Return structured output.",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    completionGuard: false,
  };
}

function withFakeCli<T>(script: string, fn: (dir: string, scriptPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-structured-retry-"));
  const scriptPath = join(dir, "fake-pi.js");
  const previousArgv1 = process.argv[1];
  writeFileSync(scriptPath, script, { mode: 0o700 });
  process.argv[1] = scriptPath;
  return fn(dir, scriptPath).finally(() => {
    process.argv[1] = previousArgv1;
    rmSync(dir, { recursive: true, force: true });
  });
}

const schema = {
  type: "object",
  required: ["answer"],
  properties: {
    answer: { type: "string" },
  },
  additionalProperties: false,
};

describe("foreground subagent structured_output retry", () => {
  test("re-runs with a corrective prompt after missing structured_output and can succeed", async () => {
    await withFakeCli(`
      const fs = require("node:fs");
      const path = require("node:path");
      const countPath = path.join(process.cwd(), "attempt-count.txt");
      const promptsPath = path.join(process.cwd(), "prompts.log");
      const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
      fs.writeFileSync(countPath, String(count));
      const prompt = process.argv[process.argv.length - 1] || "";
      fs.appendFileSync(promptsPath, prompt + "\\n---PROMPT---\\n");
      if (count >= 2) {
        const captureKey = Object.keys(process.env).find((key) => key.endsWith("_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE"));
        fs.writeFileSync(process.env[captureKey], JSON.stringify({ answer: "ok" }));
      }
      const text = count === 1 ? '{"answer":"plain-json"}' : "done";
      console.log(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
          timestamp: Date.now()
        }
      }));
    `, async (dir) => {
      const runtime = createStructuredOutputRuntime(schema, dir);
      const updateStatuses: string[] = [];
      const updateErrors: string[] = [];
      const result = await runSync(dir, [agentConfig()], "fake-reviewer", "Return the answer", {
        cwd: dir,
        runId: "structured-retry-success",
        structuredOutput: runtime,
        onUpdate(update) {
          const progress = update.details?.progress?.[0];
          if (progress?.status) updateStatuses.push(progress.status);
          if (progress?.error) updateErrors.push(progress.error);
        },
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.structuredOutput, { answer: "ok" });
      assert.equal(readFileSync(join(dir, "attempt-count.txt"), "utf8"), "2");
      const prompts = readFileSync(join(dir, "prompts.log"), "utf8");
      assert.match(prompts, /Task: Return the answer/);
      assert.match(prompts, /Corrective attempt 1\/3/);
      assert.match(prompts, /Missing structured_output call/);
      assert.equal(updateStatuses.includes("failed"), false);
      assert.deepEqual(updateErrors, []);
    });
  });

  test("fails after three corrective prompts when structured_output remains missing", async () => {
    await withFakeCli(`
      const fs = require("node:fs");
      const path = require("node:path");
      const countPath = path.join(process.cwd(), "attempt-count.txt");
      const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
      fs.writeFileSync(countPath, String(count));
      console.log(JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: '{"answer":"plain-json"}' }],
          stopReason: "stop",
          usage: { input: 1, output: 1 },
          timestamp: Date.now()
        }
      }));
    `, async (dir) => {
      const runtime = createStructuredOutputRuntime(schema, dir);
      const failedUpdates: string[] = [];
      const result = await runSync(dir, [agentConfig()], "fake-reviewer", "Return the answer", {
        cwd: dir,
        runId: "structured-retry-failure",
        structuredOutput: runtime,
        onUpdate(update) {
          const progress = update.details?.progress?.[0];
          if (progress?.status === "failed" && progress.error) failedUpdates.push(progress.error);
        },
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /Missing structured_output call/);
      assert.equal(readFileSync(join(dir, "attempt-count.txt"), "utf8"), "4");
      assert.equal(result.structuredOutput, undefined);
      assert.equal(failedUpdates.length, 1);
      assert.match(failedUpdates[0] ?? "", /Missing structured_output call/);
    });
  });
});
