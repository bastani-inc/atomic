import { afterEach, describe, vi } from "vitest";
import {
	DecisionModelUnavailableError,
	DecisionTimeoutError,
} from "../../packages/coding-agent/src/core/decision/errors.js";
import type { DecisionResult } from "../../packages/coding-agent/src/core/decision/types.js";
import { READINESS_GATE_ADVANCE_LABEL } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	READINESS_DECISION_INSTRUCTIONS,
	READINESS_DECISION_QUESTIONS,
	type ReadinessDecisionQuestions,
} from "../../packages/workflows/src/runs/foreground/readiness-decision.js";
import type { WorkflowDecisionRequest } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { StageInputRequest, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowModelCatalogPort } from "../../packages/workflows/src/shared/types.js";
import {
	assert,
	createStageControlRegistry,
	mockSession,
	run,
	type StageSessionRuntime,
	sleep,
	stageUiBroker,
	test,
	workflow,
} from "./executor-shared.js";

const STEER = "Use the blue theme.";

interface PendingReadiness {
	readonly runId: string;
	readonly stage: StageSnapshot;
	readonly request: StageInputRequest;
}

async function waitForReadiness(previousPromptId?: string): Promise<PendingReadiness> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		for (const runSnapshot of store.runs()) {
			const stage = runSnapshot.stages.find(
				(candidate) =>
					candidate.inputRequest?.kind === "readiness_gate" && candidate.inputRequest.id !== previousPromptId,
			);
			if (stage?.inputRequest) return { runId: runSnapshot.id, stage, request: stage.inputRequest };
		}
		await sleep(5);
	}
	throw new Error("readiness question did not appear");
}

function readinessQuestionShown(): boolean {
	return store
		.runs()
		.some((runSnapshot) => runSnapshot.stages.some((stage) => stage.inputRequest?.kind === "readiness_gate"));
}

/** A stage that asks the user a question, which the user answers by typing `answer` into "Chat about this". */
function steeredSession(events: string[], answer: string): StageSessionRuntime {
	const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
	const emit = (event: { type: string; [key: string]: unknown }): void => {
		for (const listener of [...listeners]) listener(event);
	};
	let lastAssistantText = "";
	const messages: object[] = [];
	return {
		...mockSession(),
		async prompt(text: string) {
			messages.push({ role: "user", content: text });
			if (text === "Ask which theme to use, then apply it.") {
				emit({ type: "tool_execution_start", toolCallId: "ask", toolName: "ask_user_question" });
				emit({
					type: "tool_execution_end",
					toolCallId: "ask",
					toolName: "ask_user_question",
					result: {
						details: {
							answers: [{ questionIndex: 0, question: "Which theme?", kind: "chat", answer }],
							cancelled: false,
						},
					},
				});
				lastAssistantText = "Applied the blue theme.";
			} else {
				events.push(`user-turn:${text}`);
				lastAssistantText = `Handled: ${text}`;
			}
			messages.push({ role: "assistant", content: [{ type: "text", text: lastAssistantText }] });
			emit({ type: "agent_end", messages: [] });
		},
		subscribe(listener) {
			const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
			listeners.add(typed);
			return () => listeners.delete(typed);
		},
		get messages() {
			return messages as never;
		},
		getLastAssistantText() {
			return lastAssistantText;
		},
	};
}

function classified(advance: number, stay: number, addressed: number): DecisionResult<ReadinessDecisionQuestions> {
	return {
		answers: {
			next_action: {
				type: "choice",
				choice: advance >= stay ? "advance" : "stay",
				probabilities: { advance, stay },
				confidence: Math.max(advance, stay),
			},
			reply_addresses_message: { type: "bool", value: addressed >= 0.5, probability: addressed },
		},
		source: "classifier",
		model: "typesafe/jev-latest",
		responseModel: "jev-latest",
		usage: { inputTokens: 0, outputTokens: 0 },
	};
}

type Decide = (
	request: WorkflowDecisionRequest<ReadinessDecisionQuestions>,
) => Promise<DecisionResult<ReadinessDecisionQuestions>>;

function launch(input: { decide: Decide; enabled?: boolean | "unset"; answer?: string }) {
	const events: string[] = [];
	const registry = createStageControlRegistry();
	let sessions = 0;
	const decide = vi.fn(input.decide);
	const models = {
		listModels: async () => [],
		decide: decide as unknown as NonNullable<WorkflowModelCatalogPort["decide"]>,
		...(input.enabled === "unset" ? {} : { autoAdvanceAfterSteer: () => input.enabled !== false }),
	} satisfies WorkflowModelCatalogPort;
	const definition = workflow({
		name: "readiness-decision",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("theme").prompt("Ask which theme to use, then apply it.");
			await ctx.stage("next").prompt("Write the release note.");
			return {};
		},
	});
	const result = run(
		definition,
		{},
		{
			store,
			stageControlRegistry: registry,
			usePromptNodesForUi: true,
			models,
			adapters: {
				agentSession: {
					async create() {
						sessions += 1;
						if (sessions === 1) return steeredSession(events, input.answer ?? STEER);
						return {
							...mockSession(),
							async prompt() {
								events.push("next:completed");
							},
						};
					},
				},
			},
		},
	);
	return { result, decide, events, registry };
}

function themeStage(): StageSnapshot {
	const stage = store.runs()[0]?.stages.find((candidate) => candidate.name === "theme");
	assert.ok(stage);
	return stage;
}

describe("executor — readiness after a steer decided by the decision model (#4358)", () => {
	afterEach(() => store.clear());

	test("a confident advance completes the stage without the readiness question", async () => {
		store.clear();
		const { result, decide, events } = launch({ decide: async () => classified(0.93, 0.07, 0.91) });
		const outcome = await result;
		assert.equal(outcome.status, "completed");
		assert.equal(readinessQuestionShown(), false);
		assert.deepEqual(events, ["next:completed"]);
		assert.equal(decide.mock.calls.length, 1);
		const request = decide.mock.calls[0]![0];
		assert.deepEqual(request.state, {
			stage_objective: "Ask which theme to use, then apply it.",
			user_message: STEER,
			stage_reply: "Applied the blue theme.",
		});
		assert.equal(request.questions, READINESS_DECISION_QUESTIONS);
		assert.equal(request.instructions, READINESS_DECISION_INSTRUCTIONS);
		assert.equal(request.requireProbabilities, true);
		assert.ok(request.signal instanceof AbortSignal);
		const stage = themeStage();
		assert.equal(stage.status, "completed");
		assert.deepEqual(stage.readinessDecision, {
			outcome: "advanced",
			at: stage.readinessDecision!.at,
			model: "typesafe/jev-latest",
			probabilities: { advance: 0.93, stay: 0.07, addressed: 0.91 },
		});
		const notice = stage.notices?.find((candidate) => candidate.kind === "decision");
		assert.equal(notice?.to, "advanced");
		assert.equal(notice?.from, "typesafe/jev-latest");
		assert.equal(notice?.meta, "Decision model advanced the stage (p=0.93, addressed p=0.91)");
	});

	test("a confident stay keeps the stage open without asking; the next steer is decided again", async () => {
		store.clear();
		const answers = [classified(0.12, 0.88, 0.3), classified(0.9, 0.1, 0.95)];
		const { result, decide, events, registry } = launch({ decide: async () => answers.shift()! });
		const deadline = Date.now() + 2_000;
		while (decide.mock.calls.length < 1 && Date.now() < deadline) await sleep(5);
		await sleep(20);
		assert.equal(readinessQuestionShown(), false);
		const stage = themeStage();
		assert.equal(stage.status === "completed", false);
		assert.equal(stage.readinessDecision?.outcome, "stayed");
		const handle = registry.get(store.runs()[0]!.id, stage.id);
		assert.ok(handle);
		await handle.prompt("Also make the header bold.");
		const outcome = await result;
		assert.equal(outcome.status, "completed");
		assert.equal(readinessQuestionShown(), false);
		assert.deepEqual(events, ["user-turn:Also make the header bold.", "next:completed"]);
		assert.equal(decide.mock.calls.length, 2);
		assert.equal(decide.mock.calls[1]![0].state.user_message, "Also make the header bold.");
		assert.equal(decide.mock.calls[1]![0].state.stage_reply, "Handled: Also make the header bold.");
		assert.equal(themeStage().readinessDecision?.outcome, "advanced");
		assert.deepEqual(
			themeStage()
				.notices?.filter((notice) => notice.kind === "decision")
				.map((notice) => notice.to),
			["stayed", "advanced"],
		);
	});

	const fallbacks: ReadonlyArray<
		readonly [string, Decide, { readonly name: string; readonly code: string } | undefined, boolean]
	> = [
		["an unsettled decision", async () => classified(0.6, 0.4, 0.9), undefined, true],
		[
			"a confident advance whose reply leaves something open",
			async () => classified(0.95, 0.05, 0.4),
			undefined,
			true,
		],
		[
			"a decision model that times out",
			async () => {
				throw new DecisionTimeoutError({ timeoutMs: 10, elapsedMs: 10, phase: "classifier" });
			},
			{ name: "DecisionTimeoutError", code: "timeout" },
			false,
		],
		[
			"an unavailable decision model",
			async () => {
				throw new DecisionModelUnavailableError({ reason: "no-probabilities", model: "decision-test/chat" });
			},
			{ name: "DecisionModelUnavailableError", code: "model-unavailable" },
			false,
		],
		[
			"a decision model that errors",
			async () => {
				throw new TypeError("host failure");
			},
			{ name: "TypeError", code: "unknown" },
			false,
		],
	];

	for (const [label, decideImpl, error, hasProbabilities] of fallbacks) {
		test(`${label} falls back to the readiness question and records why`, async () => {
			store.clear();
			const { result, decide } = launch({ decide: decideImpl });
			const gate = await waitForReadiness();
			assert.equal(gate.request.questions[0]?.question, "Are you ready to move on to the next stage?");
			assert.equal(decide.mock.calls.length, 1);
			const recorded = themeStage().readinessDecision;
			assert.equal(recorded?.outcome, "asked");
			assert.deepEqual(recorded?.error, error);
			assert.equal(recorded?.probabilities !== undefined, hasProbabilities);
			assert.equal(
				stageUiBroker.answerStagePrompt(gate.runId, gate.stage.id, {
					optionLabels: [READINESS_GATE_ADVANCE_LABEL],
				}),
				true,
			);
			assert.equal((await result).status, "completed");
		});
	}

	test("a pause during the decision keeps the user's message and decides again after resume", async () => {
		store.clear();
		let calls = 0;
		const { result, decide, registry } = launch({
			decide: async (request) => {
				calls += 1;
				if (calls === 1) {
					await new Promise<void>((_resolve, reject) => {
						request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
					});
				}
				return classified(0.93, 0.07, 0.91);
			},
		});
		const deadline = Date.now() + 2_000;
		while (decide.mock.calls.length < 1 && Date.now() < deadline) await sleep(5);
		const handle = registry.get(store.runs()[0]!.id, themeStage().id);
		assert.ok(handle);
		await handle.pause();
		await sleep(20);
		assert.equal(themeStage().readinessDecision, undefined);
		await handle.resume();
		assert.equal((await result).status, "completed");
		assert.equal(readinessQuestionShown(), false);
		assert.equal(decide.mock.calls.length, 2);
		assert.equal(decide.mock.calls[1]![0].state.user_message, STEER);
		assert.equal(themeStage().readinessDecision?.outcome, "advanced");
		assert.deepEqual(
			themeStage()
				.notices?.filter((notice) => notice.kind === "decision")
				.map((notice) => notice.to),
			["advanced"],
		);
	});

	test("a host that does not report the setting keeps its default, on", async () => {
		store.clear();
		const { result, decide } = launch({ decide: async () => classified(0.93, 0.07, 0.91), enabled: "unset" });
		assert.equal((await result).status, "completed");
		assert.equal(decide.mock.calls.length, 1);
		assert.equal(readinessQuestionShown(), false);
	});

	test("with autoAdvanceAfterSteer off the readiness question is asked and the decision model is not", async () => {
		store.clear();
		const { result, decide } = launch({ decide: async () => classified(0.99, 0.01, 0.99), enabled: false });
		const gate = await waitForReadiness();
		assert.equal(decide.mock.calls.length, 0);
		assert.equal(themeStage().readinessDecision, undefined);
		assert.equal(
			stageUiBroker.answerStagePrompt(gate.runId, gate.stage.id, { optionLabels: [READINESS_GATE_ADVANCE_LABEL] }),
			true,
		);
		assert.equal((await result).status, "completed");
	});

	test("without a steer to judge, the readiness question is asked as before", async () => {
		store.clear();
		const { result, decide } = launch({
			decide: async () => classified(0.99, 0.01, 0.99),
			answer: "Chat about this",
		});
		const gate = await waitForReadiness();
		assert.equal(decide.mock.calls.length, 0);
		assert.equal(
			stageUiBroker.answerStagePrompt(gate.runId, gate.stage.id, { text: "Make it green instead." }),
			true,
		);
		const outcome = await result;
		assert.equal(outcome.status, "completed");
		assert.equal(decide.mock.calls.length, 1);
		assert.equal(decide.mock.calls[0]![0].state.user_message, "Make it green instead.");
	});
});
