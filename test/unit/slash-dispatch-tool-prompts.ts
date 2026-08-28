// @ts-nocheck
import { describe, test } from "vitest";
import { testRunId } from "../helpers/run-id.js";
import type { ExtensionRuntime } from "./slash-dispatch-utils.js";
import {
	assert,
	buildStagePromptAdapter,
	createExtensionRuntime,
	createRegistry,
	installSlashDispatchTestHooks,
	makeExecuteWorkflowTool,
	makeInflightRun,
	registerLiveStageHandle,
	stageUiBroker,
	store,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("tool run-control actions", () => {
	function makeToolHandler() {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		return makeExecuteWorkflowTool(runtime, () => undefined);
	}
	function seedPendingPrimitivePrompt(
		runId: string,
		kind: "input" | "confirm" | "select" | "editor",
		choices?: readonly string[],
	): void {
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-prompt-kind",
			name: "prompt",
			status: "awaiting_input",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStagePendingPrompt(runId, "stage-prompt-kind", {
			id: "prompt-kind",
			kind,
			message: "Prompt",
			...(choices === undefined ? {} : { choices }),
			createdAt: Date.now(),
		});
	}

	function _makeDispatchTrackingWorkflowHandler(): {
		handler: ReturnType<typeof makeExecuteWorkflowTool>;
		wasDispatched: () => boolean;
	} {
		let dispatched = false;
		const runtime = {
			dispatch: async () => {
				dispatched = true;
				return {
					action: "run",
					runId: "unexpected",
					status: "running",
					stages: [],
				};
			},
		} as unknown as ExtensionRuntime;

		return {
			handler: makeExecuteWorkflowTool(runtime, () => undefined),
			wasDispatched: () => dispatched,
		};
	}

	function _restoreWorkflowStageGuard(previousGuard: string | undefined): void {
		if (previousGuard === undefined) {
			delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
			return;
		}
		process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
	}

	function _assertWorkflowToolBlocked(result: WorkflowToolResult, wasDispatched: () => boolean): void {
		assert.equal(wasDispatched(), false);
		assert.match((result as { error?: string }).error ?? "", /workflows cannot invoke workflows/);
	}
	test.sequential("makeExecuteWorkflowTool answers stage pending prompts", async () => {
		const runId = testRunId(`stage-tool-answer-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-prompt-1",
			name: "ask",
			status: "awaiting_input",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStagePendingPrompt(runId, "stage-prompt-1", {
			id: "prompt-1",
			kind: "input",
			message: "Value?",
			createdAt: Date.now(),
		});
		const handler = makeToolHandler();

		const result = await handler({ action: "answer", runId, stageId: "ask", text: "42" }, {} as never);

		assert.equal(result.action, "answer");
		const send = result as {
			action: string;
			status: string;
			message: string;
		};
		assert.equal(send.status, "ok");
		assert.match(send.message, /Answered prompt/);
		const stage = store
			.runs()
			.find((run) => run.id === runId)
			?.stages.find((s) => s.id === "stage-prompt-1");
		assert.equal(stage?.pendingPrompt, undefined);
		assert.equal(store.getStagePromptAnswer(runId, "stage-prompt-1")?.answerSource, "workflow_tool");
	});
	test.sequential('makeExecuteWorkflowTool stores boolean true for the observed string "true" confirm answer', async () => {
		// Reproduces run 86dbfd4d-7123-4894-967c-7856227bc708: the retained assistant
		// tool call carried `response: "true"` (a JSON string), and the pre-fix sinks
		// turned it into `confirmed: false`.
		const runId = testRunId(`stage-tool-answer-string-true-${Date.now()}`);
		seedPendingPrimitivePrompt(runId, "confirm");
		const handler = makeToolHandler();
		const result = await handler(
			{ action: "answer", runId, stageId: "prompt", delivery: "answer", response: "true" },
			{} as never,
		);

		assert.equal((result as { status: string }).status, "ok");
		const stored = store.getStagePromptAnswer(runId, "stage-prompt-kind");
		assert.equal(stored?.value, true);
		assert.equal(typeof stored?.value, "boolean");
	});
	test.sequential("makeExecuteWorkflowTool coerces primitive prompt answers by kind", async () => {
		const cases = [
			{ kind: "confirm" as const, field: "text" as const, value: " YES ", expected: true },
			{ kind: "confirm" as const, field: "response" as const, value: true, expected: true },
			{ kind: "confirm" as const, field: "response" as const, value: "true", expected: true },
			{ kind: "confirm" as const, field: "text" as const, value: "no", expected: false },
			{ kind: "confirm" as const, field: "response" as const, value: false, expected: false },
			{
				kind: "input" as const,
				field: "text" as const,
				value: "  keep whitespace  ",
				expected: "  keep whitespace  ",
			},
			{
				kind: "input" as const,
				field: "message" as const,
				value: "  message route  ",
				expected: "  message route  ",
			},
			{
				kind: "editor" as const,
				field: "response" as const,
				value: "  edited verbatim  ",
				expected: "  edited verbatim  ",
			},
			{ kind: "select" as const, field: "text" as const, value: "  BLUE ", expected: "Blue" },
			{ kind: "select" as const, field: "response" as const, value: 2, expected: "Blue" },
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const runId = testRunId(`stage-tool-answer-coerce-${index}`);
			const choices = testCase.kind === "select" ? (["Red", "Blue"] as const) : undefined;
			seedPendingPrimitivePrompt(runId, testCase.kind, choices);
			const handler = makeToolHandler();
			const result = await handler(
				{
					action: "answer",
					runId,
					stageId: "prompt",
					[testCase.field]: testCase.value,
				},
				{} as never,
			);

			assert.equal(result.action, "answer");
			assert.equal((result as { status: string }).status, "ok", JSON.stringify(testCase));
			assert.equal(
				store.getStagePromptAnswer(runId, "stage-prompt-kind")?.value,
				testCase.expected,
				JSON.stringify(testCase),
			);
		}
	});

	test.sequential("makeExecuteWorkflowTool rejects unusable primitive answers without resolving the prompt", async () => {
		const cases = [
			{
				kind: "confirm" as const,
				value: "maybe",
				expectation: /boolean.*true\/false.*yes\/y.*no\/n/i,
			},
			{ kind: "input" as const, value: true, expectation: /text string in response, text, or message/i },
			{ kind: "editor" as const, value: null, expectation: /text string in response, text, or message/i },
			{
				kind: "select" as const,
				value: "not a choice",
				expectation: /choice label.*1-based numeric index/i,
			},
		] as const;

		for (const [index, testCase] of cases.entries()) {
			const runId = testRunId(`stage-tool-answer-invalid-${index}`);
			const choices = testCase.kind === "select" ? (["Red", "Blue"] as const) : undefined;
			seedPendingPrimitivePrompt(runId, testCase.kind, choices);
			const handler = makeToolHandler();
			const result = await handler(
				{
					action: "answer",
					runId,
					stageId: "prompt",
					response: testCase.value,
				},
				{} as never,
			);

			const send = result as { status: string; message: string };
			assert.equal(send.status, "noop", JSON.stringify(testCase));
			assert.match(send.message, testCase.expectation, JSON.stringify(testCase));
			if (testCase.kind === "select") assert.match(send.message, /Red.*Blue/);
			assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.pendingPrompt?.id, "prompt-kind");
			assert.equal(store.getStagePromptAnswer(runId, "stage-prompt-kind"), undefined);
		}
	});

	test.sequential("makeExecuteWorkflowTool refuses workflow answer for custom prompt nodes", async () => {
		const runId = testRunId(`stage-tool-answer-custom-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-custom-prompt",
			name: "custom",
			status: "awaiting_input",
			parentIds: [],
			toolEvents: [],
			awaitingInputSince: Date.now(),
			promptFootprint: {
				id: "custom-prompt-1",
				kind: "custom",
				message: "Custom widget",
				customIdentityHash: "hash",
				customIdentitySource: "caller",
				createdAt: Date.now(),
			},
		});
		const handler = makeToolHandler();

		const result = await handler(
			{
				action: "answer",
				runId,
				stageId: "custom",
				promptId: "custom-prompt-1",
				response: { value: "not-supported" },
			},
			{} as never,
		);

		assert.equal(result.action, "answer");
		const send = result as {
			action: string;
			status: string;
			message: string;
		};
		assert.equal(send.status, "noop");
		assert.match(send.message, /requires the interactive workflow graph/);
		assert.equal(store.getStagePromptAnswer(runId, "stage-custom-prompt"), undefined);
	});

	test.sequential("makeExecuteWorkflowTool tags brokered prompt answers as workflow-tool sourced", async () => {
		const runId = testRunId(`stage-tool-answer-broker-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-broker-prompt",
			name: "ask",
			status: "awaiting_input",
			parentIds: [],
			toolEvents: [],
		});
		const adapter = buildStagePromptAdapter(
			"ask-1",
			"ask_user_question",
			{
				questions: [
					{
						question: "What color?",
						options: [{ label: "Red" }, { label: "Blue" }],
					},
				],
			},
			1,
		)!;
		stageUiBroker.provideStagePrompt(runId, "stage-broker-prompt", adapter);
		const events: Array<{ answerSource?: string }> = [];
		const unsubscribe = stageUiBroker.onStagePromptResolved((event) => {
			if (event.runId === runId && event.stageId === "stage-broker-prompt") {
				events.push({ answerSource: event.answerSource });
			}
		});
		const pending = stageUiBroker.requestCustomUi(runId, "stage-broker-prompt", () => ({
			render: () => [],
			invalidate: () => {},
		}));
		const handler = makeToolHandler();

		try {
			const result = await handler({ action: "answer", runId, stageId: "ask", text: "Blue" }, {} as never);
			await pending;

			assert.equal(result.action, "answer");
			const send = result as {
				action: string;
				delivery: string;
				status: string;
				message: string;
			};
			assert.equal(send.status, "ok");
			assert.match(send.message, /Answered input request/);
			assert.equal(events[0]?.answerSource, "workflow_tool");
		} finally {
			unsubscribe();
		}
	});

	test.sequential("makeExecuteWorkflowTool leaves pending prompts untouched when payload is omitted", async () => {
		const runId = testRunId(`stage-tool-answer-omitted-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-prompt-omitted",
			name: "ask-omitted",
			status: "awaiting_input",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStagePendingPrompt(runId, "stage-prompt-omitted", {
			id: "prompt-omitted",
			kind: "input",
			message: "Value?",
			createdAt: Date.now(),
		});
		const handler = makeToolHandler();

		const result = await handler({ action: "answer", runId, stageId: "ask-omitted" }, {} as never);

		assert.equal(result.action, "answer");
		const send = result as {
			action: string;
			status: string;
			message: string;
		};
		assert.equal(send.status, "noop");
		assert.match(send.message, /requires text, response, or message/);
		const stage = store
			.runs()
			.find((run) => run.id === runId)
			?.stages.find((s) => s.id === "stage-prompt-omitted");
		assert.equal(stage?.pendingPrompt?.id, "prompt-omitted");
	});

	test.sequential("makeExecuteWorkflowTool delivery answer without a pending prompt does not fall through to live followUp", async () => {
		const runId = testRunId(`stage-tool-answer-answer-no-prompt-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-no-prompt",
			name: "ask",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		const { followUps, dispose } = registerLiveStageHandle(runId, "stage-no-prompt");
		const handler = makeToolHandler();

		try {
			const result = await handler(
				{
					action: "answer",
					runId,
					stageId: "ask",
					text: "42",
				},
				{} as never,
			);

			assert.equal(result.action, "answer");
			const send = result as {
				action: string;
				delivery: string;
				status: string;
				message: string;
			};
			assert.equal(send.status, "noop");
			assert.match(send.message, /No pending prompt/);
			assert.deepEqual(followUps, []);
		} finally {
			dispose();
		}
	});
	test.sequential("makeExecuteWorkflowTool rejects removed send without mutating workflow state", async () => {
		const handler = makeToolHandler();
		const before = store.graphSnapshot();

		await assert.rejects(
			handler(
				{ action: "send", runId: "missing", stageId: "review", text: "must not deliver" } as never,
				{} as never,
			),
			/unknown action "send"/,
		);
		assert.deepEqual(store.graphSnapshot(), before);
	});
});
