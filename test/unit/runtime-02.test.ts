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

    test("async direct invalid fallback models fail before background spawn", async () => {
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
                // Bare unresolvable id (no provider prefix) is still a hard config
                // error; provider-qualified ids are now trusted/passed through.
                model: "missing-model",
            },
        });

        assert.equal(result.status, "failed");
        assert.equal(result.error, WORKFLOW_UNKNOWN_MODEL_MESSAGE);
        assert.equal(activeStore.runs().length, 0);
    });

	test("foreground direct strict Cursor discovery failures and cancellation create no Run or stage session", async () => {
		for (const failure of [new Error("GetUsable failed"), new DOMException("cancelled", "AbortError")]) {
			const activeStore = createStore();
			let sessionCreates = 0;
			let promptCalls = 0;
			let discoveryCalls = 0;
			const runtime = createExtensionRuntime({
				store: activeStore,
				adapters: {
					agentSession: { async create() { sessionCreates += 1; return fakeStageSession(); } },
					prompt: { async prompt() { promptCalls += 1; return "unexpected"; } },
				},
				models: {
					async discoverModels() { discoveryCalls += 1; throw failure; },
					async listModels() { return [{ provider: "openai", id: "fallback", fullId: "openai/fallback" }]; },
					currentModel: "openai/fallback",
				},
			});

			const result = await runtime.runDirect({
				task: { name: "strict-cursor", task: "must not run", model: "cursor/missing-route", fallbackModels: ["openai/fallback"] },
			});
			assert.equal(result.status, "failed");
			assert.equal(result.runId?.length, 36);
			assert.match(result.error ?? "", /GetUsable failed|cancelled/u);
			assert.equal(discoveryCalls, 1);
			assert.equal(activeStore.runs().length, 0);
			assert.equal(sessionCreates, 0);
			assert.equal(promptCalls, 0);
		}
	});

	test("foreground direct accepts one byte-exact discovered Cursor route and bypasses discovery for non-Cursor", async () => {
		let discovered = false;
		let discoveryCalls = 0;
		let sessionCreates = 0;
		const runtime = createExtensionRuntime({
			adapters: {
				agentSession: { async create() { sessionCreates += 1; return fakeStageSession(); } },
			},
			models: {
				async discoverModels() { discoveryCalls += 1; discovered = true; },
				async listModels() {
					return [
						{
							provider: "cursor", id: "literal-route:high", fullId: "cursor/literal-route:high",
							model: {
								provider: "cursor", id: "literal-route:high", name: "literal-route:high", api: "cursor-agent",
								baseUrl: "https://api2.cursor.sh", reasoning: false, input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000,
								compat: { cursorRouting: { "literal-route:high": { modelId: "literal-route:high", maxMode: false, supportsImages: false, catalogOccurrence: 0 } } },
							},
						},
						{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
					];
				},
			},
		});
		const cursorResult = await runtime.runDirect({ task: { name: "cursor", task: "run exact", model: "cursor/literal-route:high" } });
		assert.equal(cursorResult.status, "completed");
		assert.equal(discovered, true);
		assert.equal(discoveryCalls > 0, true);
		assert.equal(sessionCreates, 1);
		const cursorDiscoveryCalls = discoveryCalls;

		const nonCursorResult = await runtime.runDirect({ task: { name: "openai", task: "run other", model: "openai/gpt-5-mini" } });
		assert.equal(nonCursorResult.status, "completed");
		assert.equal(discoveryCalls, cursorDiscoveryCalls, "non-Cursor direct execution must not start Cursor discovery");
		assert.equal(sessionCreates, 2);
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
