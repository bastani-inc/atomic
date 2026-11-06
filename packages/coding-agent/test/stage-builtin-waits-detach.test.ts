/**
 * A workflow stage releases its session while its model waits in a built-in tool (#4374): a shell `wait` without a
 * budget on the stage's own task host, and an `ask_user_question` whose answer comes from the stage's UI. Both detach
 * only in a stage's own session; after a restart they start again with their call ids, a wait on a task that died
 * returns a typed result, and every result is recorded once.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import type { DetachedToolResult } from "../src/core/agent-session-detached-tools.js";
import type {
	ExtensionFactory,
	ExtensionUIContext,
	ToolDefinition,
	WorkflowStageOrchestrationContext,
} from "../src/core/extensions/index.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { QuestionnaireResult, QuestionParams } from "../src/core/tools/ask-user-question/tool/types.js";
import { parkWorkflowStageForRelease } from "../src/index.js";
import { waitTool } from "./helpers/detached-tools.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
const contexts: WorkflowStageOrchestrationContext[] = [];
const gateDirectories: string[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (contexts.length > 0) await contexts.pop()?.messageAdmission?.boundary.close();
	while (gateDirectories.length > 0) rmSync(gateDirectories.pop()!, { recursive: true, force: true });
});

function stageContext(): WorkflowStageOrchestrationContext {
	const context: WorkflowStageOrchestrationContext = {
		kind: "workflow-stage",
		workflowRunId: crypto.randomUUID(),
		workflowStageId: "stage-a",
		workflowStageName: "Stage A",
		constraints: { disableWorkflowTool: true },
	};
	contexts.push(context);
	return context;
}

async function session(
	options: {
		readonly context?: WorkflowStageOrchestrationContext;
		readonly store: MemorySessionStore;
		readonly customTools?: ToolDefinition[];
		readonly extensionFactories?: ExtensionFactory[];
	},
	sessionId?: string,
): Promise<Harness> {
	const manager =
		sessionId === undefined
			? await SessionManager.create(options.store, process.cwd())
			: await SessionManager.open(options.store, sessionId);
	const harness = await createHarness({
		sessionManager: manager,
		initialActiveToolNames: ["bash", "ask_user_question", ...(options.customTools ?? []).map((tool) => tool.name)],
		...(options.context === undefined ? {} : { orchestrationContext: options.context }),
		...(options.customTools === undefined ? {} : { customTools: options.customTools }),
		...(options.extensionFactories === undefined ? {} : { extensionFactories: options.extensionFactories }),
	});
	harnesses.push(harness);
	return harness;
}

function gate(): { readonly path: string; open(): void } {
	const directory = mkdtempSync(join(tmpdir(), "atomic-stage-wait-gate-"));
	gateDirectories.push(directory);
	const path = join(directory, "open").replaceAll("\\", "/");
	return { path, open: () => writeFileSync(path, "") };
}

/** Start a background command on the session's task host that prints `text` once the gate opens. */
async function launchGated(harness: Harness, text: string): Promise<{ readonly taskId: string; open(): void }> {
	const opened = gate();
	const shell = harness.session.agent.state.tools.find((tool) => tool.name === "bash");
	assert.ok(shell);
	const launched = await shell.execute("launch", {
		command: `while [ ! -e '${opened.path}' ]; do sleep 0.02; done; echo ${text}`,
		wait: { kind: "background" },
		timeout: 30,
	});
	const taskId = (launched.details as { readonly observation: { readonly taskId: string } }).observation.taskId;
	return { taskId, open: opened.open };
}

const waitTurn = (taskId: string, id: string, extra: Record<string, unknown> = {}) =>
	fauxAssistantMessage([fauxToolCall("bash", { action: "wait", id: taskId, ...extra }, { id })], {
		stopReason: "toolUse",
	});

const QUESTION: QuestionParams = {
	questions: [
		{
			question: "Which database should the service use?",
			header: "Database",
			options: [
				{ label: "Postgres", description: "Relational" },
				{ label: "SQLite", description: "Embedded" },
			],
		},
	],
};

const askTurn = (id: string) =>
	fauxAssistantMessage([fauxToolCall("ask_user_question", QUESTION, { id })], { stopReason: "toolUse" });

function answer(label: string): QuestionnaireResult {
	return {
		answers: [{ questionIndex: 0, question: QUESTION.questions[0]!.question, kind: "option", answer: label }],
		cancelled: false,
	};
}

/** A UI whose questionnaire waits for the test to answer each request: the main chat's kind of host. */
function questionnaireUi(): {
	readonly ui: ExtensionUIContext;
	readonly asked: QuestionParams[];
	answer(index: number, result: QuestionnaireResult): void;
} {
	const asked: QuestionParams[] = [];
	const pending: PromiseWithResolvers<QuestionnaireResult>[] = [];
	return {
		asked,
		answer: (index, result) => pending[index]?.resolve(result),
		ui: {
			...noOpUIContext,
			hostQuestionnaire: (params) => {
				asked.push(params);
				const answered = Promise.withResolvers<QuestionnaireResult>();
				pending.push(answered);
				return answered.promise;
			},
		},
	};
}

/**
 * A stage's kind of UI: the stage owns the question, which waits in its UI broker for as long as the stage lives, not
 * the session that asked it. `askedBy` lists the session each request came from.
 */
function stageUi(): {
	readonly ui: ExtensionUIContext;
	readonly askedBy: string[];
	answer(index: number, result: QuestionnaireResult): void;
} {
	const askedBy: string[] = [];
	const owners: string[] = [];
	const pending: PromiseWithResolvers<QuestionnaireResult>[] = [];
	const ui = {
		...noOpUIContext,
		[Symbol.for("atomic-coding-agent/stage-questionnaire@1")]: (sessionId: string) => {
			owners.push(sessionId);
			return ui;
		},
		custom: <T>(_factory: unknown, options?: { readonly signal?: AbortSignal }): Promise<T> => {
			askedBy.push(owners.at(-1) ?? "");
			const answered = Promise.withResolvers<QuestionnaireResult>();
			pending.push(answered);
			options?.signal?.addEventListener("abort", () => answered.reject(options.signal?.reason), { once: true });
			return answered.promise as Promise<T>;
		},
	} as ExtensionUIContext;
	return { ui, askedBy, answer: (index, result) => pending[index]?.resolve(result) };
}

function toolResults(harness: Harness): { readonly id: string; readonly text: string; readonly isError: boolean }[] {
	return harness.sessionManager
		.buildSessionProjection()
		.messages.flatMap((message) =>
			message.role === "toolResult"
				? [{ id: message.toolCallId, text: getMessageText(message), isError: message.isError }]
				: [],
		);
}

describe("a stage's shell wait (#4374)", () => {
	test("detaches without a budget and runs inline with one (#4374)", async () => {
		const stage = await session({ context: stageContext(), store: new MemorySessionStore() });
		stage.session.setToolDetachment({ afterMs: 0 });
		const task = await launchGated(stage, "stage-done");

		stage.setResponses([waitTurn(task.taskId, "budgeted", { budgetMs: 0 }), fauxAssistantMessage("again")]);
		await stage.session.prompt("peek at the build");
		const budgeted = stage.session.takeDetachedToolCalls();
		stage.setResponses([waitTurn(task.taskId, "w-1")]);
		await stage.session.prompt("wait for the build");
		const unbudgeted = stage.session.takeDetachedToolCalls();

		assert.deepEqual([budgeted.length, unbudgeted.map((call) => call.toolCallId)], [0, ["w-1"]]);
		assert.deepEqual(
			toolResults(stage).map((result) => result.id),
			["budgeted"],
		);
		task.open();
		await unbudgeted[0]?.result;
	});

	test("goes on after the stage releases its session, and its result is recorded once when the task exits (#4374)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const first = await session({ context, store });
		first.session.setToolDetachment({ afterMs: 0 });
		const task = await launchGated(first, "tests passed");
		first.setResponses([waitTurn(task.taskId, "w-1")]);
		await first.session.prompt("wait for the tests");
		const [detached] = first.session.takeDetachedToolCalls();
		assert.equal(detached?.toolCallId, "w-1");
		const sessionId = first.sessionManager.getSessionId();
		parkWorkflowStageForRelease(context);
		await first.session.dispose();

		task.open();
		const result = await detached.result;
		const reopened = await session({ context, store }, sessionId);
		reopened.setResponses([fauxAssistantMessage("the tests pass")]);
		await reopened.session.resumeDetachedTurn([result]);
		await reopened.session.resumeDetachedTurn([result]);

		assert.equal(result.isError, false);
		assert.equal((result.result.details as { readonly exitCode?: number }).exitCode, 0);
		const results = toolResults(reopened);
		assert.deepEqual(
			results.map((recorded) => recorded.id),
			["w-1"],
		);
		assert.match(results[0]!.text, /tests passed/);
		assert.equal(reopened.getPendingResponseCount(), 0, "the turn continued once");
	});

	test("starts again after a restart, and a wait on a task that died returns a typed TaskToolError result (#4374)", async () => {
		const store = new MemorySessionStore();
		const crashed = await SessionManager.create(store, process.cwd());
		await crashed.appendMessage({ role: "user", content: "wait for the build", timestamp: Date.now() });
		await crashed.appendMessage(waitTurn("task-of-a-dead-process", "w-1"));
		const restarted = await session({ context: stageContext(), store }, crashed.getSessionId());
		restarted.setResponses([fauxAssistantMessage("the build is gone; starting it again")]);

		assert.equal(restarted.session.hasPendingDetachedTurn(), true);
		const [again] = restarted.session.redispatchDetachedToolCalls();
		assert.equal(again?.toolCallId, "w-1");
		const result = await again.result;
		await restarted.session.resumeDetachedTurn([result]);

		assert.equal(result.isError, true);
		assert.deepEqual(result.result.details, {
			error: {
				name: "TaskToolError",
				code: "UnknownTask",
				message: (result.result.content[0] as { readonly text: string }).text,
				taskId: "task-of-a-dead-process",
			},
		});
		assert.deepEqual(
			toolResults(restarted).map((recorded) => [recorded.id, recorded.isError]),
			[["w-1", true]],
		);
	});

	test("a transcript that ends on a shell launch or a budgeted wait is not started again (#4374)", async () => {
		for (const call of [
			fauxToolCall("bash", { command: "make test" }, { id: "launch-1" }),
			fauxToolCall("bash", { action: "wait", id: "t-1", budgetMs: 1_000 }, { id: "peek-1" }),
		]) {
			const store = new MemorySessionStore();
			const crashed = await SessionManager.create(store, process.cwd());
			await crashed.appendMessage({ role: "user", content: "build", timestamp: Date.now() });
			await crashed.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
			const restarted = await session({ context: stageContext(), store }, crashed.getSessionId());
			const context = [...restarted.session.agent.state.messages];

			assert.equal(restarted.session.hasPendingDetachedTurn(), false, call.id);
			assert.deepEqual(restarted.session.redispatchDetachedToolCalls(), [], call.id);
			assert.deepEqual(restarted.session.agent.state.messages, context, `${call.id}: the context is left as it was`);
		}
	});

	test("a session with no detachable tool has no pending detached turn, whatever its transcript ends on (#4374)", async () => {
		const store = new MemorySessionStore();
		const crashed = await SessionManager.create(store, process.cwd());
		await crashed.appendMessage({ role: "user", content: "look", timestamp: Date.now() });
		await crashed.appendMessage(
			fauxAssistantMessage([fauxToolCall("look", {}, { id: "look-1" })], { stopReason: "toolUse" }),
		);
		const harness = await createHarness({
			sessionManager: await SessionManager.open(store, crashed.getSessionId()),
			tools: [
				{
					name: "look",
					label: "Look",
					description: "Looks around",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "nothing" }], details: undefined }),
				},
			],
		});
		harnesses.push(harness);

		assert.equal(harness.session.hasPendingDetachedTurn(), false);
		assert.deepEqual(harness.session.redispatchDetachedToolCalls(), []);
	});

	test("extensions hear calls started again in order, each after the session's earlier events (#4374)", async () => {
		const store = new MemorySessionStore();
		const crashed = await SessionManager.create(store, process.cwd());
		await crashed.appendMessage({ role: "user", content: "wait for both", timestamp: Date.now() });
		await crashed.appendMessage(
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { action: "wait", id: "gone-1" }, { id: "w-1" }),
					fauxToolCall("bash", { action: "wait", id: "gone-2" }, { id: "w-2" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		const firstHeard = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const heard: string[] = [];
		const restarted = await session(
			{
				context: stageContext(),
				store,
				extensionFactories: [
					(pi) => {
						pi.on("tool_execution_start", async (event) => {
							if (event.toolCallId === "w-1") {
								firstHeard.resolve();
								await releaseFirst.promise;
							}
							heard.push(event.toolCallId);
						});
					},
				],
			},
			crashed.getSessionId(),
		);

		const calls = restarted.session.redispatchDetachedToolCalls();
		await firstHeard.promise;
		await new Promise((resolve) => setImmediate(resolve));
		const beforeTheFirstFinished = [...heard];
		releaseFirst.resolve();
		await vi.waitFor(() => assert.equal(heard.length, 2));
		await Promise.all(calls.map((call) => call.result));

		assert.deepEqual(beforeTheFirstFinished, []);
		assert.deepEqual(heard, ["w-1", "w-2"]);
	});
});

describe("a stage's ask_user_question (#4374)", () => {
	test("detaches only in a stage's own session (#4374)", async () => {
		const stage = await session({ context: stageContext(), store: new MemorySessionStore() });
		const chat = await session({ store: new MemorySessionStore() });
		const inStage = stageUi();
		const inChat = questionnaireUi();
		await stage.session.bindExtensions({ uiContext: inStage.ui, mode: "tui" });
		await chat.session.bindExtensions({ uiContext: inChat.ui, mode: "tui" });
		for (const harness of [stage, chat]) harness.session.setToolDetachment({ afterMs: 0 });

		stage.setResponses([askTurn("q-stage")]);
		await stage.session.prompt("pick a database");
		chat.setResponses([askTurn("q-chat"), fauxAssistantMessage("Postgres it is")]);
		const asking = chat.session.prompt("pick a database");
		await vi.waitFor(() => assert.equal(inChat.asked.length, 1));
		inChat.answer(0, answer("Postgres"));
		await asking;

		const [detached] = stage.session.takeDetachedToolCalls();
		assert.equal(detached?.toolCallId, "q-stage");
		assert.equal(chat.session.takeDetachedToolCalls().length, 0);
		assert.deepEqual(
			toolResults(chat).map((result) => result.id),
			["q-chat"],
		);
		inStage.answer(0, answer("SQLite"));
		const result = await detached.result;
		assert.equal(result.isError, false);
		assert.match(getMessageText({ role: "toolResult", content: result.result.content }), /SQLite/);
	});

	test("waits in the stage's UI after the stage releases its session, and its answer is recorded once (#4374)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const ui = stageUi();
		const first = await session({ context, store });
		await first.session.bindExtensions({ uiContext: ui.ui, mode: "tui" });
		first.session.setToolDetachment({ afterMs: 0 });
		first.setResponses([askTurn("q-1")]);
		await first.session.prompt("pick a database");
		const [detached] = first.session.takeDetachedToolCalls();
		const sessionId = first.sessionManager.getSessionId();
		parkWorkflowStageForRelease(context);
		await first.session.dispose();

		ui.answer(0, answer("Postgres"));
		const result = await detached!.result;
		const reopened = await session({ context, store }, sessionId);
		reopened.setResponses([fauxAssistantMessage("Postgres it is")]);
		await reopened.session.resumeDetachedTurn([result]);
		await reopened.session.resumeDetachedTurn([result]);

		assert.deepEqual(ui.askedBy, [sessionId]);
		assert.equal(result.isError, false);
		const results = toolResults(reopened);
		assert.deepEqual(
			results.map((recorded) => recorded.id),
			["q-1"],
		);
		assert.match(results[0]!.text, /Postgres/);
		assert.equal(reopened.getPendingResponseCount(), 0, "the turn continued once");
	});

	test("asks again through a restarted stage's UI, which hears the call start before the stage can release, and records the answer once (#4374)", async () => {
		const store = new MemorySessionStore();
		const crashed = await SessionManager.create(store, process.cwd());
		await crashed.appendMessage({ role: "user", content: "pick a database", timestamp: Date.now() });
		await crashed.appendMessage(askTurn("q-1"));
		const restarted = await session({ context: stageContext(), store }, crashed.getSessionId());
		const ui = stageUi();
		await restarted.session.bindExtensions({ uiContext: ui.ui, mode: "tui" });
		restarted.session.setToolDetachment({ afterMs: 0 });
		restarted.setResponses([fauxAssistantMessage("SQLite it is")]);
		const heard: AgentSessionEvent[] = [];
		restarted.session.subscribe((event) => heard.push(event));

		assert.equal(restarted.session.hasPendingDetachedTurn(), true);
		const [asked] = restarted.session.redispatchDetachedToolCalls();
		const startsHeardAtOnce = heard.flatMap((event) =>
			event.type === "tool_execution_start" ? [[event.toolCallId, event.toolName]] : [],
		);
		await vi.waitFor(() => assert.equal(ui.askedBy.length, 1));
		ui.answer(0, answer("SQLite"));
		const result = await asked!.result;
		await restarted.session.resumeDetachedTurn([result]);
		await restarted.session.resumeDetachedTurn([result]);

		assert.deepEqual(startsHeardAtOnce, [["q-1", "ask_user_question"]]);
		assert.deepEqual(ui.askedBy, [crashed.getSessionId()]);
		assert.equal(result.isError, false);
		const results = toolResults(restarted);
		assert.deepEqual(
			results.map((recorded) => recorded.id),
			["q-1"],
		);
		assert.match(results[0]!.text, /SQLite/);
		assert.equal(restarted.getPendingResponseCount(), 0, "the turn continued once");
	});

	test("a call started again behind another gets no context once the session has closed, and fails typed (#4374)", async () => {
		const store = new MemorySessionStore();
		const crashed = await SessionManager.create(store, process.cwd());
		await crashed.appendMessage({ role: "user", content: "pick twice", timestamp: Date.now() });
		await crashed.appendMessage(
			fauxAssistantMessage(
				[
					fauxToolCall("ask_user_question", QUESTION, { id: "q-1" }),
					fauxToolCall("ask_user_question", QUESTION, { id: "q-2" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		const restarted = await session({ context: stageContext(), store }, crashed.getSessionId());
		const ui = stageUi();
		await restarted.session.bindExtensions({ uiContext: ui.ui, mode: "tui" });

		const [first, queued] = restarted.session.redispatchDetachedToolCalls();
		await vi.waitFor(() => assert.equal(ui.askedBy.length, 1));
		await restarted.session.dispose();
		ui.answer(0, answer("Postgres"));
		const results: DetachedToolResult[] = [await first!.result, await queued!.result];

		assert.deepEqual(
			results.map((result) => [result.toolCallId, result.isError]),
			[
				["q-1", false],
				["q-2", true],
			],
		);
		assert.equal(ui.askedBy.length, 1, "the queued call never reached the closed session's UI");
		const failure = (
			results[1]!.result.details as { readonly error: { readonly name: string; readonly code: string } }
		).error;
		assert.deepEqual([failure.name, failure.code], ["ToolDetachmentError", "context-detached"]);
	});
});

describe("a detached call's failure (#4374)", () => {
	test("carries a thrown error's code as data, and nothing for a failure without one (#4374)", async () => {
		const ci = waitTool();
		const harness = await session({ store: new MemorySessionStore(), customTools: [ci.definition] });
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				["ci-1", "ci-2", "ci-3"].map((id) => fauxToolCall("wait_for_ci", { run: id }, { id })),
				{ stopReason: "toolUse" },
			),
		]);
		await harness.session.prompt("watch three runs");
		const calls = harness.session.takeDetachedToolCalls();
		assert.deepEqual(
			calls.map((call) => call.toolCallId),
			["ci-1", "ci-2", "ci-3"],
		);

		ci.fail(0, Object.assign(new Error("the runner is gone"), { code: "RUNNER_GONE" }));
		ci.fail(1, { code: "NOT_AN_ERROR" } as unknown as Error);
		ci.fail(2, new Error("no code at all"));
		const results = await Promise.all(calls.map((call) => call.result));

		assert.deepEqual(
			results.map((result) => [result.isError, result.result.details]),
			[
				[true, { error: { name: "Error", code: "RUNNER_GONE", message: "the runner is gone" } }],
				[true, undefined],
				[true, undefined],
			],
		);
	});
});

describe("a call started again after a restart (#4374)", () => {
	test("is in flight in the session's context, not interrupted, and extensions hear it start (#4374)", async () => {
		const store = new MemorySessionStore();
		const crashed = await SessionManager.create(store, process.cwd());
		await crashed.appendMessage({ role: "user", content: "pick a database", timestamp: Date.now() });
		await crashed.appendMessage(askTurn("q-1"));
		const started: string[] = [];
		const restarted = await session(
			{
				context: stageContext(),
				store,
				extensionFactories: [
					(pi) => {
						pi.on("tool_execution_start", (event) => {
							started.push(event.toolCallId);
						});
					},
				],
			},
			crashed.getSessionId(),
		);
		const ui = stageUi();
		await restarted.session.bindExtensions({ uiContext: ui.ui, mode: "tui" });
		const answeredInContext = () =>
			restarted.session.agent.state.messages.some(
				(message) => message.role === "toolResult" && message.toolCallId === "q-1",
			);
		restarted.session.refreshContext();
		const interruptedBefore = answeredInContext();

		const [asked] = restarted.session.redispatchDetachedToolCalls();
		const interruptedAfter = answeredInContext();
		await vi.waitFor(() => assert.deepEqual(started, ["q-1"]));
		await vi.waitFor(() => assert.equal(ui.askedBy.length, 1));
		ui.answer(0, answer("SQLite"));
		await asked!.result;

		assert.deepEqual([interruptedBefore, interruptedAfter], [true, false]);
	});
});
