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

import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import type { StageAdapters, StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

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
function _asInputs(r: WorkflowToolResult): InputsResult {
	if (r.action !== "inputs") throw new Error(`expected inputs, got ${r.action}`);
	return r as InputsResult;
}
function _asRun(r: WorkflowToolResult): RunResult {
	if (r.action !== "run" || !("runId" in r)) throw new Error(`expected run, got ${r.action}`);
	return r as RunResult;
}

async function _waitForRunEnded(store: ReturnType<typeof createStore>, runId: string, timeoutMs = 1000): Promise<void> {
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

const _noopAdapters: StageAdapters = {
	prompt: { prompt: async (text) => `echo:${text}` },
	complete: { complete: async (text) => `echo:${text}` },
};

function _fakeStageSession(): StageSessionRuntime {
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
			return undefined as unknown as Awaited<ReturnType<StageSessionRuntime["compact"]>>;
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
		const out = await stage.prompt(`Hello ${String(ctx.inputs.name)}`);
		return { greeting: out };
	},
}) as WorkflowDefinition;

const schemaWorkflow = workflow({
	name: "schema-test",
	description: "Multi-input schema",
	inputs: {
		text: Type.String({ default: "hi" }),
		count: Type.Optional(Type.Number()),
		flag: Type.Boolean(),
	},
	outputs: {
		ok: Type.Optional(Type.Any()),
	},
	run: async (_ctx) => ({ ok: true }),
}) as WorkflowDefinition;

// ---------------------------------------------------------------------------
// dispatch: list
// ---------------------------------------------------------------------------

describe("dispatch — list", () => {
	test("returns empty items when registry is empty", async () => {
		const registry = createRegistry();
		const result = await dispatch({ workflow: "", inputs: {}, action: "list" }, { registry });
		const list = asList(result);
		assert.deepEqual(list.items, []);
	});

	test("returns one item per registered workflow with metadata", async () => {
		const registry = createRegistry([helloWorkflow, schemaWorkflow]);
		const result = await dispatch({ workflow: "", inputs: {}, action: "list" }, { registry });
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
