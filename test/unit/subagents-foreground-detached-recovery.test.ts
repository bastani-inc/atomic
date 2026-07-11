import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ChainStep } from "../../packages/subagents/src/shared/settings.js";
import type { SingleResult, SubagentState } from "../../packages/subagents/src/shared/types.js";
import { rememberForegroundRun, replaceForegroundRunChild } from "../../packages/subagents/src/runs/foreground/subagent-executor-status.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
const result = (agent: string, task: string, exitCode: number, finalOutput: string, detached = false): SingleResult => ({
  agent, task, exitCode, finalOutput, detached: detached || undefined, messages: [], usage,
});

type Executor = ReturnType<typeof createSubagentExecutor>;
type Deps = Parameters<typeof createSubagentExecutor>[0];
type Context = Parameters<Executor["execute"]>[4];
type RunOptions = {
  index?: number;
  onDetachedExit?: (recovered: SingleResult) => void;
};
type RunBehavior = (agent: string, task: string, options: RunOptions) => SingleResult;

function agent(name: string) {
  return {
    name,
    description: `${name} fixture`,
    systemPromptMode: "replace" as const,
    inheritProjectContext: false,
    inheritSkills: false,
    systemPrompt: "You are a fixture agent.",
    source: "project" as const,
    filePath: `/tmp/${name}.md`,
  };
}

function fixture(behavior: RunBehavior, names = ["alpha", "beta", "gamma"]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-detached-chain-"));
  const state: SubagentState = {
    baseCwd: "", currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(),
    foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(),
    lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null,
    watcherRestartTimer: null,
    resultFileCoalescer: { schedule: () => false, clear() {} },
  };
  const pi = {
    events: { on: () => () => {}, emit() {} },
    getSessionName: () => "parent",
  } as unknown as Deps["pi"];
  const deps = {
    pi,
    state,
    config: { maxSubagentDepth: 2, parallel: { concurrency: 4, maxTasks: 50 }, chain: { dynamicFanout: { maxItems: 4 } } },
    asyncByDefault: false,
    tempArtifactsDir: path.join(cwd, "artifacts"),
    getSubagentSessionRoot: () => path.join(cwd, "sessions"),
    expandTilde: (value: string) => value,
    discoverAgents: () => ({ agents: names.map(agent) }),
    runtime: {
      runSync: async (_cwd: string, _agents: ReturnType<typeof agent>[], name: string, task: string, options: RunOptions) => behavior(name, task, options),
      executeAsyncChain: () => { throw new Error("unexpected background chain"); },
      executeAsyncSingle: () => { throw new Error("unexpected background single"); },
      isAsyncAvailable: () => true,
    },
  } as Deps;
  const context = {
    cwd, mode: "tui", hasUI: false, ui: { custom: async <T>() => undefined as T },
    model: undefined, modelRegistry: { getAvailable: () => [] },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "parent", getLeafId: () => null },
    isIdle: () => true, isProjectTrusted: () => true, signal: undefined, abort() {},
    hasPendingMessages: () => false, shutdown() {}, getContextUsage: () => undefined,
    compact() {}, getSystemPrompt: () => "",
  } as unknown as Context;
  return { executor: createSubagentExecutor(deps), state, context };
}

function remembered(f: ReturnType<typeof fixture>) {
  assert.ok(f.state.foregroundRuns);
  const run = [...f.state.foregroundRuns.values()][0];
  assert.ok(run, "executor remembers the foreground chain");
  return run;
}

async function execute(f: ReturnType<typeof fixture>, chain: ChainStep[]) {
  return f.executor.execute("subagent", { chain }, new AbortController().signal, undefined, f.context);
}

describe("executor-level foreground chain detached recovery", () => {
  test("sequential chain retains an exit before registration at its stable flat child index", async () => {
    const f = fixture((name, task, options) => {
      if (options.index === 1) {
        options.onDetachedExit?.(result(name, task, 0, "beta actual payload"));
        return result(name, task, -2, "waiting", true);
      }
      return result(name, task, 0, "alpha output");
    });

    const response = await execute(f, [
      { agent: "alpha", task: "first" },
      { agent: "beta", task: "second" },
    ]);

    assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /detached/i);
    const children = remembered(f).children;
    assert.deepEqual(children.map((child) => child.index), [0, 1]);
    assert.equal(children[0]?.result?.finalOutput, "alpha output");
    assert.equal(children[1]?.status, "completed");
    assert.equal(children[1]?.result?.exitCode, 0);
    assert.equal(children[1]?.result?.detached, undefined);
    assert.equal(children[1]?.result?.finalOutput, "beta actual payload");
  });

  test("static-parallel chain replaces only the detached flat child after registration", async () => {
    let recover: (() => void) | undefined;
    const f = fixture((name, task, options) => {
      if (options.index === 2) {
        recover = () => options.onDetachedExit?.(result(name, task, 0, "gamma actual payload"));
        return result(name, task, -2, "waiting", true);
      }
      return result(name, task, 0, `${name} output`);
    });

    await execute(f, [
      { agent: "alpha", task: "first" },
      { parallel: [{ agent: "beta", task: "second" }, { agent: "gamma", task: "third" }] },
    ]);
    const before = remembered(f);
    assert.deepEqual(before.children.map((child) => child.index), [0, 1, 2]);
    assert.deepEqual(before.children.map((child) => child.status), ["completed", "completed", "detached"]);
    recover?.();
    const after = remembered(f);
    assert.deepEqual(after.children.map((child) => child.index), [0, 1, 2]);
    assert.equal(after.children[1]?.result?.finalOutput, "beta output");
    assert.equal(after.children[2]?.status, "completed");
    assert.equal(after.children[2]?.result?.exitCode, 0);
    assert.equal(after.children[2]?.result?.detached, undefined);
    assert.equal(after.children[2]?.result?.finalOutput, "gamma actual payload");
  });

  test("dynamic-parallel chain preserves materialized flat indices and replaces the recovered item", async () => {
    let recover: (() => void) | undefined;
    const f = fixture((name, task, options) => {
      if (options.index === 0) return { ...result(name, task, 0, "targets"), structuredOutput: { items: [{ path: "a.ts" }, { path: "b.ts" }] } };
      if (options.index === 2) {
        recover = () => options.onDetachedExit?.(result(name, task, 0, "b.ts actual payload"));
        return result(name, task, -2, "waiting", true);
      }
      return result(name, task, 0, "a.ts output");
    }, ["alpha", "beta"]);

    await execute(f, [
      { agent: "alpha", task: "targets", as: "targets", outputSchema: { type: "object" } },
      {
        expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
        parallel: { agent: "beta", task: "Review {target.path}" },
        collect: { as: "reviews" },
      },
    ]);
    const before = remembered(f);
    assert.deepEqual(before.children.map((child) => child.index), [0, 1, 2]);
    assert.deepEqual(before.children.map((child) => child.status), ["completed", "completed", "detached"]);
    recover?.();
    const after = remembered(f);
    assert.deepEqual(after.children.map((child) => child.index), [0, 1, 2]);
    assert.equal(after.children[1]?.result?.finalOutput, "a.ts output");
    assert.equal(after.children[2]?.status, "completed");
    assert.equal(after.children[2]?.result?.exitCode, 0);
    assert.equal(after.children[2]?.result?.detached, undefined);
    assert.equal(after.children[2]?.result?.finalOutput, "b.ts actual payload");
  });

  test("public status shows a detached foreground child and its eventual recovered output", async () => {
    const f = fixture(() => result("alpha", "unused", 0, "unused"));
    rememberForegroundRun(f.state, {
      runId: "recover-status-1234",
      mode: "single",
      cwd: f.context.cwd,
      results: [result("alpha", "task", -2, "waiting", true)],
    });

    const detached = await f.executor.execute("subagent", { action: "status", id: "recover-status" }, new AbortController().signal, undefined, f.context);
    assert.match(detached.content[0]?.type === "text" ? detached.content[0].text : "", /State: detached/);
    replaceForegroundRunChild(f.state, "recover-status-1234", 0, result("alpha", "task", 0, "actual recovered output"));
    const completed = await f.executor.execute("subagent", { action: "status", id: "recover-status" }, new AbortController().signal, undefined, f.context);
    const text = completed.content[0]?.type === "text" ? completed.content[0].text : "";
    assert.match(text, /State: completed/);
    assert.match(text, /actual recovered output/);
  });

  test("public status rejects prefixes ambiguous across retained foreground runs", async () => {
    const f = fixture(() => result("alpha", "unused", 0, "unused"));
    for (const runId of ["retained-one", "retained-two"]) {
      rememberForegroundRun(f.state, { runId, mode: "single", cwd: f.context.cwd, results: [result("alpha", "task", 0, runId)] });
    }
    const response = await f.executor.execute("subagent", { action: "status", id: "retained-" }, new AbortController().signal, undefined, f.context);
    assert.equal(response.isError, true);
    assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /Ambiguous subagent run id prefix/);
    assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /foreground:retained-one/);
    assert.match(response.content[0]?.type === "text" ? response.content[0].text : "", /foreground:retained-two/);
  });

  test("compacts recovered results before registered and early retention", () => {
    const recovered = result("alpha", "task", 0, "actual recovered output");
    recovered.sessionFile = "/tmp/recovered.jsonl";
    recovered.messages = [{ role: "user", content: "large transcript", timestamp: 1 }];
    recovered.progress = {
      index: 0, agent: "alpha", status: "completed", task: "task", recentTools: [], recentOutput: ["large output"],
      toolCount: 1, tokens: 10, durationMs: 20,
    };

    const registered = fixture(() => result("alpha", "unused", 0, "unused"));
    rememberForegroundRun(registered.state, { runId: "registered", mode: "single", cwd: "/tmp", results: [result("alpha", "task", -2, "waiting", true)] });
    replaceForegroundRunChild(registered.state, "registered", 0, recovered);
    const registeredResult = registered.state.foregroundRuns?.get("registered")?.children[0]?.result;
    assert.equal(registeredResult?.finalOutput, "actual recovered output");
    assert.equal(registeredResult?.sessionFile, "/tmp/recovered.jsonl");
    assert.equal(registeredResult?.messages, undefined);
    assert.equal(registeredResult?.progress, undefined);

    const early = fixture(() => result("alpha", "unused", 0, "unused"));
    replaceForegroundRunChild(early.state, "early-compacted", 0, recovered);
    rememberForegroundRun(early.state, { runId: "early-compacted", mode: "single", cwd: "/tmp", results: [result("alpha", "task", -2, "waiting", true)] });
    const earlyResult = early.state.foregroundRuns?.get("early-compacted")?.children[0]?.result;
    assert.equal(earlyResult?.finalOutput, "actual recovered output");
    assert.equal(earlyResult?.sessionFile, "/tmp/recovered.jsonl");
    assert.equal(earlyResult?.messages, undefined);
    assert.equal(earlyResult?.progress, undefined);
  });

  test("bounds and consumes early detached results", () => {
    const f = fixture(() => result("alpha", "unused", 0, "unused"));
    for (let run = 0; run < 60; run++) {
      replaceForegroundRunChild(f.state, `early-${run}`, 0, result("alpha", "task", 0, `actual-${run}`));
    }
    rememberForegroundRun(f.state, { runId: "early-0", mode: "single", cwd: "/tmp", results: [result("alpha", "task", -2, "waiting", true)] });
    rememberForegroundRun(f.state, { runId: "early-59", mode: "single", cwd: "/tmp", results: [result("alpha", "task", -2, "waiting", true)] });
    assert.equal(f.state.foregroundRuns?.get("early-0")?.children[0]?.status, "detached", "oldest early result was evicted");
    assert.equal(f.state.foregroundRuns?.get("early-59")?.children[0]?.status, "completed");
    assert.equal(f.state.foregroundRuns?.get("early-59")?.children[0]?.result?.finalOutput, "actual-59");
  });
});
