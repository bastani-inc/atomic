import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { runSingleStep } from "../../packages/subagents/src/runs/background/subagent-runner-step.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import { filterSpawnableModelCandidates } from "../../packages/subagents/src/runs/shared/model-candidate-filter.js";
import { resolveAttemptTimeoutConfig } from "../../packages/subagents/src/runs/shared/attempt-watchdog.js";

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

const toolStartEvent = JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep" } });
const toolEndEvent = JSON.stringify({ type: "tool_execution_end", toolName: "bash" });

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
        if (ticks === 8) {
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

  test("does not trip the idle watchdog while a slow tool call is active", async () => {
    await withFakeCli(`
      console.log(${JSON.stringify(toolStartEvent)});
      setTimeout(() => {
        console.log(${JSON.stringify(toolEndEvent)});
        console.log(${JSON.stringify(successEvent("tool ok"))});
      }, 700);
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-tool-active",
        modelOverride: "provider-a/stalled",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.finalOutput ?? "", /tool ok/);
      assert.equal(result.modelAttempts?.length, 1);
      assert.equal(result.modelAttempts?.[0]?.success, true);
    });
  });

  test("trips the idle watchdog when the child stalls after a tool call ends", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") {
        console.log(${JSON.stringify(toolStartEvent)});
        console.log(${JSON.stringify(toolEndEvent)});
        setInterval(() => {}, 1000);
      } else {
        console.log(${JSON.stringify(successEvent("fallback ok"))});
      }
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-post-tool-stall",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /without child activity/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("enforces the wall-clock cap even with steady child activity", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") setInterval(() => process.stderr.write("tick\\n"), 50);
      else console.log(${JSON.stringify(successEvent("fallback ok"))});
    `, async (dir) => {
      process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "600";
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-wall-cap",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out after 600ms\./i);
      assert.doesNotMatch(result.modelAttempts?.[0]?.error ?? "", /without child activity/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") {
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      } else {
        console.log(${JSON.stringify(successEvent("fallback ok"))});
      }
    `, async (dir) => {
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-sigkill-escalation",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("background runner keeps a silent tool call alive past the idle window", async () => {
    await withFakeCli(`
      console.log(${JSON.stringify(toolStartEvent)});
      setTimeout(() => {
        console.log(${JSON.stringify(toolEndEvent)});
        console.log(${JSON.stringify(successEvent("background tool ok"))});
      }, 700);
    `, async (dir) => {
      const result = await runSingleStep({
        agent: "fake-worker",
        task: "Do work",
        inheritProjectContext: false,
        inheritSkills: false,
      }, {
        previousOutput: "",
        placeholder: "{previous}",
        cwd: dir,
        sessionEnabled: false,
        id: "background-tool-active",
        flatIndex: 0,
        flatStepCount: 1,
        outputFile: join(dir, "output.txt"),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.error, undefined);
      assert.match(result.output, /background tool ok/);
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

  test("ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS=0 disables the idle watchdog", async () => {
    await withFakeCli(`
      const modelIndex = process.argv.indexOf("--model");
      const model = modelIndex === -1 ? "default" : process.argv[modelIndex + 1];
      if (model === "provider-a/stalled") setInterval(() => {}, 1000);
      else console.log(${JSON.stringify(successEvent("fallback ok"))});
    `, async (dir) => {
      process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = "0";
      process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "600";
      const result = await runSync(dir, [agentConfig()], "fake-worker", "Do work", {
        cwd: dir,
        runId: "watchdog-idle-disabled",
        availableModels: [
          { provider: "provider-a", id: "stalled", fullId: "provider-a/stalled" },
          { provider: "provider-b", id: "working", fullId: "provider-b/working" },
        ],
        knownModelProviders: ["provider-a", "provider-b"],
      });

      assert.equal(result.exitCode, 0);
      assert.match(result.finalOutput ?? "", /fallback ok/);
      assert.equal(result.modelAttempts?.length, 2);
      assert.equal(result.modelAttempts?.[0]?.success, false);
      // A fully silent child must outlive the (disabled) idle window and only be
      // bounded by the wall-clock cap.
      assert.match(result.modelAttempts?.[0]?.error ?? "", /timed out after 600ms\./i);
      assert.doesNotMatch(result.modelAttempts?.[0]?.error ?? "", /without child activity/i);
      assert.equal(result.modelAttempts?.[1]?.success, true);
    });
  });

  test("non-numeric watchdog overrides are ignored and defaults apply", async () => {
    const previousIdle = process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
    const previousWall = process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
    process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = "soon";
    process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "-100";
    try {
      const config = resolveAttemptTimeoutConfig();
      assert.equal(config.idleMs, 5 * 60_000);
      assert.equal(config.wallMs, 0);
    } finally {
      if (previousIdle === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
      else process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = previousIdle;
      if (previousWall === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
      else process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = previousWall;
    }
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
