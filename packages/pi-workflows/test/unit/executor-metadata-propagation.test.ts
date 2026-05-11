/**
 * Regression tests — subagent env metadata propagation through the executor.
 *
 * Covers:
 *  - ctx.stage(...).subagent(...) propagates executor-owned runId/stageId into
 *    subagent env via pi.subagents.run path.
 *  - ctx.stage(...).subagent(...) propagates executor-owned runId/stageId into
 *    subagent env via pi.callTool fallback path.
 *  - Explicit executor metadata overrides conflicting process.env values.
 *  - Parallel stages share the same PI_WORKFLOW_RUN_ID but get distinct
 *    PI_WORKFLOW_STAGE_ID values.
 */
import { test, expect, describe } from "bun:test";
import { run } from "../../src/runs/sync/executor.js";
import { createStore } from "../../src/store.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";
import type { StageAdapters } from "../../src/runs/sync/stage-runner.js";
import type { SubagentStageMeta } from "../../src/runs/sync/stage-runner.js";
import type { SubagentStageOpts } from "../../src/shared/types.js";
import { buildRuntimeAdapters } from "../../src/extension/wiring.js";
import type { RuntimeWiringSurface } from "../../src/extension/wiring.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spy adapter that captures all subagent(opts, meta) calls and returns "ok".
 */
function makeSpySubagentAdapter(): {
  calls: Array<{ opts: SubagentStageOpts; meta?: SubagentStageMeta }>;
  adapter: StageAdapters;
} {
  const calls: Array<{ opts: SubagentStageOpts; meta?: SubagentStageMeta }> = [];
  const adapter: StageAdapters = {
    subagent: {
      async subagent(opts, meta) {
        calls.push({ opts, meta });
        return "ok";
      },
    },
  };
  return { calls, adapter };
}

/**
 * Build a RuntimeWiringSurface whose pi.subagents.run captures args.
 */
function makeSubagentRunSurface(calls: Array<Record<string, unknown>>): RuntimeWiringSurface {
  return {
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    subagents: {
      run: async (args: Record<string, unknown>) => {
        calls.push(args);
        return "subagents-ok";
      },
    },
  };
}

/**
 * Build a RuntimeWiringSurface that has no pi.subagents but has pi.callTool.
 */
function makeCallToolSurface(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
): RuntimeWiringSurface {
  return {
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    callTool: async (name, args) => {
      toolCalls.push({ name, args });
      return "calltool-ok";
    },
  };
}

// ---------------------------------------------------------------------------
// pi.subagents.run path — executor-level integration
// ---------------------------------------------------------------------------

describe("executor → subagent env propagation (pi.subagents.run path)", () => {
  test("PI_WORKFLOW_RUN_ID matches executor run's runId", async () => {
    const subagentCalls: Array<Record<string, unknown>> = [];
    const adapters = buildRuntimeAdapters(makeSubagentRunSurface(subagentCalls));

    const def = defineWorkflow("meta-run-id-subagents")
      .run(async (ctx) => {
        await ctx.stage("scout").subagent({ agent: "a", task: "t" });
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters, store: createStore() });
    expect(result.status).toBe("completed");

    const env = subagentCalls[0]!["env"] as Record<string, string>;
    expect(env["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
  });

  test("PI_WORKFLOW_STAGE_ID is a non-empty string", async () => {
    const subagentCalls: Array<Record<string, unknown>> = [];
    const adapters = buildRuntimeAdapters(makeSubagentRunSurface(subagentCalls));

    const def = defineWorkflow("meta-stage-id-subagents")
      .run(async (ctx) => {
        await ctx.stage("probe").subagent({ agent: "a", task: "t" });
        return {};
      })
      .compile();

    await run(def, {}, { adapters, store: createStore() });

    const env = subagentCalls[0]!["env"] as Record<string, string>;
    expect(typeof env["PI_WORKFLOW_STAGE_ID"]).toBe("string");
    expect(env["PI_WORKFLOW_STAGE_ID"].length).toBeGreaterThan(0);
  });

  test("PI_WORKFLOW_STAGE_ID matches snapshot stageId from executor", async () => {
    const subagentCalls: Array<Record<string, unknown>> = [];
    const adapters = buildRuntimeAdapters(makeSubagentRunSurface(subagentCalls));

    let capturedStageId: string | undefined;
    const def = defineWorkflow("meta-stage-id-matches-snapshot-subagents")
      .run(async (ctx) => {
        await ctx.stage("verify").subagent({ agent: "a", task: "t" });
        return {};
      })
      .compile();

    const result = await run(def, {}, {
      adapters,
      store: createStore(),
      onStageStart: (_runId, snap) => { capturedStageId = snap.id; },
    });

    expect(result.status).toBe("completed");
    const env = subagentCalls[0]!["env"] as Record<string, string>;
    expect(env["PI_WORKFLOW_STAGE_ID"]).toBe(capturedStageId);
  });

  test("explicit executor meta overrides ambient process.env in subagents path", async () => {
    const subagentCalls: Array<Record<string, unknown>> = [];
    const adapters = buildRuntimeAdapters(makeSubagentRunSurface(subagentCalls));

    const origRun = process.env["PI_WORKFLOW_RUN_ID"];
    const origStage = process.env["PI_WORKFLOW_STAGE_ID"];
    process.env["PI_WORKFLOW_RUN_ID"] = "ambient-run-should-be-overridden";
    process.env["PI_WORKFLOW_STAGE_ID"] = "ambient-stage-should-be-overridden";

    try {
      const def = defineWorkflow("meta-override-ambient-subagents")
        .run(async (ctx) => {
          await ctx.stage("override-test").subagent({ agent: "a", task: "t" });
          return {};
        })
        .compile();

      const result = await run(def, {}, { adapters, store: createStore() });
      const env = subagentCalls[0]!["env"] as Record<string, string>;

      // Executor-generated IDs must win over ambient process.env
      expect(env["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
      expect(env["PI_WORKFLOW_RUN_ID"]).not.toBe("ambient-run-should-be-overridden");
      expect(env["PI_WORKFLOW_STAGE_ID"]).not.toBe("ambient-stage-should-be-overridden");
    } finally {
      if (origRun !== undefined) process.env["PI_WORKFLOW_RUN_ID"] = origRun;
      else delete process.env["PI_WORKFLOW_RUN_ID"];
      if (origStage !== undefined) process.env["PI_WORKFLOW_STAGE_ID"] = origStage;
      else delete process.env["PI_WORKFLOW_STAGE_ID"];
    }
  });
});

// ---------------------------------------------------------------------------
// pi.callTool fallback path — executor-level integration
// ---------------------------------------------------------------------------

describe("executor → subagent env propagation (pi.callTool fallback path)", () => {
  test("PI_WORKFLOW_RUN_ID matches executor run's runId via callTool", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapters = buildRuntimeAdapters(makeCallToolSurface(toolCalls));

    const def = defineWorkflow("meta-run-id-calltool")
      .run(async (ctx) => {
        await ctx.stage("scout").subagent({ agent: "a", task: "t" });
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters, store: createStore() });
    expect(result.status).toBe("completed");

    const env = toolCalls[0]!.args["env"] as Record<string, string>;
    expect(env["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
  });

  test("PI_WORKFLOW_STAGE_ID is non-empty via callTool", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapters = buildRuntimeAdapters(makeCallToolSurface(toolCalls));

    const def = defineWorkflow("meta-stage-id-calltool")
      .run(async (ctx) => {
        await ctx.stage("probe").subagent({ agent: "a", task: "t" });
        return {};
      })
      .compile();

    await run(def, {}, { adapters, store: createStore() });
    const env = toolCalls[0]!.args["env"] as Record<string, string>;
    expect(typeof env["PI_WORKFLOW_STAGE_ID"]).toBe("string");
    expect(env["PI_WORKFLOW_STAGE_ID"].length).toBeGreaterThan(0);
  });

  test("explicit executor meta overrides ambient process.env in callTool path", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapters = buildRuntimeAdapters(makeCallToolSurface(toolCalls));

    const origRun = process.env["PI_WORKFLOW_RUN_ID"];
    const origStage = process.env["PI_WORKFLOW_STAGE_ID"];
    process.env["PI_WORKFLOW_RUN_ID"] = "ambient-run-calltool";
    process.env["PI_WORKFLOW_STAGE_ID"] = "ambient-stage-calltool";

    try {
      const def = defineWorkflow("meta-override-calltool")
        .run(async (ctx) => {
          await ctx.stage("override").subagent({ agent: "a", task: "t" });
          return {};
        })
        .compile();

      const result = await run(def, {}, { adapters, store: createStore() });
      const env = toolCalls[0]!.args["env"] as Record<string, string>;

      expect(env["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
      expect(env["PI_WORKFLOW_RUN_ID"]).not.toBe("ambient-run-calltool");
      expect(env["PI_WORKFLOW_STAGE_ID"]).not.toBe("ambient-stage-calltool");
    } finally {
      if (origRun !== undefined) process.env["PI_WORKFLOW_RUN_ID"] = origRun;
      else delete process.env["PI_WORKFLOW_RUN_ID"];
      if (origStage !== undefined) process.env["PI_WORKFLOW_STAGE_ID"] = origStage;
      else delete process.env["PI_WORKFLOW_STAGE_ID"];
    }
  });
});

// ---------------------------------------------------------------------------
// Parallel stages — shared runId, distinct stageId
// ---------------------------------------------------------------------------

describe("parallel stages — shared runId, distinct stageId in subagent env", () => {
  test("parallel stages produce same PI_WORKFLOW_RUN_ID in both subagent calls", async () => {
    const subagentCalls: Array<Record<string, unknown>> = [];
    const adapters = buildRuntimeAdapters(makeSubagentRunSurface(subagentCalls));

    const def = defineWorkflow("meta-parallel-same-run-id")
      .run(async (ctx) => {
        // Run both stages concurrently
        await Promise.all([
          ctx.stage("parallel-a").subagent({ agent: "a", task: "task-a" }),
          ctx.stage("parallel-b").subagent({ agent: "b", task: "task-b" }),
        ]);
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters, store: createStore() });
    expect(result.status).toBe("completed");
    expect(subagentCalls).toHaveLength(2);

    const envA = subagentCalls[0]!["env"] as Record<string, string>;
    const envB = subagentCalls[1]!["env"] as Record<string, string>;

    expect(envA["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
    expect(envB["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
  });

  test("parallel stages produce distinct PI_WORKFLOW_STAGE_ID values", async () => {
    const subagentCalls: Array<Record<string, unknown>> = [];
    const adapters = buildRuntimeAdapters(makeSubagentRunSurface(subagentCalls));

    const def = defineWorkflow("meta-parallel-distinct-stage-ids")
      .run(async (ctx) => {
        await Promise.all([
          ctx.stage("stage-x").subagent({ agent: "a", task: "x" }),
          ctx.stage("stage-y").subagent({ agent: "b", task: "y" }),
        ]);
        return {};
      })
      .compile();

    await run(def, {}, { adapters, store: createStore() });
    expect(subagentCalls).toHaveLength(2);

    const envA = subagentCalls[0]!["env"] as Record<string, string>;
    const envB = subagentCalls[1]!["env"] as Record<string, string>;

    expect(envA["PI_WORKFLOW_STAGE_ID"]).toBeDefined();
    expect(envB["PI_WORKFLOW_STAGE_ID"]).toBeDefined();
    expect(envA["PI_WORKFLOW_STAGE_ID"]).not.toBe(envB["PI_WORKFLOW_STAGE_ID"]);
  });

  test("parallel stages via callTool — same runId, distinct stageId", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapters = buildRuntimeAdapters(makeCallToolSurface(toolCalls));

    const def = defineWorkflow("meta-parallel-calltool")
      .run(async (ctx) => {
        await Promise.all([
          ctx.stage("ct-a").subagent({ agent: "a", task: "a" }),
          ctx.stage("ct-b").subagent({ agent: "b", task: "b" }),
        ]);
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters, store: createStore() });
    expect(result.status).toBe("completed");
    expect(toolCalls).toHaveLength(2);

    const envA = toolCalls[0]!.args["env"] as Record<string, string>;
    const envB = toolCalls[1]!.args["env"] as Record<string, string>;

    // Same run, different stages
    expect(envA["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
    expect(envB["PI_WORKFLOW_RUN_ID"]).toBe(result.runId);
    expect(envA["PI_WORKFLOW_STAGE_ID"]).not.toBe(envB["PI_WORKFLOW_STAGE_ID"]);
  });
});

// ---------------------------------------------------------------------------
// Spy-adapter path — verifies stage-runner correctly passes executor meta
// ---------------------------------------------------------------------------

describe("executor → stage-runner meta passthrough (spy adapter)", () => {
  test("subagent adapter receives runId matching result.runId", async () => {
    const { calls, adapter } = makeSpySubagentAdapter();

    const def = defineWorkflow("meta-spy-run-id")
      .run(async (ctx) => {
        await ctx.stage("spy").subagent({ agent: "a", task: "t" });
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters: adapter, store: createStore() });
    expect(calls[0]!.meta?.runId).toBe(result.runId);
  });

  test("subagent adapter receives stageId matching snapshot id", async () => {
    const { calls, adapter } = makeSpySubagentAdapter();
    let snapshotStageId: string | undefined;

    const def = defineWorkflow("meta-spy-stage-id")
      .run(async (ctx) => {
        await ctx.stage("spy-stage").subagent({ agent: "a", task: "t" });
        return {};
      })
      .compile();

    await run(def, {}, {
      adapters: adapter,
      store: createStore(),
      onStageStart: (_runId, snap) => { snapshotStageId = snap.id; },
    });

    expect(calls[0]!.meta?.stageId).toBeDefined();
    expect(calls[0]!.meta?.stageId).toBe(snapshotStageId);
  });

  test("parallel stage adapters each receive distinct stageId", async () => {
    const { calls, adapter } = makeSpySubagentAdapter();

    const def = defineWorkflow("meta-spy-parallel-stage-ids")
      .run(async (ctx) => {
        await Promise.all([
          ctx.stage("spy-a").subagent({ agent: "a", task: "a" }),
          ctx.stage("spy-b").subagent({ agent: "b", task: "b" }),
        ]);
        return {};
      })
      .compile();

    await run(def, {}, { adapters: adapter, store: createStore() });
    expect(calls).toHaveLength(2);

    const idA = calls[0]!.meta?.stageId;
    const idB = calls[1]!.meta?.stageId;
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);
  });

  test("parallel stage adapters each receive same runId", async () => {
    const { calls, adapter } = makeSpySubagentAdapter();

    const def = defineWorkflow("meta-spy-parallel-run-id")
      .run(async (ctx) => {
        await Promise.all([
          ctx.stage("spy-c").subagent({ agent: "a", task: "c" }),
          ctx.stage("spy-d").subagent({ agent: "b", task: "d" }),
        ]);
        return {};
      })
      .compile();

    const result = await run(def, {}, { adapters: adapter, store: createStore() });
    expect(calls[0]!.meta?.runId).toBe(result.runId);
    expect(calls[1]!.meta?.runId).toBe(result.runId);
  });
});
