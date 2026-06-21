import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason?: unknown) => void } {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ctx.exit", () => {
  test("failed workflow boundaries clear linked child metadata and omit child replay persistence", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const child = defineWorkflow("exit-failed-boundary-child")
      .output("count", Type.Number())
      .run(async (ctx) => {
        await ctx.stage("child-ready").prompt("child ready");
        return { count: "not-a-number" as never };
      })
      .compile();
    const parent = defineWorkflow("exit-failed-boundary-parent")
      .run(async (ctx) => {
        await ctx.workflow(child);
        return {};
      })
      .compile();

    const result = await run(parent, {}, {
      store,
      persistence,
      adapters: { prompt: { prompt: async () => "ready" } },
    });

    assert.equal(result.status, "failed");
    const boundary = result.stages.find((stage) => stage.name === "workflow:exit-failed-boundary-child");
    assert.equal(boundary?.status, "failed");
    assert.equal(boundary?.workflowChildRun, undefined);
    assert.equal(boundary?.workflowChild, undefined);
    const boundaryEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === result.runId &&
      entry.payload["stageId"] === boundary?.id
    );
    assert.equal(boundaryEnd?.payload["status"], "failed");
    assert.equal("workflowChild" in (boundaryEnd?.payload ?? {}), false);
  });

  test("ctx.exit before continuation replay finalization clears preloaded workflow child metadata", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const child = defineWorkflow("exit-replay-child")
      .output("value", Type.String())
      .run(async (ctx) => {
        const value = await ctx.stage("child").prompt("child");
        return { value };
      })
      .compile();
    const parent = defineWorkflow("exit-replay-parent")
      .input("mode", Type.String())
      .run(async (ctx) => {
        if (ctx.inputs.mode === "exit") {
          await Promise.all([
            Promise.resolve().then(() => ctx.exit({ status: "skipped", reason: "replay gate" })),
            ctx.workflow(child),
          ]);
          return {};
        }
        const childResult = await ctx.workflow(child);
        if (childResult.exited === true) throw new Error("source child exited unexpectedly");
        await ctx.stage("after").prompt(`after:${childResult.outputs.value}`);
        return {};
      })
      .compile();

    const sourceResult = await run(parent, { mode: "source" }, {
      store,
      persistence,
      adapters: {
        prompt: {
          prompt: async (text) => {
            if (text.startsWith("after:")) throw new Error("source failure after child replay point");
            return "child-ok";
          },
        },
      },
    });
    assert.equal(sourceResult.status, "failed");
    const source = store.runs().find((runSnapshot) => runSnapshot.id === sourceResult.runId)!;
    const sourceBoundary = source.stages.find((stage) => stage.name === "workflow:exit-replay-child");
    assert.equal(sourceBoundary?.status, "completed");
    assert.equal(sourceBoundary?.workflowChild?.outputs["value"], "child-ok");

    const continued = await run(parent, { mode: "exit" }, {
      store,
      persistence,
      continuation: { source, resumeFromStageId: source.failedStageId! },
      adapters: { prompt: { prompt: async () => "should-not-run" } },
    });

    assert.equal(continued.status, "skipped");
    assert.equal(continued.exitReason, "replay gate");
    const boundary = continued.stages.find((stage) => stage.name === "workflow:exit-replay-child");
    assert.equal(boundary?.status, "skipped");
    assert.equal(boundary?.skippedReason, "workflow-exit: replay gate");
    assert.equal(boundary?.workflowChildRun, undefined);
    assert.equal(boundary?.workflowChild, undefined);
    const boundaryEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === continued.runId &&
      entry.payload["stageId"] === boundary?.id
    );
    assert.equal(boundaryEnd?.payload["status"], "skipped");
    assert.equal("workflowChild" in (boundaryEnd?.payload ?? {}), false);
    assert.equal(
      store.runs().filter((runSnapshot) => runSnapshot.name === "exit-replay-child").length,
      1,
    );
  });

  test("delayed prompt-node UI calls after exit do not create prompt stages", async () => {
    const store = createStore();
    const lateUiDone = deferred();
    let lateUiAttempted = false;
    const def = defineWorkflow("exit-delayed-ui-guard")
      .run(async (ctx) => {
        void (async () => {
          await delay(20);
          lateUiAttempted = true;
          try {
            await ctx.ui.input("late input");
          } catch {
            // Expected: the selected ctx.exit sentinel is rethrown before prompt-node creation.
          } finally {
            lateUiDone.resolve();
          }
        })();
        return ctx.exit({ status: "cancelled", reason: "ui gate" });
      })
      .compile();

    const result = await run(def, {}, { store, usePromptNodesForUi: true });
    await lateUiDone.promise;

    assert.equal(result.status, "cancelled");
    assert.equal(lateUiAttempted, true);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.deepEqual(snapshot?.stages, []);
  });

  test("preserves workflow-exit reasons when prompt-node abort handling runs after cleanup", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = defineWorkflow("exit-prompt-node-reason")
      .run(async (ctx) => {
        await Promise.all([
          ctx.ui.input("wait for exit"),
          (async () => {
            await delay(10);
            return ctx.exit({ status: "skipped", reason: "prompt gate" });
          })(),
        ]);
        return {};
      })
      .compile();

    const result = await run(def, {}, { store, persistence, usePromptNodesForUi: true });
    await delay(20);

    assert.equal(result.status, "skipped");
    assert.equal(result.exitReason, "prompt gate");
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    const promptStage = snapshot?.stages.find((stage) => stage.name === "input");
    assert.equal(promptStage?.status, "skipped");
    assert.equal(promptStage?.skippedReason, "workflow-exit: prompt gate");
    const persistedPromptEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      entry.payload["runId"] === result.runId &&
      entry.payload["stageId"] === promptStage?.id
    );
    assert.equal(persistedPromptEnd?.payload["status"], "skipped");
    assert.equal(persistedPromptEnd?.payload["skippedReason"], "workflow-exit: prompt gate");
  });

  test("keeps the first exit when a later exit is thrown during unwind", async () => {
    const def = defineWorkflow("exit-first-wins")
      .output("winner", Type.String())
      .run(async (ctx) => {
        try {
          return ctx.exit({ status: "skipped", reason: "first", outputs: { winner: "first" } });
        } finally {
          ctx.exit({ status: "cancelled", reason: "second", outputs: { winner: "second" } });
        }
      })
      .compile();

    const result = await run(def, {}, { store: createStore() });

    assert.equal(result.status, "skipped");
    assert.equal(result.exitReason, "first");
    assert.deepEqual(result.result, { winner: "first" });
  });

  test("fails the run when exit outputs violate declared schemas", async () => {
    const def = defineWorkflow("exit-invalid-output")
      .output("count", Type.Number())
      .run(async (ctx) => {
        return ctx.exit({ outputs: { count: "not-a-number" as never } });
      })
      .compile();

    const result = await run(def, {}, { store: createStore() });

    assert.equal(result.status, "failed");
    assert.match(
      result.error ?? "",
      /workflow "exit-invalid-output" ctx\.exit\(\) output "count" expected number, got string/,
    );
  });

  test("scopes child workflow exits to the child result", async () => {
    const store = createStore();
    const child = defineWorkflow("exit-child")
      .output("note", Type.String())
      .run(async (ctx) => {
        return ctx.exit({ status: "skipped", reason: "child guard", outputs: { note: "child-note" } });
      })
      .compile();
    const parent = defineWorkflow("exit-parent")
      .output("childStatus", Type.String())
      .output("childNote", Type.String())
      .output("childReason", Type.String())
      .run(async (ctx) => {
        const childResult = await ctx.workflow(child);
        if (childResult.exited === true) {
          return {
            childStatus: childResult.status,
            childNote: childResult.outputs.note ?? "",
            childReason: childResult.exitReason ?? "",
          };
        }
        return {
          childStatus: childResult.status,
          childNote: childResult.outputs.note,
          childReason: "",
        };
      })
      .compile();

    const result = await run(parent, {}, { store });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
      childStatus: "skipped",
      childNote: "child-note",
      childReason: "child guard",
    });
    const childSnapshot = store.runs().find((runSnapshot) => runSnapshot.name === "exit-child");
    assert.equal(childSnapshot?.status, "skipped");
    assert.equal(childSnapshot?.exitReason, "child guard");
    const boundary = result.stages.find((stage) => stage.name === "workflow:exit-child");
    assert.equal(boundary?.status, "completed");
    assert.equal(boundary?.workflowChild?.status, "skipped");
    assert.equal(boundary?.workflowChild?.exited, true);
    assert.equal(boundary?.workflowChild?.exitReason, "child guard");
  });

  test("cleans up in-flight work before failing invalid exit output containers", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = defineWorkflow("exit-invalid-output-cleanup")
      .output("count", Type.Number())
      .run(async (ctx) => {
        await Promise.all([
          ctx.parallel([
            { name: "slow-cleanup-a", prompt: "slow-cleanup-a" },
            { name: "slow-cleanup-b", prompt: "slow-cleanup-b" },
          ]),
          (async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return ctx.exit({ reason: "bad outputs after cleanup", outputs: [] as never });
          })(),
        ]);
        return { count: 1 };
      })
      .compile();

    const result = await run(def, {}, {
      store,
      persistence,
      adapters: {
        prompt: {
          prompt: async () => new Promise<string>(() => {}),
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /ctx\.exit\(\) outputs must be a JSON-serializable .* object, got array/);
    assert.deepEqual(
      result.stages.map((stage) => [stage.name, stage.status, stage.skippedReason]),
      [
        ["slow-cleanup-a", "skipped", "workflow-exit: bad outputs after cleanup"],
        ["slow-cleanup-b", "skipped", "workflow-exit: bad outputs after cleanup"],
      ],
    );
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.resumable, false);
    assert.equal(snapshot?.exitReason, "bad outputs after cleanup");
    assert.equal(snapshot?.stages.some((stage) => stage.status === "running" || stage.attachable === true), false);
    const runEnd = entries.find((entry) => entry.type === "workflow.run.end" && entry.payload["runId"] === result.runId);
    assert.equal(runEnd?.payload["status"], "failed");
    assert.equal(runEnd?.payload["resumable"], false);
    assert.equal(runEnd?.payload["exitReason"], "bad outputs after cleanup");
  });

});
