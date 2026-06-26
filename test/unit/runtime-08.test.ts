// @ts-nocheck
/**
 * Extension runtime dispatcher tests.
 *
 * Covers the contract after foreground execution was removed:
 *   - list / inputs are unchanged
 *   - run is always background — dispatch returns synchronously with
 *     `status: "running"`; final state lives on the store
 *   - renderResult for the run variant emits a dispatch confirmation card
 *   - persistence forwarding still fires the full lifecycle
 *
 * HIL routing (ctx.ui.input/confirm/select/editor) is no longer driven by
 * the runtime — that flow is tested in `background-runner-hil.test.ts` and
 * `background-ui-adapter.test.ts`.
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { Type } from "typebox";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { WORKFLOW_UNKNOWN_MODEL_MESSAGE } from "../../packages/workflows/src/shared/workflow-failures.js";
import { NON_INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import type {
    WorkflowDefinition,
    WorkflowPersistencePort,
} from "../../packages/workflows/src/shared/types.js";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type {
    StageAdapters,
    StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type {
    WorkflowToolResult,
    WorkflowInputEntry,
} from "../../packages/workflows/src/extension/render-result.js";

// ---------------------------------------------------------------------------
// Type-safe result narrowers
// ---------------------------------------------------------------------------

type ListResult = Extract<WorkflowToolResult, { action: "list" }>;
type InputsResult = Extract<WorkflowToolResult, { action: "inputs" }>;
type RunResult = Extract<WorkflowToolResult, { action: "run"; runId: string }>;

function asList(r: WorkflowToolResult): ListResult {
    if (r.action !== "list") throw new Error(`expected list, got ${r.action}`);
    return r as ListResult;
}
function asInputs(r: WorkflowToolResult): InputsResult {
    if (r.action !== "inputs")
        throw new Error(`expected inputs, got ${r.action}`);
    return r as InputsResult;
}
function asRun(r: WorkflowToolResult): RunResult {
    if (r.action !== "run" || !("runId" in r))
        throw new Error(`expected run, got ${r.action}`);
    return r as RunResult;
}

async function waitForRunEnded(
    store: ReturnType<typeof createStore>,
    runId: string,
    timeoutMs = 1000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const run = store.runs().find((r) => r.id === runId);
        if (run?.endedAt !== undefined) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`run ${runId} did not end in time`);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const noopAdapters: StageAdapters = {
    prompt: { prompt: async (text) => `echo:${text}` },
    complete: { complete: async (text) => `echo:${text}` },
};

function fakeStageSession(): StageSessionRuntime {
    let last = "";
    return {
        async prompt(text: string): Promise<string> {
            last = `echo:${text}`;
            return last;
        },
        async steer(): Promise<void> {},
        async followUp(): Promise<void> {},
        subscribe: () => () => {},
        sessionFile: undefined,
        sessionId: "session-id",
        async setModel(): Promise<void> {},
        setThinkingLevel(): void {},
        async cycleModel(): Promise<undefined> {
            return undefined;
        },
        cycleThinkingLevel(): undefined {
            return undefined;
        },
        agent: {} as StageSessionRuntime["agent"],
        model: undefined,
        thinkingLevel: "medium" as StageSessionRuntime["thinkingLevel"],
        messages: [],
        isStreaming: false,
        async navigateTree(): Promise<{ cancelled: boolean }> {
            return { cancelled: true };
        },
        async compact(): ReturnType<StageSessionRuntime["compact"]> {
            return undefined as unknown as Awaited<
                ReturnType<StageSessionRuntime["compact"]>
            >;
        },
        abortCompaction(): void {},
        async abort(): Promise<void> {},
        dispose(): void {},
        getLastAssistantText(): string | undefined {
            return last;
        },
    };
}

// ---------------------------------------------------------------------------
// dispatch: list
// ---------------------------------------------------------------------------

describe("WorkflowPersistencePort — runtime persistence forwarding", () => {
    function makePersistence() {
        const calls: Array<{ type: string; payload: Record<string, unknown> }> =
            [];
        const persistence: WorkflowPersistencePort = {
            appendEntry(
                type: string,
                payload: Record<string, unknown>,
            ): string {
                calls.push({ type, payload });
                return `entry-${calls.length}`;
            },
        };
        return { persistence, calls };
    }

    function lifecycleTypes(calls: Array<{ type: string }>): string[] {
        return calls.map((c) => c.type).filter((type) => type !== "workflow.durable.checkpoint");
    }

    const persistWorkflow = workflow({
      name: "persist-forwarding-test",
      description: "Tests persistence port forwarding through runtime",
      inputs: {},
      outputs: {
        done: Type.Optional(Type.Any()),
      },
      run: async (ctx) => {
            const stage = ctx.stage("persist-stage");
            await stage.prompt("hello");
            return { done: true };
        },
    }) as WorkflowDefinition;

    const noopAdaptersForPersist: StageAdapters = {
        prompt: { prompt: async () => "ok" },
    };

    test("appendEntry fires the full lifecycle for a background run", async () => {
        const { persistence, calls } = makePersistence();
        const activeStore = createStore();

        const runtime = createExtensionRuntime({
            definitions: [persistWorkflow],
            adapters: noopAdaptersForPersist,
            store: activeStore,
            persistence,
        });

        const result = await runtime.dispatch({
            workflow: "persist-forwarding-test",
            inputs: {},
            action: "run",
        });
        const accepted = asRun(result);
        assert.equal(accepted.status, "running");
        await waitForRunEnded(activeStore, accepted.runId);

        assert.deepEqual(
            lifecycleTypes(calls),
            [
                "workflow.run.start",
                "workflow.stage.start",
                "workflow.stage.end",
                "workflow.run.end",
            ],
        );
    });

    test("run.start payload contains runId and name", async () => {
        const { persistence, calls } = makePersistence();
        const activeStore = createStore();

        const runtime = createExtensionRuntime({
            definitions: [persistWorkflow],
            adapters: noopAdaptersForPersist,
            store: activeStore,
            persistence,
        });

        const result = await runtime.dispatch({
            workflow: "persist-forwarding-test",
            inputs: {},
            action: "run",
        });
        const accepted = asRun(result);
        await waitForRunEnded(activeStore, accepted.runId);

        const runStart = calls.find((c) => c.type === "workflow.run.start");
        assert.notEqual(runStart, undefined);
        assert.equal(runStart?.payload["runId"], accepted.runId);
        assert.equal(runStart?.payload["name"], "persist-forwarding-test");
        assert.equal(typeof runStart?.payload["ts"], "number");
    });

    test("omitting persistence — no appendEntry calls, run still completes", async () => {
        const activeStore = createStore();
        const runtime = createExtensionRuntime({
            definitions: [persistWorkflow],
            adapters: noopAdaptersForPersist,
            store: activeStore,
        });

        const result = await runtime.dispatch({
            workflow: "persist-forwarding-test",
            inputs: {},
            action: "run",
        });
        const accepted = asRun(result);
        await waitForRunEnded(activeStore, accepted.runId);
        const settled = activeStore.runs().find((r) => r.id === accepted.runId);
        assert.equal(settled?.status, "completed");
    });
});
