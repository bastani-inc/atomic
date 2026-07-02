import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSingleStep } from "../../packages/subagents/src/runs/background/subagent-runner-step.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import { filterSpawnableModelCandidates } from "../../packages/subagents/src/runs/shared/model-candidate-filter.js";
import { agentConfig, successEvent, withFakeCli } from "./subagents-attempt-watchdog-helpers.js";

describe("subagent pre-spawn model candidate filtering", () => {
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

  test("does not spawn a default foreground child when every configured candidate is filtered", async () => {
    await withFakeCli(`
      const fs = require("node:fs");
      const path = require("node:path");
      fs.writeFileSync(path.join(process.cwd(), "spawned"), "yes");
      console.log(${JSON.stringify(successEvent("should not run"))});
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-all-filtered",
        availableModels: [],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /No spawnable subagent model candidates/);
      assert.equal(existsSync(join(dir, "spawned")), false);
      assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.model), ["provider-a/stalled", "provider-b/working"]);
    });
  });

  test("background runner spawns one default attempt when no candidates were ever configured", async () => {
    await withFakeCli(`
      const fs = require("node:fs");
      const path = require("node:path");
      const modelIndex = process.argv.indexOf("--model");
      fs.writeFileSync(path.join(process.cwd(), "spawned-model"), modelIndex === -1 ? "default" : process.argv[modelIndex + 1]);
      console.log(${JSON.stringify(successEvent("default ok"))});
    `, async (dir) => {
      // No primary model, no fallbacks, no current model: buildModelCandidates()
      // yields [] and pre-spawn filtering records no skipped attempts. The runner
      // must mirror the foreground path and run one default-model attempt instead
      // of silently exiting 1 with no error and no spawn.
      const result = await runSingleStep({
        agent: "fake-worker",
        task: "Do work",
        inheritProjectContext: false,
        inheritSkills: false,
        modelCandidates: [],
        modelAttempts: [],
      }, {
        previousOutput: "",
        placeholder: "{previous}",
        cwd: dir,
        sessionEnabled: false,
        id: "background-default-attempt",
        flatIndex: 0,
        flatStepCount: 1,
        outputFile: join(dir, "output.txt"),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.output, /default ok/);
      assert.equal(readFileSync(join(dir, "spawned-model"), "utf8"), "default");
      assert.equal(result.modelAttempts?.length, 1);
      assert.equal(result.modelAttempts?.[0]?.success, true);
    });
  });

  test("background runner reports a useful error when every candidate was filtered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-background-filtered-"));
    try {
      const result = await runSingleStep({
        agent: "fake-worker",
        task: "Do work",
        inheritProjectContext: false,
        inheritSkills: false,
        modelCandidates: [],
        modelAttempts: [{
          model: "provider-a/stalled",
          success: false,
          exitCode: null,
          error: "Skipped provider-a/stalled: provider 'provider-a' has no configured API key/auth in the current session.",
        }],
      }, {
        previousOutput: "",
        placeholder: "{previous}",
        cwd: dir,
        sessionEnabled: false,
        id: "background-all-filtered",
        flatIndex: 0,
        flatStepCount: 1,
        outputFile: join(dir, "output.txt"),
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.error ?? "", /No spawnable subagent model candidates/);
      assert.match(result.output, /Skipped provider-a\/stalled/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("foreground parallel tasks pass known providers into runSync", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-parallel-known-"));
    try {
      const knownModelProviders = ["provider-a", "provider-b"];
      const captured: Array<{ knownModelProviders?: string[] }> = [];
      const input: Parameters<typeof runForegroundParallelTasks>[0] = {
        tasks: [{ agent: "fake-worker", task: "Do work" }],
        taskTexts: ["Do work"],
        agents: [agentConfig()],
        ctx: {
          cwd: dir,
          model: { provider: "provider-b", id: "working" },
        } as Parameters<typeof runForegroundParallelTasks>[0]["ctx"],
        intercomEvents: {} as Parameters<typeof runForegroundParallelTasks>[0]["intercomEvents"],
        signal: new AbortController().signal,
        runId: "parallel-known-providers",
        sessionDirForIndex: () => undefined,
        sessionFileForIndex: () => undefined,
        shareEnabled: false,
        artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 0 },
        artifactsDir: dir,
        paramsCwd: dir,
        maxSubagentDepths: [0],
        availableModels: [{ provider: "provider-b", id: "working", fullId: "provider-b/working" }],
        knownModelProviders,
        modelOverrides: ["provider-a/stalled"],
        behaviors: [{ output: false, outputMode: "inline", reads: false, progress: false, skills: false }],
        firstProgressIndex: -1,
        controlConfig: { enabled: false, needsAttentionAfterMs: 1, activeNoticeAfterMs: 1, failedToolAttemptsBeforeAttention: 1, notifyOn: [], notifyChannels: [] },
        concurrencyLimit: 1,
        liveResults: [],
        liveProgress: [],
        runtime: {
          async runSync(_cwd, _agents, agentName, task, options) {
            captured.push({ knownModelProviders: options.knownModelProviders });
            return {
              agent: agentName,
              task,
              exitCode: 0,
              messages: [],
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
              finalOutput: "ok",
            };
          },
        },
      };

      await runForegroundParallelTasks(input);
      assert.deepEqual(captured, [{ knownModelProviders }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
