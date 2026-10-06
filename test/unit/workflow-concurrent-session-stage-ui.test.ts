import { vi } from "vitest";
import {
	createAskUserQuestionToolDefinition,
	type QuestionnaireResult,
	type QuestionParams,
} from "../../packages/coding-agent/src/index.js";
import type { PiUISurface } from "../../packages/workflows/src/extension/ui-surface.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { bindWorkflowHumanInput } from "../../packages/workflows/src/extension/workflow-human-input.js";
import { READINESS_GATE_QUESTION_PARAMS } from "../../packages/workflows/src/runs/foreground/executor-hil.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { adoptStageUiBroker, type StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { assert, mockSession, run, test, waitForExecutorCustomPromptStage, workflow } from "./executor-shared.js";

/** Bound on a routed question reaching its host; a question sent to a sibling's broker never arrives. */
const ROUTED_INPUT_TIMEOUT_MS = 5_000;

const STAGE_QUESTION: QuestionParams = {
	questions: [
		{
			question: "Which path should this stage take?",
			header: "Path",
			options: [
				{ label: "left", description: "the left path" },
				{ label: "right", description: "the right path" },
			],
		},
	],
};
const READINESS_QUESTION = READINESS_GATE_QUESTION_PARAMS.questions[0]!.question;

interface HostedSession {
	readonly store: Store;
	readonly broker: StageUiBroker;
	readonly questions: string[];
	readonly unbind: () => void;
}

function hostSession(): HostedSession {
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope);
	const questions: string[] = [];
	const ui = {
		[Symbol.for("atomic-coding-agent/workflow-input@1")]: {
			active: () => true,
			available: () => true,
			bindingRevision: () => 0,
			subscribe: () => () => {},
			scope: () => ({
				ui: {},
				questionnaire: async (params: QuestionParams): Promise<QuestionnaireResult> => {
					const question = params.questions[0]!;
					questions.push(question.question);
					return {
						cancelled: false,
						answers: [
							{
								questionIndex: 0,
								question: question.question,
								kind: "option",
								answer: question.options[0]!.label,
							},
						],
					};
				},
			}),
		},
	} as PiUISurface;
	const unbind = bindWorkflowHumanInput(store, { hasUI: false, hasHumanInput: true, ui }, broker);
	return { store, broker, questions, unbind };
}

type StageEvent = { type: string; [key: string]: unknown };

/** A stage whose model turn calls the real `ask_user_question` tool through the stage UI binding. */
function askingSession(callTool: boolean): StageSessionRuntime {
	const listeners = new Set<(event: StageEvent) => void>();
	const emit = (event: StageEvent): void => {
		for (const listener of [...listeners]) listener(event);
	};
	const askTool = createAskUserQuestionToolDefinition();
	let uiContext: object | undefined;
	return Object.assign(mockSession(), {
		subscribe(listener: (event: StageEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async bindExtensions(bindings: { uiContext?: object }) {
			uiContext = bindings.uiContext;
		},
		async prompt() {
			emit({ type: "tool_execution_start", toolCallId: "ask", toolName: "ask_user_question", args: STAGE_QUESTION });
			const result = callTool
				? await askTool.execute("ask", STAGE_QUESTION, undefined, undefined, {
						hasUI: true,
						ui: uiContext,
						sessionManager: { getSessionId: () => "stage-session" },
					} as unknown as Parameters<typeof askTool.execute>[4])
				: { content: [], details: { answers: [], cancelled: false } };
			emit({ type: "tool_execution_end", toolCallId: "ask", toolName: "ask_user_question", result });
			emit({ type: "agent_end", messages: [] });
		},
	});
}

async function runInOwnSession(
	definition: WorkflowDefinition,
	options: { readonly callTool: boolean; readonly usePromptNodesForUi: boolean },
	answerOwnSession: (own: HostedSession) => Promise<void>,
): Promise<{ own: HostedSession; sibling: HostedSession; status: string | undefined }> {
	const own = hostSession();
	// The sibling adopts last, so process-global singletons now resolve to it.
	const sibling = hostSession();
	const controller = new AbortController();
	const result = run(
		definition,
		{},
		{
			store: own.store,
			stageUiBroker: own.broker,
			usePromptNodesForUi: options.usePromptNodesForUi,
			signal: controller.signal,
			adapters: buildRuntimeAdapters(
				{},
				{
					stageUiBroker: own.broker,
					createAgentSession: async () => ({ session: askingSession(options.callTool) }),
				},
			),
		},
	).then(
		(outcome) => outcome.status,
		() => undefined,
	);
	try {
		await answerOwnSession(own).catch(() => undefined);
		await vi
			.waitFor(() => assert.equal(own.store.runs()[0]?.status, "completed"), { timeout: ROUTED_INPUT_TIMEOUT_MS })
			.catch(() => undefined);
		controller.abort();
		return { own, sibling, status: await result };
	} finally {
		controller.abort();
		own.unbind();
		sibling.unbind();
	}
}

function askingWorkflow(): WorkflowDefinition {
	return workflow({
		name: "concurrent-session-ask",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("asker").prompt("ask the user");
			return {};
		},
	}) as WorkflowDefinition;
}

test("a stage's ask_user_question reaches its own session's host after a sibling session adopts (#3456)", async () => {
	const { own, sibling, status } = await runInOwnSession(
		askingWorkflow(),
		{ callTool: true, usePromptNodesForUi: false },
		async () => {},
	);
	assert.deepEqual(
		{ own: own.questions, sibling: sibling.questions, status },
		{ own: [STAGE_QUESTION.questions[0]!.question], sibling: [], status: "completed" },
	);
});

test("a stage's readiness question reaches its own session's host after a sibling session adopts (#3456)", async () => {
	const { own, sibling, status } = await runInOwnSession(
		askingWorkflow(),
		{ callTool: false, usePromptNodesForUi: true },
		async () => {},
	);
	assert.deepEqual(
		{ own: own.questions, sibling: sibling.questions, status },
		{ own: [READINESS_QUESTION], sibling: [], status: "completed" },
	);
});

test("a workflow's ctx.ui.custom prompt reaches its own session's broker after a sibling session adopts (#3456)", async () => {
	const definition = workflow({
		name: "concurrent-session-custom",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.ui.custom<string>(async (_tui, _theme, _keybindings, done) => ({
				render: () => ["pick"],
				handleInput: () => done("picked"),
				invalidate: () => {},
			}));
			return {};
		},
	}) as WorkflowDefinition;
	const shown: string[] = [];
	const { status } = await runInOwnSession(definition, { callTool: false, usePromptNodesForUi: true }, async (own) => {
		const { runId, stage } = await waitForExecutorCustomPromptStage(own.store, ROUTED_INPUT_TIMEOUT_MS);
		own.broker.registerHost(runId, stage.id, {
			showCustomUi: (request) => {
				shown.push(request.stageId);
				request.resolve("picked");
			},
		});
	});
	assert.deepEqual({ shown: shown.length, status }, { shown: 1, status: "completed" });
});
