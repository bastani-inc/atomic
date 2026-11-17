import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { installToolExecutionHooks } from "../../packages/workflows/src/tui/tool-execution-hooks.js";

function makeRun(id: string, name: string): RunSnapshot {
	return {
		id,
		name,
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: Date.now(),
	};
}

function makeStage(id: string, name: string): StageSnapshot {
	return {
		id,
		name,
		status: "running",
		parentIds: [],
		toolEvents: [],
	};
}

function makeMockPi(): {
	pi: {
		on: (event: string, handler: (payload: unknown) => void) => void;
		events: {
			on: (event: string, handler: (payload: unknown) => void) => void;
		};
	};
	eventHandlers: Map<string, (payload: unknown) => void>;
	extensionHandlers: Map<string, (payload: unknown) => void>;
} {
	const eventHandlers = new Map<string, (payload: unknown) => void>();
	const extensionHandlers = new Map<string, (payload: unknown) => void>();
	const pi = {
		on(event: string, handler: (payload: unknown) => void): void {
			extensionHandlers.set(event, handler);
		},
		events: {
			on(event: string, handler: (payload: unknown) => void): void {
				eventHandlers.set(event, handler);
			},
		},
	};
	return { pi, eventHandlers, extensionHandlers };
}

describe("installToolExecutionHooks", () => {
	let storeInstance: Store;

	beforeEach(() => {
		storeInstance = createStore();
		const run = makeRun("r1", "my-wf");
		storeInstance.recordRunStart(run);
		storeInstance.recordStageStart("r1", makeStage("s1", "scout"));
	});

	test("no crash when pi.events is absent", () => {
		const piNoEvents: { events?: undefined } = {};
		assert.doesNotThrow(() => installToolExecutionHooks(piNoEvents, storeInstance));
	});

	test("no crash when pi.events.on is absent", () => {
		const piNoOn = { events: {} };
		assert.doesNotThrow(() => installToolExecutionHooks(piNoOn, storeInstance));
	});

	test("subscribes to tool_execution_start, _update, _end", () => {
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);
		assert.equal(eventHandlers.has("tool_execution_start"), true);
		assert.equal(eventHandlers.has("tool_execution_update"), true);
		assert.equal(eventHandlers.has("tool_execution_end"), true);
	});

	test("subscribes to pi extension tool events", () => {
		const { pi, extensionHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);
		assert.equal(extensionHandlers.has("tool_execution_start"), true);
		assert.equal(extensionHandlers.has("tool_execution_update"), true);
		assert.equal(extensionHandlers.has("tool_execution_end"), true);
		assert.equal(extensionHandlers.has("tool_call"), true);
		assert.equal(extensionHandlers.has("tool_result"), true);
	});

	test("tool_execution_start ignores unscoped events instead of using active-stage fallback", () => {
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		const handler = eventHandlers.get("tool_execution_start")!;
		handler({ toolName: "bash", input: { cmd: "ls" }, ts: Date.now() });

		const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
		assert.equal(stage.toolEvents.length, 0);
		assert.equal(stage.status, "running");
		assert.equal(stage.awaitingInputSince, undefined);
	});

	test("tool_execution_start preserves SDK args for scoped orchestrator tool UI", () => {
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		const handler = eventHandlers.get("tool_execution_start")!;
		handler({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "bash-args",
			args: { command: "echo hi" },
			ts: Date.now(),
		});

		const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
		assert.deepEqual(stage.toolEvents[0]!.input, { command: "echo hi" });
	});

	test("tool_execution_start with explicit runId+stageId routes correctly", () => {
		storeInstance.recordStageStart("r1", makeStage("s2", "specialist"));

		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		const handler = eventHandlers.get("tool_execution_start")!;
		handler({
			toolName: "grep",
			runId: "r1",
			stageId: "s2",
			toolCallId: "grep-1",
			ts: Date.now(),
		});

		const snap = storeInstance.snapshot();
		const run = snap.runs.find((r) => r.id === "r1")!;
		const s2 = run.stages.find((s) => s.id === "s2")!;
		const s1 = run.stages.find((s) => s.id === "s1")!;
		assert.equal(s2.toolEvents.length, 1);
		assert.equal(s2.toolEvents[0]!.name, "grep");
		assert.equal(s1.toolEvents.length, 0);
	});

	test("tool_execution_update is attach-only and cannot create a stage tool event", () => {
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		eventHandlers.get("tool_execution_update")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "missing-call",
			ts: Date.now(),
		});

		const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
		assert.equal(stage.toolEvents.length, 0);
		assert.equal(stage.status, "running");
		assert.equal(stage.awaitingInputSince, undefined);
	});

	test("tool_execution_end records tool end for the exact scoped active call", () => {
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		const startTs = Date.now() - 500;
		const startHandler = eventHandlers.get("tool_execution_start")!;
		startHandler({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "bash-1",
			ts: startTs,
		});

		const endHandler = eventHandlers.get("tool_execution_end")!;
		endHandler({
			toolName: "renamed-in-end-payload",
			runId: "r1",
			stageId: "s1",
			toolCallId: "bash-1",
			ts: startTs + 123,
			endedAt: Date.now(),
			output: "ok",
		});

		const snap = storeInstance.snapshot();
		const run = snap.runs.find((r) => r.id === "r1")!;
		const stage = run.stages.find((s) => s.id === "s1")!;
		const evt = stage.toolEvents.find((e) => e.name === "bash");
		assert.notEqual(evt, undefined);
		assert.equal(evt!.startedAt, startTs);
		assert.equal(evt!.output, "ok");
		assert.notEqual(evt!.endedAt, undefined);
	});

	test("unscoped parent ask_user_question start/update is ignored across parallel stages", () => {
		storeInstance.recordStageStart("r1", makeStage("s2", "reviewer-b"));

		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		eventHandlers.get("tool_execution_start")!({
			toolName: "ask_user_question",
			toolCallId: "parent-ask",
			input: { questions: [{ question: "Parent prompt?" }] },
			ts: 123,
		});
		eventHandlers.get("tool_execution_update")!({
			toolName: "ask_user_question",
			toolCallId: "parent-ask",
			input: { questions: [{ question: "Parent prompt?" }] },
			ts: 124,
		});

		const run = storeInstance.snapshot().runs[0]!;
		for (const stage of run.stages) {
			assert.equal(stage.toolEvents.length, 0, `${stage.id} should not receive parent ask telemetry`);
			assert.equal(stage.status, "running", `${stage.id} should remain running`);
			assert.equal(stage.awaitingInputSince, undefined, `${stage.id} should not be awaiting input`);
		}
	});

	test("scoped ask_user_question records only own stage telemetry without awaiting input", () => {
		storeInstance.recordStageStart("r1", makeStage("s2", "reviewer-b"));

		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		eventHandlers.get("tool_execution_start")!({
			toolName: "ask_user_question",
			runId: "r1",
			stageId: "s2",
			toolCallId: "stage-ask",
			input: { questions: [{ question: "Stage prompt?" }] },
			ts: 123,
		});

		const run = storeInstance.snapshot().runs[0]!;
		const s1 = run.stages.find((s) => s.id === "s1")!;
		const s2 = run.stages.find((s) => s.id === "s2")!;
		assert.equal(s1.toolEvents.length, 0);
		assert.equal(s2.toolEvents.length, 1);
		assert.equal(s2.toolEvents[0]!.name, "ask_user_question");
		assert.equal(s1.status, "running");
		assert.equal(s2.status, "running");
		assert.equal(s1.awaitingInputSince, undefined);
		assert.equal(s2.awaitingInputSince, undefined);
	});

	test("duplicate start/update cannot migrate a scoped call to a sibling stage", () => {
		storeInstance.recordStageStart("r1", makeStage("s2", "reviewer-b"));

		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		eventHandlers.get("tool_execution_start")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "call-1",
			input: { cmd: "first" },
			ts: 100,
		});
		eventHandlers.get("tool_execution_start")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "call-1",
			input: { cmd: "duplicate" },
			ts: 101,
		});
		eventHandlers.get("tool_execution_update")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "call-1",
			input: { cmd: "attached-update" },
			ts: 102,
		});
		eventHandlers.get("tool_execution_update")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s2",
			toolCallId: "call-1",
			input: { cmd: "must-not-migrate" },
			ts: 103,
		});
		eventHandlers.get("tool_execution_update")!({
			toolName: "bash",
			toolCallId: "call-1",
			input: { cmd: "unscoped-duplicate" },
			ts: 104,
		});

		const run = storeInstance.snapshot().runs[0]!;
		const s1 = run.stages.find((s) => s.id === "s1")!;
		const s2 = run.stages.find((s) => s.id === "s2")!;
		assert.equal(s1.toolEvents.length, 1);
		assert.equal(s1.toolEvents[0]!.startedAt, 100);
		assert.deepEqual(s1.toolEvents[0]!.input, { cmd: "first" });
		assert.equal(s2.toolEvents.length, 0);
		assert.equal(s1.status, "running");
		assert.equal(s2.status, "running");
	});

	test("active tracking is pruned when a stage ends before late update/end events", () => {
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		eventHandlers.get("tool_execution_start")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "call-1",
			ts: 100,
		});
		storeInstance.recordStageEnd("r1", {
			...makeStage("s1", "scout"),
			status: "completed",
			endedAt: 200,
		});
		eventHandlers.get("tool_execution_update")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "call-1",
			ts: 201,
		});
		eventHandlers.get("tool_execution_end")!({
			toolName: "bash",
			runId: "r1",
			stageId: "s1",
			toolCallId: "call-1",
			endedAt: 202,
			output: "late",
		});

		const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
		assert.equal(stage.status, "completed");
		assert.equal(stage.toolEvents.length, 1);
		assert.equal(stage.toolEvents[0]!.endedAt, undefined);
		assert.equal(stage.toolEvents[0]!.output, undefined);
	});

	test("unscoped ask_user_question tool_call/tool_result extension events do not update awaiting input", () => {
		const { pi, extensionHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		extensionHandlers.get("tool_call")!({
			type: "tool_call",
			toolName: "ask_user_question",
			toolCallId: "ask-2",
			input: { questions: [] },
		});
		extensionHandlers.get("tool_result")!({
			type: "tool_result",
			toolName: "ask_user_question",
			toolCallId: "ask-2",
			input: { questions: [] },
			content: [],
			isError: false,
		});

		const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
		assert.equal(stage.status, "running");
		assert.equal(stage.awaitingInputSince, undefined);
		assert.equal(stage.toolEvents.length, 0);
	});

	test("unmatched main-chat ask_user_question result does not clear a workflow HIL prompt node", () => {
		storeInstance = createStore();
		storeInstance.recordRunStart(makeRun("r1", "my-wf"));
		storeInstance.recordStageStart("r1", makeStage("hil", "select"));
		assert.equal(
			storeInstance.recordStagePendingPrompt("r1", "hil", {
				id: "prompt-1",
				kind: "select",
				message: "workflow prompt",
				choices: ["one", "two"],
				createdAt: 123,
			}),
			true,
		);

		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		eventHandlers.get("tool_execution_end")!({
			toolName: "ask_user_question",
			toolCallId: "main-chat-ask",
			endedAt: 456,
			output: "hold open one",
		});

		const stage = storeInstance.snapshot().runs[0]!.stages[0]!;
		assert.equal(stage.status, "awaiting_input");
		assert.equal(stage.pendingPrompt?.id, "prompt-1");
		assert.equal(stage.awaitingInputSince, 123);
	});

	test("malformed payloads do not crash", () => {
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, storeInstance);

		const startHandler = eventHandlers.get("tool_execution_start")!;
		assert.doesNotThrow(() => startHandler(null));
		assert.doesNotThrow(() => startHandler(undefined));
		assert.doesNotThrow(() => startHandler(42));
		assert.doesNotThrow(() => startHandler({}));
	});

	test("no-op when no active run exists", () => {
		const emptyStore = createStore();
		const { pi, eventHandlers } = makeMockPi();
		installToolExecutionHooks(pi, emptyStore);

		const handler = eventHandlers.get("tool_execution_start")!;
		assert.doesNotThrow(() =>
			handler({
				toolName: "bash",
				runId: "missing-run",
				stageId: "missing-stage",
				toolCallId: "call-1",
				ts: Date.now(),
			}),
		);
		const snap = emptyStore.snapshot();
		assert.equal(snap.runs.length, 0);
	});
});
