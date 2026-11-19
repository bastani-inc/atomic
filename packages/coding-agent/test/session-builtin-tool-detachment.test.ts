import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { DetachedCallFailure } from "../src/core/agent-session-detached-tools.js";
import type { ExtensionFactory, ExtensionUIContext, ToolDefinition } from "../src/core/extensions/index.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { QuestionnaireResult, QuestionParams } from "../src/core/tools/ask-user-question/tool/types.js";
import { isTaskToolError, rehydrateTaskToolError } from "../src/core/tools/shell-task-status.js";
import { waitTool } from "./helpers/detached-tools.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
const gateDirectories: string[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (gateDirectories.length > 0) rmSync(gateDirectories.pop()!, { recursive: true, force: true });
});

async function session(
	options: {
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

function toolResults(harness: Harness): { readonly id: string; readonly text: string; readonly isError: boolean }[] {
	return harness.sessionManager
		.buildSessionProjection()
		.messages.flatMap((message) =>
			message.role === "toolResult"
				? [{ id: message.toolCallId, text: getMessageText(message), isError: message.isError }]
				: [],
		);
}

describe("a detachable shell wait (#4374)", () => {
	test("detaches without a budget and runs inline with one (#4374)", async () => {
		const stage = await session({ store: new MemorySessionStore() });
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

	test("starts again after a restart, and a wait on a task that died returns a typed TaskToolError result (#4374)", async () => {
		const store = new MemorySessionStore();
		const crashed = await SessionManager.create(store, process.cwd());
		await crashed.appendMessage({ role: "user", content: "wait for the build", timestamp: Date.now() });
		await crashed.appendMessage(waitTurn("task-of-a-dead-process", "w-1"));
		const restarted = await session({ store }, crashed.getSessionId());
		restarted.setResponses([fauxAssistantMessage("the build is gone; starting it again")]);

		assert.equal(restarted.session.hasPendingDetachedTurn(), true);
		const [again] = restarted.session.redispatchDetachedToolCalls();
		assert.equal(again?.toolCallId, "w-1");
		const result = await again.result;
		await restarted.session.resumeDetachedTurn([result]);

		assert.equal(result.isError, true);
		const { error } = result.result.details as { readonly error: DetachedCallFailure };
		assert.ok(isTaskToolError(error));
		assert.deepEqual(
			[error.code, error.fields, error.retryable, error.message],
			[
				"UnknownTask",
				{ taskId: "task-of-a-dead-process" },
				false,
				(result.result.content[0] as { readonly text: string }).text,
			],
		);
		assert.equal(typeof error.hint, "string");
		assert.equal(rehydrateTaskToolError(JSON.parse(JSON.stringify(error)))?.taskId, "task-of-a-dead-process");
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
			const restarted = await session({ store }, crashed.getSessionId());
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

describe("the builtin ask_user_question (#4374)", () => {
	test("runs inline even with a detachment policy (#4374)", async () => {
		const chat = await session({ store: new MemorySessionStore() });
		const inChat = questionnaireUi();
		await chat.session.bindExtensions({ uiContext: inChat.ui, mode: "tui" });
		chat.session.setToolDetachment({ afterMs: 0 });

		chat.setResponses([askTurn("q-chat"), fauxAssistantMessage("Postgres it is")]);
		const asking = chat.session.prompt("pick a database");
		await vi.waitFor(() => assert.equal(inChat.asked.length, 1));
		inChat.answer(0, answer("Postgres"));
		await asking;

		assert.equal(chat.session.takeDetachedToolCalls().length, 0);
		assert.deepEqual(
			toolResults(chat).map((result) => result.id),
			["q-chat"],
		);
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

	test("carries a thrown error's hint, retryability, JSON-safe fields and cause chain when it has no JSON form of its own (#4374)", async () => {
		const ci = waitTool();
		const harness = await session({ store: new MemorySessionStore(), customTools: [ci.definition] });
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				["ci-1", "ci-2", "ci-3", "ci-4"].map((id) => fauxToolCall("wait_for_ci", { run: id }, { id })),
				{ stopReason: "toolUse" },
			),
		]);
		await harness.session.prompt("watch four runs");
		const calls = harness.session.takeDetachedToolCalls();
		const lost = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

		ci.fail(
			0,
			Object.assign(new Error("the runner is gone", { cause: lost }), {
				code: "RUNNER_GONE",
				hint: "Start the run again.",
				retryable: true,
				fields: { runner: "ci-7", attempt: 2, idle: false, region: null },
			}),
		);
		ci.fail(
			1,
			Object.assign(new Error("the runner is gone"), {
				code: "RUNNER_GONE",
				hint: 7,
				retryable: "yes",
				fields: { runner: "ci-7", nested: { runner: "ci-7" } },
			}),
		);
		ci.fail(2, Object.assign(new Error("the runner is gone"), { code: "RUNNER_GONE", fields: null }));
		ci.fail(3, Object.assign(new Error("the runner is gone"), { code: "RUNNER_GONE", fields: ["ci-7"] }));
		const results = await Promise.all(calls.map((call) => call.result));

		assert.deepEqual(
			results.map((result) => (result.result.details as { readonly error: DetachedCallFailure }).error),
			[
				{
					name: "Error",
					code: "RUNNER_GONE",
					message: "the runner is gone",
					hint: "Start the run again.",
					retryable: true,
					fields: { runner: "ci-7", attempt: 2, idle: false, region: null },
					cause: { name: "Error", code: "ECONNRESET", message: "connection reset" },
				},
				{ name: "Error", code: "RUNNER_GONE", message: "the runner is gone" },
				{ name: "Error", code: "RUNNER_GONE", message: "the runner is gone" },
				{ name: "Error", code: "RUNNER_GONE", message: "the runner is gone" },
			],
		);
	});

	test("an error whose own JSON form throws still settles as an error result, marked as a fallback (#4374)", async () => {
		const ci = waitTool();
		const harness = await session({ store: new MemorySessionStore(), customTools: [ci.definition] });
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "ci-1" }, { id: "ci-1" })], {
				stopReason: "toolUse",
			}),
		]);
		await harness.session.prompt("watch one run");
		const [call] = harness.session.takeDetachedToolCalls();

		ci.fail(
			0,
			Object.assign(new Error("the runner is gone"), {
				code: "RUNNER_GONE",
				hint: "Start the run again.",
				toJSON() {
					throw new TypeError("circular");
				},
			}),
		);
		const result = await call!.result;

		assert.equal(result.isError, true);
		assert.deepEqual(result.result.details, {
			error: {
				name: "Error",
				code: "RUNNER_GONE",
				message: "the runner is gone",
				hint: "Start the run again.",
				serialization: "fallback",
			},
		});
	});
});
