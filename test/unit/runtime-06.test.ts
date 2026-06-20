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
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
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

const helloWorkflow = defineWorkflow("hello-world")
    .description("Simple greeting")
    .input("name", Type.String())
    .output("greeting", Type.Optional(Type.Any()))
    .run(async (ctx) => {
        const stage = ctx.stage("greet");
        const out = await stage.prompt(`Hello ${String(ctx.inputs["name"])}`);
        return { greeting: out };
    })
    .compile() as WorkflowDefinition;

const schemaWorkflow = defineWorkflow("schema-test")
    .description("Multi-input schema")
    .input("text", Type.String({ default: "hi" }))
    .input("count", Type.Optional(Type.Number()))
    .input("flag", Type.Boolean())
    .output("ok", Type.Optional(Type.Any()))
    .run(async (_ctx) => ({ ok: true }))
    .compile() as WorkflowDefinition;

// ---------------------------------------------------------------------------
// dispatch: list
// ---------------------------------------------------------------------------

describe("createExtensionRuntime", () => {
    test("empty registry by default", () => {
        const runtime = createExtensionRuntime();
        assert.deepEqual(runtime.registry.names(), []);
    });

    test("seeds registry from definitions array", () => {
        const runtime = createExtensionRuntime({
            definitions: [helloWorkflow],
        });
        assert.ok(runtime.registry.names().includes("hello-world"));
    });

    test("accepts external registry", () => {
        const external = createRegistry([helloWorkflow, schemaWorkflow]);
        const runtime = createExtensionRuntime({ registry: external });
        assert.equal(runtime.registry.names().length, 2);
    });

    test("dispatch delegates to registry", async () => {
        const runtime = createExtensionRuntime({
            definitions: [helloWorkflow],
        });
        const result = await runtime.dispatch({
            workflow: "",
            inputs: {},
            action: "list",
        });
        const list = asList(result);
        assert.ok(list.items.some((i) => i.name === "hello-world"));
    });

    test("dispatch forwards resolved defaultSessionDir to named workflow stages", async () => {
        const dir = await mkdtemp(join(tmpdir(), "atomic-runtime-stage-session-dir-"));
        try {
            const activeStore = createStore();
            const received: CreateAgentSessionOptions[] = [];
            const runtime = createExtensionRuntime({
                definitions: [helloWorkflow],
                store: activeStore,
                resolveDefaultStageSessionDir: () => dir,
                adapters: {
                    agentSession: {
                        async create(options) {
                            received.push(options);
                            return fakeStageSession();
                        },
                    },
                },
            });

            const result = await runtime.dispatch(
                {
                    workflow: "hello-world",
                    inputs: { name: "Ada" },
                    action: "run",
                },
                { policy: NON_INTERACTIVE_WORKFLOW_POLICY },
            );

            const run = asRun(result);
            assert.equal(run.status, "completed");
            assert.equal(received[0]?.sessionManager?.getSessionDir(), dir);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
