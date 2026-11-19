import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import {
	heldPromptInput,
	heldPrompts,
	taskPromptHost,
} from "../../packages/coding-agent/src/core/extensions/held-prompts.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type {
	AttemptId,
	Generation,
	OperationId,
	OwnerId,
	TaskId,
	TaskRecord,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent } from "../helpers/released-task-launch.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const CHILD_TIMEOUT_MS = 60_000;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearSubagentControls();
});

const QUESTION = {
	questions: [
		{
			question: "Which path should the subagent take?",
			header: "Path",
			options: [
				{ label: "left", description: "the left path" },
				{ label: "right", description: "the right path" },
			],
		},
	],
};

function mainChat(shown: string[]): ExtensionUIContext {
	return {
		...noOpUIContext,
		confirm: async (title) => {
			shown.push(`confirm ${title}`);
			return true;
		},
		select: async (title, options) => {
			shown.push(`select ${title}`);
			return options[0];
		},
		custom: async () => {
			shown.push("questionnaire");
			return { answers: [], cancelled: true } as never;
		},
	};
}

async function mainSession(root: string, shown: string[]): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	cleanups.push(() => session.dispose());
	await session.bindExtensions({ uiContext: taskPromptHost(mainChat(shown)), mode: "tui" });
	return session;
}

async function launchAskingSubagent(env: Awaited<ReturnType<typeof liveChildEnvironment>>, main: AgentSession) {
	const answered: string[] = [];
	env.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_user_question", QUESTION, { id: "ask-1" })], { stopReason: "toolUse" }),
		(context) => {
			for (const message of context.messages)
				if (message.role === "toolResult")
					for (const part of message.content) if (part.type === "text") answered.push(part.text);
			return fauxAssistantMessage("took the path");
		},
	]);
	const host = main.getAgentTaskHost!();
	const base = env.options("held-question", {
		sessionManager: await SessionManager.create(new MemorySessionStore(), env.root),
	});
	const response = await runAgentTask({
		host,
		cwd: env.root,
		agents: [{ ...agent, name: "asker" }],
		agent: "asker",
		task: "ask which path",
		options: {
			...base,
			releaseWhenWaiting: { afterMs: 0 },
			getChildSessionOptions: (options) => ({
				...base.getChildSessionOptions!(options),
				extensionBindings: main.extensionRunner.getChildHostBindings(),
			}),
			index: 0,
		},
		wakeDispatcher: new AgentWakeDispatcher(),
		runtime: { runSync },
	});
	assert.equal(response.kind, "admitted");
	const store = getOwnerTaskStore(main);
	assert.ok(store);
	const task = (): TaskRecord => {
		const found = store.tasks.find((candidate) => candidate.kind === "agent");
		assert.ok(found, "the subagent's task is listed");
		return found;
	};
	return { task, answered };
}

test(
	"a subagent's question waits in its own session, needs input on its launcher's /tasks, and takes one answer",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const shown: string[] = [];
		const main = await mainSession(env.root, shown);
		const { task, answered } = await launchAskingSubagent(env, main);

		await vi.waitFor(() => assert.equal(task().attention.kind, "input-needed"), { timeout: CHILD_TIMEOUT_MS });
		const attention = task().attention;
		assert.ok(attention.kind === "input-needed");
		assert.equal(attention.prompt, "Which path should the subagent take?");
		const held = heldPrompts().current(attention.route.sessionId);
		assert.ok(held, "the question is held in the subagent's own session");
		assert.equal(held.promptId, attention.route.promptId);
		assert.notEqual(attention.route.sessionId, main.sessionManager.getSessionId());
		assert.deepEqual(shown, []);
		assert.equal(await main.extensionRunner.createContext().ui.confirm("Main asks", "own"), true);
		assert.deepEqual(shown, ["confirm Main asks"]);

		const rightAnswer = {
			cancelled: false,
			answers: [
				{
					questionIndex: 0,
					question: "Which path should the subagent take?",
					kind: "option" as const,
					answer: "right",
				},
			],
		};
		assert.equal(heldPrompts().answer({ ...attention.route, promptId: "earlier" }, { value: rightAnswer }).ok, false);
		assert.equal(heldPrompts().answer(attention.route, { value: rightAnswer }).ok, true);
		assert.equal(heldPrompts().answer(attention.route, { value: rightAnswer }).ok, false, "answered once");

		await vi.waitFor(() => assert.equal(task().execution.kind, "settled"), { timeout: CHILD_TIMEOUT_MS });
		assert.equal(task().attention.kind, "none");
		const settled = task().execution;
		assert.ok(settled.kind === "settled" && settled.result.kind === "completed");
		assert.match(answered.join("\n"), /right/, "the subagent's model reads the answer");
		assert.deepEqual(shown, ["confirm Main asks"]);
	},
	CHILD_TIMEOUT_MS * 2,
);

test(
	"a subagent's question is cancelled with the subagent, never moved to its launcher",
	async () => {
		const env = await liveChildEnvironment(cleanups);
		const shown: string[] = [];
		const main = await mainSession(env.root, shown);
		const { task } = await launchAskingSubagent(env, main);
		await vi.waitFor(() => assert.equal(task().attention.kind, "input-needed"), { timeout: CHILD_TIMEOUT_MS });
		const attention = task().attention;
		assert.ok(attention.kind === "input-needed");

		const stopped = await ownerTaskViewSource(getOwnerTaskStore(main)!).cancelTask(task().ref.taskId);
		assert.equal(stopped.ok, true);
		await vi.waitFor(() => assert.equal(task().execution.kind, "settled"), { timeout: CHILD_TIMEOUT_MS });
		assert.equal(heldPrompts().current(attention.route.sessionId), undefined);
		assert.equal(
			heldPrompts().answer(attention.route, {
				value: {
					cancelled: false,
					answers: [
						{
							questionIndex: 0,
							question: "Which path should the subagent take?",
							kind: "option",
							answer: "left",
						},
					],
				},
			}).ok,
			false,
		);
		assert.deepEqual(shown, [], "the main chat never shows the question");
	},
	CHILD_TIMEOUT_MS * 2,
);

test("held forms preserve drafts when left, show paging keys, and count down timed dialogs (#5354)", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	cleanups.push(() => setKeybindings(previousKeys));

	const controller = new AbortController();
	const waiters: Promise<unknown>[] = [];
	const track = <T>(promise: Promise<T>): Promise<T> => {
		const settled = promise.catch(() => undefined);
		waiters.push(settled);
		return promise;
	};
	cleanups.push(async () => {
		controller.abort();
		await Promise.allSettled(waiters);
	});
	const sessionId = "subagent-ui-fixes";
	const taskId = "task-ui-fixes" as TaskId;
	const ownerId = "owner-ui-fixes" as OwnerId;
	const childTranscript = SessionManager.inMemory();
	for (let i = 0; i < 25; i++) {
		await childTranscript.appendMessage({
			role: "user",
			content: `MSG-${String(i).padStart(2, "0")}`,
			timestamp: i,
		});
	}

	const currentTask = (): TaskRecord => {
		const held = heldPrompts().current(sessionId);
		return {
			ref: { ownerId, taskId, attemptId: "attempt-ui" as AttemptId, generation: "generation-ui" as Generation },
			launchOperationId: "launch-ui" as OperationId,
			launchOrdinal: 0,
			kind: "agent",
			title: "Ask subagent",
			agentName: "asker",
			wasBackground: true,
			cleanup: { kind: "active" },
			execution: { kind: "running" },
			attention: held
				? {
						kind: "input-needed",
						requestId: held.promptId,
						prompt: held.question,
						route: { sessionId, promptId: held.promptId },
					}
				: { kind: "none" },
			observation: { kind: "background", reason: "explicit" },
			output: { ownerId, taskId, artifactId: "output-ui", byteCount: "0", omittedRanges: [] },
		};
	};

	const listeners = new Set<() => void>();
	cleanups.push(
		heldPrompts().subscribe(() => {
			for (const listener of listeners) listener();
		}),
	);
	const source: TaskViewSource = {
		get tasks() {
			return [currentTask()];
		},
		get backgroundTasks() {
			return [currentTask()];
		},
		settlementOrder: new Map(),
		recentActivity: () => [],
		activityOmitted: () => false,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		cancelTask: async () => ({ ok: true, value: undefined }),
		interruptTask: async () => ({ ok: true, value: undefined }),
		stdinAvailable: () => false,
		writeTaskInput: async () => ({ ok: false, error: { message: "unsupported" } }),
		readTaskOutput: async () => ({ ok: true, value: { text: "", omitted: false } }),
		taskDetailText: () => ({ prompt: "Ask subagent" }),
		readTaskTranscript: () => ({
			ok: true,
			value: {
				messages: childTranscript
					.getEntries()
					.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
			},
		}),
		followTaskTranscript: () => ({
			session: {
				getSessionId: () => sessionId,
				getEntries: () => childTranscript.getEntries(),
				subscribe: () => () => {},
				isRunning: () => true,
			},
			historyOnly: false,
		}),
		extensionStatuses: () => new Map(),
		watchExtensionStatuses: () => () => {},
	};

	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
		undefined,
		() => ({
			createChat: (opts) => new ChatSessionHost(opts),
			keybindings: keys,
			editorTheme: getEditorTheme(),
			style: themedChatHostStyle(),
		}),
	);
	cleanups.push(() => inspector.dispose());

	const ansi = (cols = 80) => inspector.renderViewport(cols, 28).join("\n");
	const plain = (cols = 80) =>
		inspector
			.renderViewport(cols, 28)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");

	const multiPromise = track(
		heldPromptInput.questionnaire(
			{
				questions: [
					{
						question: "First question?",
						header: "Q1",
						options: [
							{ label: "a1", description: "opt a1", preview: "preview a1" },
							{ label: "a2", description: "opt a2", preview: "preview a2" },
						],
					},
					{
						question: "Second question?",
						header: "Q2",
						options: [
							{ label: "b1", description: "opt b1" },
							{ label: "b2", description: "opt b2" },
						],
					},
				],
			},
			{ signal: controller.signal, requestId: "multi-q", sessionId },
		),
	);
	assert.match(plain(), /Needs input/);
	assert.match(plain(), /First question\?/);
	inspector.handleInput(" ");
	assert.match(plain(80), /^Transcript/);
	assert.match(plain(80), /First question\?/);
	assert.match(plain(80).split("\n").at(-1) ?? "", /← task/, "tab 0 shows ← task in the footer");
	assert.match(ansi(80), /\x1b\[/);
	initTheme("light");
	assert.match(plain(160).split("\n").at(-1) ?? "", /← task/);
	assert.match(ansi(160), /\x1b\[/);
	initTheme("dark");

	inspector.handleInput("\r");
	assert.match(plain(), /Second question\?/);
	assert.doesNotMatch(plain().split("\n").at(-1) ?? "", /← task/, "tab 1 uses ← for previous tab");

	inspector.handleInput("\t");
	assert.match(plain(), /Review your answers/);
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /Second question\?/);
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /First question\?/);
	assert.match(plain().split("\n").at(-1) ?? "", /← task/, "back on tab 0 shows ← task");
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /Needs input/, "← on tab 0 leaves transcript without cancelling");
	assert.equal(heldPrompts().current(sessionId)?.promptId, "multi-q");

	inspector.handleInput("\r");
	assert.match(plain(), /^Transcript/);
	inspector.handleInput("\t");
	inspector.handleInput("\x1b[B");
	inspector.handleInput("\r");
	inspector.handleInput("\r");
	const multiResult = await multiPromise;
	assert.equal(multiResult.cancelled, false);
	assert.deepEqual(
		multiResult.answers.map((a) => a.answer),
		["a1", "b2"],
	);

	const choices = Array.from({ length: 12 }, (_, idx) => `choice-${idx + 1}`);
	const selectPromise = track(
		heldPromptInput.select("Pick one of twelve", choices, {
			signal: controller.signal,
			requestId: "select-12",
			sessionId,
		}),
	);
	assert.match(plain().split("\n").at(-1) ?? "", /pgup\/pgdn page/);
	assert.doesNotMatch(plain().split("\n").at(-1) ?? "", /pgup\/pgdn scroll/);
	assert.match(plain(), /MSG-24/);
	inspector.handleInput("\x1b[6~");
	assert.match(plain(), /choice-11/);
	assert.match(plain(), /MSG-24/);
	inspector.handleInput("\r");
	assert.equal(await selectPromise, "choice-11");
	assert.match(plain().split("\n").at(-1) ?? "", /pgup\/pgdn scroll/);

	vi.useFakeTimers();
	cleanups.push(() => {
		vi.useRealTimers();
	});

	const timedConfirm = track(
		heldPromptInput.confirm("Approve deploy?", "production", {
			signal: controller.signal,
			requestId: "timed-confirm",
			sessionId,
			timeout: 5_000,
		}),
	);
	assert.match(plain(), /Approve deploy\? \(5s\)/);
	vi.advanceTimersByTime(1_000);
	assert.match(plain(), /Approve deploy\? \(4s\)/);
	assert.equal(heldPrompts().cancel({ sessionId, promptId: "timed-confirm" }), true);
	assert.equal(await timedConfirm, false);

	const timedSelect = track(
		heldPromptInput.select("Timed target", ["staging", "prod"], {
			signal: controller.signal,
			requestId: "timed-select",
			sessionId,
			timeout: 5_000,
		}),
	);
	assert.match(plain(), /Timed target \(5s\)/);
	vi.advanceTimersByTime(1_000);
	assert.match(plain(), /Timed target \(4s\)/);
	assert.equal(heldPrompts().cancel({ sessionId, promptId: "timed-select" }), true);
	assert.equal(await timedSelect, undefined);

	const timedInput = track(
		heldPromptInput.input("Timed branch", undefined, {
			signal: controller.signal,
			requestId: "timed-input",
			sessionId,
			timeout: 5_000,
		}),
	);
	assert.match(plain(), /Timed branch \(5s\)/);
	vi.advanceTimersByTime(1_000);
	assert.match(plain(), /Timed branch \(4s\)/);
	assert.equal(heldPrompts().cancel({ sessionId, promptId: "timed-input" }), true);
	assert.equal(await timedInput, undefined);

	const timedEditor = track(
		heldPromptInput.editor("Timed notes", "initial", {
			signal: controller.signal,
			requestId: "timed-editor",
			sessionId,
			timeout: 5_000,
		}),
	);
	assert.match(plain(), /Timed notes \(5s\)/);
	vi.advanceTimersByTime(1_000);
	assert.match(plain(), /Timed notes \(4s\)/);
	assert.equal(heldPrompts().cancel({ sessionId, promptId: "timed-editor" }), true);
	assert.equal(await timedEditor, undefined);
});
