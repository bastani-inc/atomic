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
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { defineWorkflow } from "../../packages/workflows/src/workflows/define-workflow.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
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
    .input("name", { type: "text", required: true })
    .run(async (ctx) => {
        const stage = ctx.stage("greet");
        const out = await stage.prompt(`Hello ${String(ctx.inputs["name"])}`);
        return { greeting: out };
    })
    .compile() as WorkflowDefinition;

const schemaWorkflow = defineWorkflow("schema-test")
    .description("Multi-input schema")
    .input("text", { type: "text", default: "hi" })
    .input("count", { type: "number", required: false })
    .input("flag", { type: "boolean", required: true })
    .run(async (_ctx) => ({ ok: true }))
    .compile() as WorkflowDefinition;

// ---------------------------------------------------------------------------
// dispatch: list
// ---------------------------------------------------------------------------

describe("dispatch — list", () => {
    test("returns empty items when registry is empty", async () => {
        const registry = createRegistry();
        const result = await dispatch(
            { workflow: "", inputs: {}, action: "list" },
            { registry },
        );
        const list = asList(result);
        assert.deepEqual(list.items, []);
    });

    test("returns one item per registered workflow with metadata", async () => {
        const registry = createRegistry([helloWorkflow, schemaWorkflow]);
        const result = await dispatch(
            { workflow: "", inputs: {}, action: "list" },
            { registry },
        );
        const list = asList(result);
        const names = list.items.map((i) => i.name);
        assert.ok(names.includes("hello-world"));
        assert.ok(names.includes("schema-test"));
        assert.equal(list.items.length, 2);
        // Items carry descriptions and input metadata.
        const hello = list.items.find((i) => i.name === "hello-world")!;
        assert.equal(typeof hello.description, "string");
        assert.ok(Array.isArray(hello.inputs));
    });
});

describe("runtime.runDirect — workflow intercom", () => {
    test("async direct parallel runs auto-deliver control and result events", async () => {
        const activeStore = createStore();
        const emitted: Array<{
            event: string;
            payload: Record<string, unknown>;
        }> = [];
        const runtime = createExtensionRuntime({
            store: activeStore,
            adapters: noopAdapters,
            intercom: {
                parentSession: "parent-session",
                emit(event, payload) {
                    emitted.push({ event, payload });
                },
            },
        });

        const accepted = await runtime.runDirect({
            async: true,
            tasks: [
                { name: "alpha", task: "inspect alpha" },
                { name: "beta", task: "inspect beta" },
            ],
        });

        assert.equal(accepted.status, "accepted");
        assert.equal(accepted.mode, "parallel");
        assert.deepEqual(accepted.intercom, {
            enabled: true,
            delivery: "control-and-result",
            parentSession: "parent-session",
        });
        assert.ok(accepted.runId);

        await waitForRunEnded(activeStore, accepted.runId);
        const deadline = Date.now() + 500;
        while (
            !emitted.some(
                (entry) => entry.event === "workflow:result-intercom",
            ) &&
            Date.now() < deadline
        ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        assert.ok(
            emitted.some(
                (entry) => entry.event === "workflow:control-intercom",
            ),
        );
        const result = emitted.find(
            (entry) => entry.event === "workflow:result-intercom",
        );
        assert.notEqual(result, undefined);
        assert.equal(result?.payload["runId"], accepted.runId);
        assert.equal(result?.payload["mode"], "parallel");
        assert.equal(result?.payload["status"], "completed");
        assert.equal(result?.payload["parentSession"], "parent-session");
        const details = result?.payload["details"] as
            | { results?: Array<{ name: string; text: string }> }
            | undefined;
        assert.deepEqual(
            details?.results?.map((item) => item.name),
            ["alpha", "beta"],
        );
    });

    test("async direct invalid fallback models fail before background acceptance", async () => {
        const activeStore = createStore();
        const runtime = createExtensionRuntime({
            store: activeStore,
            adapters: noopAdapters,
            models: {
                listModels: async () => [
                    {
                        provider: "openai",
                        id: "fallback",
                        fullId: "openai/fallback",
                    },
                ],
            },
        });

        const result = await runtime.runDirect({
            async: true,
            task: {
                name: "solo",
                task: "inspect solo",
                model: "missing/model",
            },
        });

        assert.equal(result.status, "failed");
        assert.match(result.error ?? "", /missing\/model \(not available\)/);
        assert.equal(activeStore.runs().length, 0);
    });

    test("non-interactive async direct single task awaits a terminal completed result", async () => {
        const activeStore = createStore();
        const seenModes: Array<string | undefined> = [];
        const runtime = createExtensionRuntime({
            store: activeStore,
            adapters: {
                prompt: {
                    async prompt(text, meta) {
                        seenModes.push(meta?.executionMode);
                        return `done:${text}`;
                    },
                },
            },
        });

        const result = await runtime.runDirect(
            {
                async: true,
                task: { name: "solo", task: "inspect solo" },
            },
            { policy: NON_INTERACTIVE_WORKFLOW_POLICY },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.mode, "single");
        assert.equal(result.progress?.completed, 1);
        assert.equal(result.progress?.total, 1);
        assert.equal(result.results?.[0]?.stageName, "solo");
        assert.deepEqual(seenModes, ["non_interactive"]);
        assert.ok(result.runId !== undefined);
        assert.equal(
            activeStore.runs().find((run) => run.id === result.runId)?.status,
            "completed",
        );
    });

    test("non-interactive async direct single task returns failed instead of accepted", async () => {
        const runtime = createExtensionRuntime({
            adapters: {
                prompt: {
                    async prompt() {
                        throw new Error("intentional direct failure");
                    },
                },
            },
        });

        const result = await runtime.runDirect(
            {
                async: true,
                task: { name: "solo", task: "inspect solo" },
            },
            { policy: NON_INTERACTIVE_WORKFLOW_POLICY },
        );

        assert.equal(result.status, "failed");
        assert.equal(result.mode, "single");
        assert.match(result.error ?? "", /intentional direct failure/);
    });

    test("non-interactive async direct parallel waits for every task", async () => {
        const prompts: string[] = [];
        const runtime = createExtensionRuntime({
            adapters: {
                prompt: {
                    async prompt(text) {
                        prompts.push(text);
                        await new Promise((resolve) =>
                            setTimeout(
                                resolve,
                                text.includes("alpha") ? 20 : 5,
                            ),
                        );
                        return `done:${text}`;
                    },
                },
            },
        });

        const result = await runtime.runDirect(
            {
                async: true,
                tasks: [
                    { name: "alpha", task: "inspect alpha" },
                    { name: "beta", task: "inspect beta" },
                ],
            },
            { policy: NON_INTERACTIVE_WORKFLOW_POLICY },
        );

        assert.equal(result.status, "completed");
        assert.equal(result.mode, "parallel");
        assert.equal(result.progress?.completed, 2);
        assert.equal(result.progress?.total, 2);
        assert.deepEqual(
            result.results?.map((item) => item.stageName),
            ["alpha", "beta"],
        );
        assert.deepEqual(
            new Set(prompts),
            new Set(["inspect alpha", "inspect beta"]),
        );
    });

    test("foreground direct single forwards top-level createAgentSession options", async () => {
        const calls: CreateAgentSessionOptions[] = [];
        const runtime = createExtensionRuntime({
            adapters: {
                agentSession: {
                    async create(options) {
                        calls.push(options);
                        return fakeStageSession();
                    },
                },
            },
        });

        const result = await runtime.runDirect({
            task: { name: "solo", task: "inspect solo" },
            cwd: "/repo",
            agentDir: "/agent",
            tools: ["read", "todo"],
            noTools: "builtin",
            thinkingLevel: "high",
        });

        assert.equal(result.status, "completed");
        assert.equal(calls[0]?.cwd, "/repo");
        assert.equal(calls[0]?.agentDir, "/agent");
        assert.deepEqual(calls[0]?.tools, ["read", "todo"]);
        assert.equal(calls[0]?.noTools, "builtin");
        assert.equal(calls[0]?.thinkingLevel, "high");
    });

    test("foreground direct single runs keep intercom off unless requested", async () => {
        const emitted: Array<{
            event: string;
            payload: Record<string, unknown>;
        }> = [];
        const runtime = createExtensionRuntime({
            adapters: noopAdapters,
            intercom: {
                emit(event, payload) {
                    emitted.push({ event, payload });
                },
            },
        });

        const result = await runtime.runDirect({
            task: { name: "solo", task: "inspect solo" },
        });

        assert.equal(result.status, "completed");
        assert.equal(result.intercom, undefined);
        assert.deepEqual(emitted, []);
    });
});

// ---------------------------------------------------------------------------
// dispatch: inputs
// ---------------------------------------------------------------------------

describe("dispatch — inputs", () => {
    test("returns not-found result (not throw) for unknown workflow", async () => {
        const registry = createRegistry();
        const result = await dispatch(
            { workflow: "no-such-workflow", inputs: {}, action: "inputs" },
            { registry },
        );
        const inp = asInputs(result);
        assert.deepEqual(inp.inputs, []);
        assert.ok(inp.error!.includes("no-such-workflow"));
    });

    test("returns schema entries for known workflow", async () => {
        const registry = createRegistry([schemaWorkflow]);
        const result = await dispatch(
            { workflow: "schema-test", inputs: {}, action: "inputs" },
            { registry },
        );
        const inp = asInputs(result);
        assert.equal(inp.error, undefined);
        const byName = Object.fromEntries(
            inp.inputs.map((i: WorkflowInputEntry) => [i.name, i]),
        );
        assert.equal(byName["text"]?.type, "text");
        assert.equal(byName["text"]?.default, "hi");
        assert.ok(!byName["count"]?.required);
        assert.equal(byName["flag"]?.required, true);
    });
});

// ---------------------------------------------------------------------------
// dispatch: run (always background)
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
        const failingWorkflow = defineWorkflow("fail-me")
            .run(async (_ctx) => {
                throw new Error("intentional failure");
            })
            .compile() as WorkflowDefinition;
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

// ---------------------------------------------------------------------------
// dispatch: unknown action throws
// ---------------------------------------------------------------------------

describe("dispatch — unknown action", () => {
    test("throws for unrecognised action", async () => {
        const registry = createRegistry();
        await assert.rejects(
            dispatch(
                { workflow: "", inputs: {}, action: "status" as "list" },
                { registry },
            ),
            { message: /unknown action/ },
        );
    });
});

// ---------------------------------------------------------------------------
// createExtensionRuntime
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
});

// ---------------------------------------------------------------------------
// renderResult — run variant
// ---------------------------------------------------------------------------

describe("renderResult — run variant", () => {
    test("running run renders a dispatch confirmation card", () => {
        const out = renderResult({
            action: "run",
            name: "hello-world",
            runId: "abc-123",
            status: "running",
            message:
                'Workflow "hello-world" started in background (runId: abc-123).',
            stages: [],
        });
        assert.ok(out.includes("abc-123"));
        assert.ok(out.includes("hello-world"));
        assert.ok(out.includes("● running"));
        assert.ok(out.includes("/workflow connect abc-123"));
    });

    test("failed run shows error", () => {
        const out = renderResult({
            action: "run",
            name: "hello-world",
            runId: "abc-123",
            status: "failed",
            error: "intentional failure",
            stages: [],
        });
        assert.ok(out.includes("failed"));
        assert.ok(out.includes("intentional failure"));
    });

    test("partial run shows in-progress", () => {
        const out = renderResult(
            {
                action: "run",
                name: "hello-world",
                runId: "abc-123",
                status: "running",
                stages: [],
            },
            { isPartial: true },
        );
        assert.ok(out.includes("in progress"));
    });

    test("missing or actionless result degrades gracefully instead of crashing", () => {
        // The tool-result renderer forwards `result.details`, which can be undefined
        // during streaming/partial renders or on error paths that return content
        // without a structured payload. renderResult must not dereference a missing
        // `action` (previously threw and crashed the TUI render loop).
        const missing = undefined as unknown as Parameters<
            typeof renderResult
        >[0];
        assert.doesNotThrow(() => renderResult(missing));
        assert.ok(renderResult(missing).includes("WORKFLOW"));
        // A partial render of a missing payload yields nothing rather than a notice.
        assert.equal(renderResult(missing, { isPartial: true }), "");
        // A non-object / actionless payload is handled by the same guard.
        const actionless = {} as unknown as Parameters<typeof renderResult>[0];
        assert.doesNotThrow(() => renderResult(actionless));
    });

    test("inputs not-found carries error field in result", async () => {
        const registry = createRegistry();
        const result = await dispatch(
            { workflow: "ghost", inputs: {}, action: "inputs" },
            { registry },
        );
        const inp = asInputs(result);
        assert.ok(inp.error!.includes("ghost"));
    });

    test("status list renders from RunSnapshot[]", () => {
        const out = renderResult({
            action: "status",
            snapshots: [
                {
                    id: "run-1-uuid",
                    name: "wf",
                    inputs: {},
                    status: "running",
                    stages: [],
                    startedAt: Date.now() - 1_000,
                },
            ],
        });
        assert.ok(out.includes("wf"));
        assert.match(out, /running/);
    });

    test("renderResult honours opts.now so scrollback entries don't tick on host re-renders", () => {
        const snapshot = {
            id: "run-1-uuid",
            name: "wf-tick-test",
            inputs: {},
            status: "running" as const,
            stages: [],
            startedAt: 0,
        };
        const first = renderResult(
            { action: "status", snapshots: [snapshot] },
            { now: 60_000, plain: true },
        );
        const second = renderResult(
            { action: "status", snapshots: [snapshot] },
            { now: 120_000, plain: true },
        );
        assert.notEqual(
            first,
            second,
            "sanity: differing opts.now must produce differing output (proves elapsed is sensitive to the param)",
        );
        const stableFirst = renderResult(
            { action: "status", snapshots: [snapshot] },
            { now: 60_000, plain: true },
        );
        const stableSecond = renderResult(
            { action: "status", snapshots: [snapshot] },
            { now: 60_000, plain: true },
        );
        assert.equal(
            stableFirst,
            stableSecond,
            "workflow tool result must be stable when opts.now is captured once per chat entry",
        );
    });
});

// ---------------------------------------------------------------------------
// WorkflowPersistencePort — forwarding through createExtensionRuntime → dispatch
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

    const persistWorkflow = defineWorkflow("persist-forwarding-test")
        .description("Tests persistence port forwarding through runtime")
        .run(async (ctx) => {
            const stage = ctx.stage("persist-stage");
            await stage.prompt("hello");
            return { done: true };
        })
        .compile() as WorkflowDefinition;

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
            calls.map((c) => c.type),
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
