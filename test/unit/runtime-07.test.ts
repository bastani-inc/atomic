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
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { renderResult } from "../../packages/workflows/src/extension/render-result.js";
import { WORKFLOW_UNKNOWN_MODEL_MESSAGE } from "../../packages/workflows/src/shared/workflow-failures.js";
import { NON_INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import type {
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
