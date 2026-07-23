import { test } from "bun:test";
import assert from "node:assert/strict";
import { runForegroundParallelTasks } from "../../packages/subagents/src/runs/foreground/subagent-executor-parallel-task.js";
import { runParallelChainTasks } from "../../packages/subagents/src/runs/foreground/chain-execution-parallel-runner.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";
import { agentConfig } from "./subagents-attempt-watchdog-helpers.js";

function result(index: number): SingleResult {
  return {
    agent: "fake-worker",
    task: `task-${index}`,
    exitCode: -2,
    detached: true,
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };
}

test("one parallel child's supervisor detach releases every active foreground sibling", async () => {
  const started: number[] = [];
  const settled: number[] = [];
  const output = await runForegroundParallelTasks({
    tasks: [
      { agent: "fake-worker", task: "ask supervisor" },
      { agent: "fake-worker", task: "remain active" },
      { agent: "fake-worker", task: "remain queued" },
    ],
    taskTexts: ["ask supervisor", "remain active", "remain queued"],
    agents: [agentConfig()],
    ctx: { cwd: process.cwd() } as Parameters<typeof runForegroundParallelTasks>[0]["ctx"],
    intercomEvents: {} as Parameters<typeof runForegroundParallelTasks>[0]["intercomEvents"],
    signal: new AbortController().signal,
    runId: "parallel-detach",
    sessionDirForIndex: () => undefined,
    sessionFileForIndex: () => undefined,
    shareEnabled: false,
    artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 0 },
    artifactsDir: process.cwd(),
    paramsCwd: process.cwd(),
    maxSubagentDepths: [0, 0, 0],
    availableModels: [],
    knownModelProviders: [],
    modelOverrides: [undefined, undefined, undefined],
    behaviors: [
      { output: false, outputMode: "inline", reads: false, progress: false, skills: false },
      { output: false, outputMode: "inline", reads: false, progress: false, skills: false },
      { output: false, outputMode: "inline", reads: false, progress: false, skills: false },
    ],
    firstProgressIndex: -1,
    controlConfig: { enabled: false, needsAttentionAfterMs: 1, activeNoticeAfterMs: 1, failedToolAttemptsBeforeAttention: 1, notifyOn: [], notifyChannels: [] },
    concurrencyLimit: 2,
    liveResults: [],
    liveProgress: [],
    runtime: {
      async runSync(_cwd, _agents, _agentName, _task, options) {
        const index = options.index ?? -1;
        started.push(index);
        if (index === 0) {
          await Promise.resolve();
          options.onIntercomDetachCommit?.();
        } else {
          await new Promise<void>((resolve) => {
            options.intercomDetachSignal?.addEventListener("abort", () => resolve(), { once: true });
            if (options.intercomDetachSignal?.aborted) resolve();
          });
        }
        settled.push(index);
        return result(index);
      },
    },
  });

  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(settled.toSorted(), [0, 1]);
  assert.equal(output.length, 3);
  assert.ok(output.slice(0, 2).every((entry) => entry.detached));
  assert.equal(output[2]?.exitCode, -1);
  assert.match(output[2]?.error ?? "", /Skipped after foreground group detached/);
});

test("chain-parallel detach does not launch work that was still queued", async () => {
  const started: number[] = [];
  const output = await runParallelChainTasks({
    step: {
      parallel: [
        { agent: "fake-worker", task: "ask supervisor" },
        { agent: "fake-worker", task: "active sibling" },
        { agent: "fake-worker", task: "queued sibling" },
      ],
      concurrency: 2,
    },
    parallelTemplates: ["ask supervisor", "active sibling", "queued sibling"],
    parallelBehaviors: [
      { output: false, outputMode: "inline", reads: false, progress: false, skills: false },
      { output: false, outputMode: "inline", reads: false, progress: false, skills: false },
      { output: false, outputMode: "inline", reads: false, progress: false, skills: false },
    ],
    agents: [agentConfig()],
    stepIndex: 0,
    availableModels: [],
    knownModelProviders: [],
    chainDir: process.cwd(),
    prev: "",
    originalTask: "parallel chain",
    ctx: { cwd: process.cwd() } as Parameters<typeof runParallelChainTasks>[0]["ctx"],
    runId: "chain-parallel-detach",
    globalTaskIndex: 10,
    sessionDirForIndex: () => undefined,
    shareEnabled: false,
    artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 0 },
    artifactsDir: process.cwd(),
    controlConfig: { enabled: false, needsAttentionAfterMs: 1, activeNoticeAfterMs: 1, failedToolAttemptsBeforeAttention: 1, notifyOn: [], notifyChannels: [] },
    results: [],
    allProgress: [],
    outputs: {},
    chainAgents: [],
    chainSteps: [],
    totalSteps: 3,
    maxSubagentDepth: 0,
    async runSync(_cwd, _agents, _agentName, task, options) {
      const index = options.index ?? -1;
      started.push(index);
      if (index === 10) {
        await Promise.resolve();
        options.onIntercomDetachCommit?.();
      } else {
        await new Promise<void>((resolve) => {
          options.intercomDetachSignal?.addEventListener("abort", () => resolve(), { once: true });
          if (options.intercomDetachSignal?.aborted) resolve();
        });
      }
      return { ...result(index), task };
    },
  });

  assert.deepEqual(started, [10, 11]);
  assert.equal(output[2]?.exitCode, -1);
  assert.match(output[2]?.error ?? "", /Skipped after foreground group detached/);
});
