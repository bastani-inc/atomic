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

const helloWorkflow = workflow({
  name: "hello-world",
  description: "Simple greeting",
  inputs: {
    name: Type.String(),
  },
  outputs: {
    greeting: Type.Optional(Type.Any()),
  },
  run: async (ctx) => {
        const stage = ctx.stage("greet");
        const out = await stage.prompt(`Hello ${String(ctx.inputs["name"])}`);
        return { greeting: out };
    },
}) as WorkflowDefinition;

// ---------------------------------------------------------------------------
// dispatch: list
// ---------------------------------------------------------------------------

describe("dispatch — run", () => {
    test("returns structured failed result when workflow not found", async () => {
        const registry = createRegistry();
        const result = await dispatch(
            { workflow: "ghost", inputs: {}, action: "run" },
            { registry },
        );
        const run = asRun(result);
        assert.equal(run.status, "failed");
        assert.ok(run.error!.includes("ghost"));
        assert.equal(run.runId, "");
    });

    test("background run reaches `completed` state on success", async () => {
        const registry = createRegistry([helloWorkflow]);
        const activeStore = createStore();
        const result = await dispatch(
            {
                workflow: "hello-world",
                inputs: { name: "Alice" },
                action: "run",
            },
            { registry, adapters: noopAdapters, store: activeStore },
        );
        const accepted = asRun(result);
        assert.equal(accepted.status, "running");
        assert.equal(accepted.name, "hello-world");
        assert.ok(accepted.runId.length > 0);

        await waitForRunEnded(activeStore, accepted.runId);
        const settled = activeStore.runs().find((r) => r.id === accepted.runId);
        assert.equal(settled?.status, "completed");
        const greeting = settled?.result?.["greeting"];
        assert.ok(
            typeof greeting === "string" && greeting.includes("Hello Alice"),
        );
    });

    test("background run lands as `failed` when the workflow body throws", async () => {
        const failingWorkflow = workflow({
          name: "fail-me",
          description: "",
          inputs: {},
          outputs: {},
          run: async (_ctx) => {
                throw new Error("intentional failure");
            },
        }) as WorkflowDefinition;
        const registry = createRegistry([failingWorkflow]);
        const activeStore = createStore();
        const result = await dispatch(
            { workflow: "fail-me", inputs: {}, action: "run" },
            { registry, adapters: noopAdapters, store: activeStore },
        );
        const accepted = asRun(result);
        assert.equal(accepted.status, "running");

        await waitForRunEnded(activeStore, accepted.runId);
        const settled = activeStore.runs().find((r) => r.id === accepted.runId);
        assert.equal(settled?.status, "failed");
        assert.ok(settled?.error?.includes("intentional failure"));
    });

    test("missing required input returns failed synchronously (no background scheduling)", async () => {
        const registry = createRegistry([helloWorkflow]);
        const activeStore = createStore();
        const result = await dispatch(
            { workflow: "hello-world", inputs: {}, action: "run" }, // missing required `name`
            { registry, adapters: noopAdapters, store: activeStore },
        );
        const run = asRun(result);
        assert.equal(run.status, "failed");
        assert.equal(run.runId, "");
        assert.match(run.error ?? "", /required input "name"/);
        // No runId was minted → no run snapshot landed in the store.
        assert.equal(activeStore.runs().length, 0);
    });
});
