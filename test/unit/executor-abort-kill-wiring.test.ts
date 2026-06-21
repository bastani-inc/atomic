import { describe } from "bun:test";
import {
    assert, createStore, defineWorkflow, run, test
} from "./executor-shared.js";

describe("executor.run — abort/kill wiring", () => {
    test("abort signal aborts in-flight stage, run finishes as killed", async () => {
        const { createCancellationRegistry } =
            await import("../../packages/workflows/src/runs/background/cancellation-registry.js");
        const registry = createCancellationRegistry();
        const controller = new AbortController();

        const def = defineWorkflow("abort-wf")
            .run(async (ctx) => {
                await ctx.stage("slow").prompt("go");
                return {};
            })
            .compile();

        let adapterResolve!: (value: string) => void;
        const adapterPromise = new Promise<string>((resolve) => {
            adapterResolve = resolve;
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (_text) => adapterPromise },
                },
                store: createStore(),
                cancellation: registry,
                signal: controller.signal,
            },
        );

        // Abort after a short delay while the adapter is pending
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        controller.abort();

        const result = await runPromise;

        assert.equal(result.status, "killed");
        assert.equal(result.error, "workflow killed");

        // Clean up the never-resolving adapter promise
        adapterResolve("ignored");
    });

    test("external killRun + executor abort path: workflow.run.end appended exactly once", async () => {
        const { createCancellationRegistry } =
            await import("../../packages/workflows/src/runs/background/cancellation-registry.js");
        const { killRun } =
            await import("../../packages/workflows/src/runs/background/status.js");

        const registry = createCancellationRegistry();
        const testStore = createStore();

        const calls: Array<{ type: string; payload: Record<string, unknown> }> =
            [];
        const persistence = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
        };

        const def = defineWorkflow("no-dup-kill-wf")
            .run(async (ctx) => {
                await ctx.stage("slow").prompt("go");
                return {};
            })
            .compile();

        let capturedRunId!: string;
        let adapterResolve!: (value: string) => void;
        const adapterPromise = new Promise<string>((resolve) => {
            adapterResolve = resolve;
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (_text) => adapterPromise },
                },
                store: testStore,
                cancellation: registry,
                persistence,
                onRunStart: (snap) => {
                    capturedRunId = snap.id;
                },
            },
        );

        // Wait for executor to register and stage to be in-flight
        await new Promise<void>((resolve) => setTimeout(resolve, 20));

        // External kill path: records "killed" in store + appends one workflow.run.end
        const killResult = killRun(capturedRunId, {
            store: testStore,
            cancellation: registry,
            persistence,
        });
        assert.equal(killResult.ok, true);
        assert.equal(killResult.runId, capturedRunId);
        assert.equal(killResult.previousStatus, "running");

        // Resolve the dangling adapter promise (executor is already aborted, ignored)
        adapterResolve("ignored");

        const result = await runPromise;
        assert.equal(result.status, "killed");

        // Executor's abort path called recordRunEnd → store returned false (already terminal)
        // appendRunEndWhenRecorded skipped → total workflow.run.end entries = 1 (from killRun only)
        const runEndCalls = calls.filter((c) => c.type === "workflow.run.end");
        assert.equal(runEndCalls.length, 1);
        assert.equal(runEndCalls[0]?.payload["status"], "killed");
        assert.equal(runEndCalls[0]?.payload["runId"], capturedRunId);
    });

    test("later resolution doesn't overwrite killed status", async () => {
        const { createCancellationRegistry } =
            await import("../../packages/workflows/src/runs/background/cancellation-registry.js");
        const testStore = createStore();
        const registry = createCancellationRegistry();

        const def = defineWorkflow("abort-guard-wf")
            .run(async (ctx) => {
                await ctx.stage("slow").prompt("go");
                return {};
            })
            .compile();

        let adapterResolve!: (value: string) => void;
        const adapterPromise = new Promise<string>((resolve) => {
            adapterResolve = resolve;
        });

        const runPromise = run(
            def,
            {},
            {
                adapters: {
                    prompt: { prompt: async (_text) => adapterPromise },
                },
                store: testStore,
                cancellation: registry,
            },
        );

        // Wait for the run to be registered, then abort all
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        registry.abortAll("workflow killed");

        // Resolve the adapter after the abort (should be ignored)
        adapterResolve("done");

        const result = await runPromise;

        assert.equal(result.status, "killed");
        assert.equal(testStore.snapshot().runs[0]?.status, "killed");
    });

    // ---------------------------------------------------------------------------
    // Regression: post-stage abort race
    // Abort fires AFTER final stage settles but BEFORE workflow body returns.
    // The post-body abort check (executor.ts line ~329) must intercept and
    // finalize as "killed" — never "completed".
    // ---------------------------------------------------------------------------
    test("abort after final stage settles but before body returns → killed", async () => {
        const testStore = createStore();
        const controller = new AbortController();

        // Gate that holds the workflow body suspended after the stage resolves.
        // Gives us a deterministic window to fire the abort signal.
        let releaseWorkflow!: () => void;
        const holdWorkflow = new Promise<void>((resolve) => {
            releaseWorkflow = resolve;
        });

        const def = defineWorkflow("post-stage-abort-race-wf")
            .run(async (ctx) => {
                await ctx.stage("final").prompt("go");
                // Stage has settled here. Suspend so the test can abort before we return.
                await holdWorkflow;
                return {};
            })
            .compile();

        const onRunEndCalls: Array<{ status: string }> = [];
        const persistenceCalls: Array<{
            type: string;
            payload: Record<string, unknown>;
        }> = [];
        const persistence = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                persistenceCalls.push({ type, payload });
                return `entry-${persistenceCalls.length}`;
            },
        };

        const runPromise = run(
            def,
            {},
            {
                // Adapter resolves immediately so the stage settles without delay.
                adapters: { prompt: { prompt: async (_text: string) => "ok" } },
                store: testStore,
                signal: controller.signal,
                persistence,
                onRunEnd: (_runId, status) => {
                    onRunEndCalls.push({ status });
                },
            },
        );

        // Wait for stage to complete and workflow body to reach holdWorkflow.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));

        // Abort fires AFTER stage settled, BEFORE workflow body returns.
        controller.abort();

        // Release the workflow body so def.run(ctx) can try to return {}.
        releaseWorkflow();

        const result = await runPromise;

        // Run result must be "killed"
        assert.equal(result.status, "killed");
        assert.equal(result.error, "workflow killed");

        // Store must reflect "killed"
        assert.equal(testStore.snapshot().runs[0]?.status, "killed");

        // onRunEnd must see "killed"
        assert.equal(onRunEndCalls.length, 1);
        assert.equal(onRunEndCalls[0]?.status, "killed");

        // Persistence must have exactly one workflow.run.end entry and it must be "killed".
        // No "completed" entry should exist.
        const runEndEntries = persistenceCalls.filter(
            (c) => c.type === "workflow.run.end",
        );
        assert.equal(runEndEntries.length, 1);
        assert.equal(runEndEntries[0]?.payload["status"], "killed");

        const completedEntries = persistenceCalls.filter(
            (c) =>
                c.type === "workflow.run.end" &&
                c.payload["status"] === "completed",
        );
        assert.equal(completedEntries.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Concurrency limiter integration
// ---------------------------------------------------------------------------

