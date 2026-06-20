import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { killRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { NON_INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import type { WorkflowChildResult } from "../../packages/workflows/src/shared/types.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

function expectString(value: string): void {
  assert.equal(typeof value, "string");
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

function fakeAgentSession(): Record<string, unknown> {
  return {
    sessionId: "session-retained",
    sessionFile: "session-retained.jsonl",
    isStreaming: false,
    messages: [],
    model: "sonnet",
    thinkingLevel: "medium",
    agent: {},
    async prompt() { return ""; },
    async steer() {},
    async followUp() {},
    subscribe() { return () => {}; },
    async setModel(model: string) { this.model = model; },
    setThinkingLevel(level: string) { this.thinkingLevel = level; },
    async cycleModel() { this.model = "opus"; return undefined; },
    cycleThinkingLevel() { this.thinkingLevel = "high"; return undefined; },
    async navigateTree() { return { cancelled: false }; },
    async compact() { return { summary: "", firstKeptEntryId: "", tokensBefore: 10, tokensAfter: 5 }; },
    abortCompaction() {},
    async abort() {},
    dispose() {},
    getLastAssistantText() { return undefined; },
  };
}

function controlProbeSymbolDescription(key: PropertyKey): string | undefined {
  return typeof key === "symbol" ? key.description : undefined;
}

function errorWithThrowingControlProbeAccessors(message: string): Error {
  const error = new Error(message);
  for (const key of ["cause", "reason", "errors", "scope"] as const) {
    Object.defineProperty(error, key, {
      configurable: true,
      get() {
        throw new Error(`${key} accessor should not escape control-signal probing`);
      },
    });
  }
  return new Proxy(error, {
    get(target, key, receiver) {
      const description = controlProbeSymbolDescription(key);
      if (description?.includes("atomic-workflows.workflow-exit-signal") === true) {
        throw new Error("workflow-exit marker accessor should not escape control-signal probing");
      }
      if (description?.includes("atomic-workflows.parent-workflow-exit-abort") === true) {
        throw new Error("parent-exit marker accessor should not escape control-signal probing");
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

describe("ctx.exit", () => {
  test("returns canonical killed result when invalid ctx.exit output loses to external kill", async () => {
    const store = createStore();
    const cancellation = createCancellationRegistry();
    const promptStarted = deferred();
    const cleanupAbortStarted = deferred();
    const releaseCleanup = deferred();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const onRunEndCalls: Array<{ status: string; error?: string; exitReason?: string }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const def = defineWorkflow("exit-invalid-output-kill-race")
      .output("count", Type.Number())
      .run(async (ctx) => {
        await Promise.all([
          ctx.task("cleanup-pending", { prompt: "wait for cleanup" }),
          (async () => {
            await promptStarted.promise;
            return ctx.exit({
              status: "completed",
              reason: "invalid output cleanup pending",
              outputs: { count: "not-a-number" as never },
            });
          })(),
        ]);
        return { count: 1 };
      })
      .compile();

    let runId = "";
    const runPromise = run(def, {}, {
      store,
      cancellation,
      persistence,
      onRunStart: (snapshot) => {
        runId = snapshot.id;
      },
      onRunEnd: (_runId, status, _result, error, exitReason) => {
        onRunEndCalls.push({
          status,
          ...(error !== undefined ? { error } : {}),
          ...(exitReason !== undefined ? { exitReason } : {}),
        });
      },
      adapters: {
        agentSession: {
          create: async () => ({
            ...fakeAgentSession(),
            sessionId: "exit-invalid-output-kill-race-session",
            sessionFile: "exit-invalid-output-kill-race-session.jsonl",
            async prompt() {
              promptStarted.resolve();
              return new Promise<string>(() => {});
            },
            async abort() {
              cleanupAbortStarted.resolve();
              await releaseCleanup.promise;
            },
          }) as never,
        },
      },
    });

    await cleanupAbortStarted.promise;
    const killed = killRun(runId, { store, cancellation, persistence });
    assert.equal(killed.ok, true);
    releaseCleanup.resolve();

    const result = await runPromise;

    assert.equal(result.status, "killed");
    assert.equal(result.error, "workflow killed");
    assert.equal(result.exitReason, undefined);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === runId);
    assert.equal(snapshot?.status, "killed");
    assert.equal(snapshot?.error, "workflow killed");
    assert.equal(snapshot?.exitReason, undefined);
    const runEndEntries = entries.filter((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === runId
    );
    assert.equal(runEndEntries.length, 1);
    assert.equal(runEndEntries[0]?.payload["status"], "killed");
    assert.equal(runEndEntries.some((entry) => entry.payload["status"] === "failed"), false);
    assert.equal(runEndEntries.some((entry) => entry.payload["status"] === "completed"), false);
    assert.deepEqual(onRunEndCalls, [{ status: "killed", error: "workflow killed" }]);
  });

  test("finalizes ordinary failures when control-signal probing sees throwing accessors", async () => {
    const store = createStore();
    const thrown = errorWithThrowingControlProbeAccessors("ordinary control-probe failure");
    const def = defineWorkflow("exit-safe-probe-ordinary-failure")
      .run(async () => {
        throw thrown;
      })
      .compile();

    const result = await run(def, {}, { store });

    assert.equal(result.status, "failed");
    assert.equal(result.exited, undefined);
    assert.equal(result.exitReason, undefined);
    assert.match(result.error ?? "", /ordinary control-probe failure/);
    assert.doesNotMatch(result.error ?? "", /accessor should not escape|workflow-exit|ctx\.exit/);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.exited, undefined);
    assert.equal(snapshot?.exitReason, undefined);
  });

  test("ignores AggregateError-like errors accessors that throw during ctx.exit probing", async () => {
    const store = createStore();
    const aggregateLike = { message: "ordinary aggregate-like failure" } as { readonly message: string; readonly errors?: unknown };
    Object.defineProperty(aggregateLike, "errors", {
      configurable: true,
      get() {
        throw new Error("aggregate errors accessor should not escape control-signal probing");
      },
    });
    const def = defineWorkflow("exit-safe-probe-aggregate-errors")
      .run(async () => {
        throw aggregateLike;
      })
      .compile();

    const result = await run(def, {}, { store });

    assert.equal(result.status, "failed");
    assert.equal(result.exited, undefined);
    assert.equal(result.exitReason, undefined);
    assert.match(result.error ?? "", /ordinary aggregate-like failure/);
    assert.doesNotMatch(result.error ?? "", /aggregate errors accessor should not escape|workflow-exit|ctx\.exit/);
  });

  test("treats aborted runs with throwing control-signal probe accessors as killed", async () => {
    const store = createStore();
    const controller = new AbortController();
    controller.abort(errorWithThrowingControlProbeAccessors("external abort should stay killed"));
    const def = defineWorkflow("exit-safe-probe-abort-reason")
      .run(async () => ({}))
      .compile();

    const result = await run(def, {}, { store, signal: controller.signal });

    assert.equal(result.status, "killed");
    assert.equal(result.error, "workflow killed");
    assert.equal(result.exited, undefined);
    assert.equal(result.exitReason, undefined);
    const snapshot = store.runs().find((runSnapshot) => runSnapshot.id === result.runId);
    assert.equal(snapshot?.status, "killed");
    assert.equal(snapshot?.exited, undefined);
    assert.equal(snapshot?.exitReason, undefined);
  });

  test("returns completed child ctx.exit results as exited with partial outputs", async () => {
    const store = createStore();
    const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const persistence = {
      appendEntry(type: string, payload: Record<string, unknown>): string {
        entries.push({ type, payload });
        return `entry-${entries.length}`;
      },
    };
    const child = defineWorkflow("exit-child-completed-partial")
      .output("requiredNote", Type.String())
      .output("optionalCount", Type.Optional(Type.Number()))
      .run(async (ctx) => {
        return ctx.exit({ status: "completed", outputs: { optionalCount: 7 } });
      })
      .compile();
    const parent = defineWorkflow("exit-parent-completed-child")
      .output("childExited", Type.Boolean())
      .output("childStatus", Type.String())
      .output("requiredPresent", Type.Boolean())
      .output("optionalCount", Type.Number())
      .run(async (ctx) => {
        const childResult = await ctx.workflow(child);
        if (childResult.exited === true) {
          return {
            childExited: true,
            childStatus: childResult.status,
            requiredPresent: childResult.outputs.requiredNote !== undefined,
            optionalCount: childResult.outputs.optionalCount ?? -1,
          };
        }
        return {
          childExited: false,
          childStatus: childResult.status,
          requiredPresent: childResult.outputs.requiredNote.length > 0,
          optionalCount: childResult.outputs.optionalCount ?? -1,
        };
      })
      .compile();

    const result = await run(parent, {}, { store, persistence });

    assert.equal(result.status, "completed");
    assert.deepEqual(result.result, {
      childExited: true,
      childStatus: "completed",
      requiredPresent: false,
      optionalCount: 7,
    });
    const childSnapshot = store.runs().find((runSnapshot) => runSnapshot.name === "exit-child-completed-partial");
    assert.equal(childSnapshot?.status, "completed");
    assert.equal(childSnapshot?.exited, true);
    const boundary = result.stages.find((stage) => stage.name === "workflow:exit-child-completed-partial");
    assert.equal(boundary?.workflowChild?.status, "completed");
    assert.equal(boundary?.workflowChild?.exited, true);
    assert.deepEqual(boundary?.workflowChild?.outputs, { optionalCount: 7 });
    const childRunEnd = entries.find((entry) =>
      entry.type === "workflow.run.end" && entry.payload["runId"] === childSnapshot?.id
    );
    assert.equal(childRunEnd?.payload["status"], "completed");
    assert.equal(childRunEnd?.payload["exited"], true);
    const boundaryEnd = entries.find((entry) =>
      entry.type === "workflow.stage.end" &&
      (entry.payload["workflowChild"] as { workflow?: unknown } | undefined)?.workflow === "exit-child-completed-partial"
    );
    assert.equal((boundaryEnd?.payload["workflowChild"] as { exited?: unknown } | undefined)?.exited, true);
  });

  test("WorkflowChildResult narrows full outputs behind exited === false", () => {
    type ChildOutputs = { readonly requiredNote: string; readonly optionalCount?: number };
    const normal: WorkflowChildResult<ChildOutputs> = {
      workflow: "child",
      runId: "run-normal",
      status: "completed",
      exited: false,
      outputs: { requiredNote: "ready" },
    };
    const exited: WorkflowChildResult<ChildOutputs> = {
      workflow: "child",
      runId: "run-exited",
      status: "completed",
      exited: true,
      outputs: {},
    };

    const assertNarrowing = (child: WorkflowChildResult<ChildOutputs>): void => {
      // Type-only negative assertion (reachable, no failing runtime effect): on the union
      // `child.outputs` is Partial when exited is true, so `requiredNote` is `string | undefined`
      // and is not assignable to `string` without the `exited === false` guard below.
      // @ts-expect-error unguarded child outputs may be partial when child.exited is true.
      const _requiredMayBeUndefined: string = child.outputs.requiredNote;
      void _requiredMayBeUndefined;
      if (child.exited === true) {
        const maybeRequired: string | undefined = child.outputs.requiredNote;
        assert.equal(maybeRequired === undefined || typeof maybeRequired === "string", true);
      } else {
        expectString(child.outputs.requiredNote);
      }
    };

    assertNarrowing(normal);
    assertNarrowing(exited);
  });

  test("non-interactive dispatch returns ctx.exit status, reason, and marker", async () => {
    const store = createStore();
    const jobs = createJobTracker();
    const def = defineWorkflow("headless-exit")
      .output("note", Type.String())
      .run(async (ctx) => {
        return ctx.exit({ status: "skipped", reason: "headless guard", outputs: { note: "ok" } });
      })
      .compile();
    const registry = createRegistry([def]);

    const result = await dispatch(
      { action: "run", workflow: "headless-exit", inputs: {} },
      {
        registry,
        store,
        jobs,
        cancellation: createCancellationRegistry(),
        policy: NON_INTERACTIVE_WORKFLOW_POLICY,
      },
    );

    assert.equal(result.action, "run");
    if (result.action === "run") {
      assert.equal(result.status, "skipped");
      assert.equal(result.exitReason, "headless guard");
      assert.equal(result.exited, true);
      assert.deepEqual(result.result, { note: "ok" });
    }
  });
});
