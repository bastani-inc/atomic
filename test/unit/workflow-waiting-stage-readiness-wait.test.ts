import type { SessionManager } from "@bastani/atomic";
import { afterEach, describe, vi } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { READINESS_GATE_ADVANCE_LABEL } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { store as defaultStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	assert,
	mockSession,
	run,
	type StageSessionRuntime,
	stageUiBroker,
	test,
	workflow,
} from "./executor-shared.js";

/** Long enough that the stage's own prompt finishes well inside it, even on a loaded machine. */
const IDLE_THRESHOLD_MS = 150;

interface Sessions {
	created: number;
	disposed: number;
}

/** Stage sessions whose first turn asks the user a question, so the stage asks whether it is ready to advance. */
function askingAdapters(sessions: Sessions, options: { readonly disposeFails?: Error } = {}) {
	return {
		sessionStore: new MemorySessionStore(),
		agentSession: {
			async create(createOptions: { readonly sessionManager?: unknown }) {
				sessions.created += 1;
				const manager = createOptions.sessionManager as SessionManager;
				const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
				const session: StageSessionRuntime = {
					...mockSession(manager),
					async prompt(text: string) {
						await manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
						for (const listener of [...listeners]) {
							listener({ type: "tool_execution_start", toolCallId: "ask", toolName: "ask_user_question" });
							listener({
								type: "tool_execution_end",
								toolCallId: "ask",
								toolName: "ask_user_question",
								result: { details: { answers: [{ questionIndex: 0, answer: "yes" }], cancelled: false } },
							});
						}
					},
					subscribe(listener) {
						const typed = listener as (event: { type: string; [key: string]: unknown }) => void;
						listeners.add(typed);
						return () => listeners.delete(typed);
					},
					async dispose() {
						sessions.disposed += 1;
						if (options.disposeFails !== undefined && sessions.disposed === 1) throw options.disposeFails;
					},
				};
				return session;
			},
		},
	};
}

function interview() {
	return workflow({
		name: "readiness-wait",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("interview").prompt("ask the user");
			return {};
		},
	});
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition never held");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function interviewStage(): StageSnapshot {
	const stage = defaultStore.runs()[0]?.stages.find((candidate) => candidate.name === "interview");
	assert.ok(stage !== undefined);
	return stage;
}

function answer(): boolean {
	const stage = interviewStage();
	return stageUiBroker.answerStagePrompt(defaultStore.runs()[0]!.id, stage.id, {
		optionLabels: [READINESS_GATE_ADVANCE_LABEL],
	});
}

describe("a readiness question that waits while the stage may release its session (#4309)", () => {
	afterEach(() => {
		defaultStore.clear();
		vi.restoreAllMocks();
	});

	test("a stage that never releases keeps its session through the question and the answer (#4309)", async () => {
		defaultStore.clear();
		const sessions: Sessions = { created: 0, disposed: 0 };
		const events: StageLifecycleEvent[] = [];
		const execution = run(
			interview(),
			{},
			{
				store: defaultStore,
				usePromptNodesForUi: true,
				releaseWhenWaiting: false,
				adapters: askingAdapters(sessions),
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);
		await until(() => defaultStore.runs()[0]?.stages.some((stage) => stage.status === "awaiting_input") === true);
		await new Promise((resolve) => setTimeout(resolve, IDLE_THRESHOLD_MS * 2));
		assert.equal(interviewStage().wait, undefined);
		assert.equal(answer(), true);
		const result = await execution;

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(events, []);
		assert.equal(sessions.created, 1);
	});

	test("a question answered before the threshold leaves the session where it was, and a stage the workflow then holds idle is released by the run's scan (#4309)", async () => {
		defaultStore.clear();
		const sessions: Sessions = { created: 0, disposed: 0 };
		const events: StageLifecycleEvent[] = [];
		const definition = workflow({
			name: "readiness-then-idle",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("interview").prompt("ask the user");
				await new Promise((resolve) => setTimeout(resolve, IDLE_THRESHOLD_MS * 6));
				return {};
			},
		});
		const execution = run(
			definition,
			{},
			{
				store: defaultStore,
				usePromptNodesForUi: true,
				releaseWhenWaiting: { afterMs: IDLE_THRESHOLD_MS },
				adapters: askingAdapters(sessions),
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);
		await until(() => defaultStore.runs()[0]?.stages.some((stage) => stage.status === "awaiting_input") === true);
		assert.equal(answer(), true);
		const result = await execution;

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			events.map((event) => [event.type, event.wait.kind]),
			[["stage_waiting", "idle"]],
		);
		assert.equal(sessions.created, 1);
		assert.equal(sessions.disposed, 1);
	});

	test("a run ended while the question waits released does not reopen the session for an answer that will not come (#4309)", async () => {
		defaultStore.clear();
		const sessions: Sessions = { created: 0, disposed: 0 };
		const events: StageLifecycleEvent[] = [];
		const controller = new AbortController();
		const execution = run(
			interview(),
			{},
			{
				store: defaultStore,
				usePromptNodesForUi: true,
				releaseWhenWaiting: { afterMs: 0 },
				signal: controller.signal,
				adapters: askingAdapters(sessions),
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);
		await until(() => events.some((event) => event.type === "stage_waiting"));
		controller.abort(new Error("run killed"));
		const result = await execution;

		assert.equal(result.status, "killed");
		assert.deepEqual(
			events.map((event) => event.type),
			["stage_waiting"],
		);
		assert.equal(sessions.created, 1);
	});

	test("a session that fails to close is still counted as released: the stage reopens for the answer, and the failure is reported once (#4309)", async () => {
		defaultStore.clear();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const sessions: Sessions = { created: 0, disposed: 0 };
		const events: StageLifecycleEvent[] = [];
		const failure = new Error("session would not close");
		const execution = run(
			interview(),
			{},
			{
				store: defaultStore,
				usePromptNodesForUi: true,
				releaseWhenWaiting: { afterMs: 0 },
				adapters: askingAdapters(sessions, { disposeFails: failure }),
				onStageLifecycleEvent: (_runId, event) => events.push(event),
			},
		);
		const reportedFailures = () =>
			warn.mock.calls.filter((call) => String(call[0]).includes("could not release idle stage"));
		await until(() => reportedFailures().length > 0);
		assert.equal(answer(), true);
		const result = await execution;

		assert.equal(result.status, "completed", result.error);
		// The close failed before the wait began, so no wait was announced; the session was gone, and the answer reopened it.
		assert.deepEqual(
			events.map((event) => [event.type, event.wait.kind]),
			[["stage_rehydrated", "prompt"]],
		);
		assert.equal(sessions.created, 2);
		assert.equal(reportedFailures().length, 1);
		assert.equal(reportedFailures()[0]?.[1], failure);
	});
});
