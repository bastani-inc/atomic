import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getKeybindings, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { type HeldPrompt, heldPromptInput, heldPrompts, taskPromptHost } from "../src/core/extensions/held-prompts.js";
import type { HostInput, HostInputOptions } from "../src/core/extensions/host-input.js";
import type { ExtensionUIContext, SubagentChildPolicy } from "../src/core/extensions/index.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TaskId, TaskRecord } from "../src/core/tasks/contracts.js";
import type { TaskViewSource } from "../src/core/tasks/task-view-source.js";
import type { QuestionParams } from "../src/core/tools/ask-user-question/tool/types.js";
import { ChatSessionHost } from "../src/modes/interactive/components/chat-session-host.js";
import { heldPromptForm } from "../src/modes/interactive/components/held-prompt-form.js";
import { TaskInspector } from "../src/modes/interactive/components/task-inspector.js";
import { themedChatHostStyle } from "../src/modes/interactive/components/task-transcript-page.js";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { createRpcExtensionUIContext, type RpcPendingExtensionRequests } from "../src/modes/rpc/rpc-extension-ui.js";
import { createTestResourceLoader } from "./utilities.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const QUESTION: QuestionParams = {
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

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "child-prompt-scope-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function newSession(root: string, options: CreateAgentSessionOptions = {}): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
		tools: ["ask_user_question"],
		...options,
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** A chat's presentation: records every prompt it is asked to show. */
function chatUi(shown: string[], interactive = true): ExtensionUIContext {
	const ui: ExtensionUIContext = {
		...noOpUIContext,
		confirm: async (title) => {
			shown.push(`confirm ${title}`);
			return true;
		},
		select: async (title, options) => {
			shown.push(`select ${title}`);
			return options[0];
		},
		input: async (title) => {
			shown.push(`input ${title}`);
			return "typed";
		},
		editor: async (title) => {
			shown.push(`editor ${title}`);
			return "edited";
		},
		hostQuestionnaire: async () => {
			shown.push("questionnaire");
			return { answers: [], cancelled: true };
		},
		custom: async () => {
			shown.push("questionnaire");
			return { answers: [], cancelled: true } as never;
		},
	};
	return interactive ? taskPromptHost(ui) : ui;
}

function subagentPolicy(): SubagentChildPolicy {
	return {
		depth: 1,
		managementActions: "restricted",
		fanoutAuthorized: false,
		inheritProjectContext: false,
		inheritSkills: false,
		executionEnded: new AbortController().signal,
	};
}

async function subagentOf(parent: AgentSession, root: string): Promise<AgentSession> {
	const inherited = parent.extensionRunner.createContext().getChildSessionOptions!({ cwd: root });
	return newSession(root, {
		...inherited,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		tools: ["ask_user_question"],
		subagentPolicy: subagentPolicy(),
	});
}

async function ask(session: AgentSession): Promise<void> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "ask_user_question");
	assert.ok(tool, "the session has ask_user_question");
	await tool.execute("ask-1", QUESTION, AbortSignal.timeout(2_000)).catch(() => undefined);
}

test("a subagent's question and dialogs never open in its parent's chat", async () => {
	const root = tempRoot();
	const parentChat: string[] = [];
	const parent = await newSession(root);
	await parent.bindExtensions({ uiContext: chatUi(parentChat), mode: "tui" });
	const child = await subagentOf(parent, root);
	const ui = child.extensionRunner.createContext().ui;

	await ask(child);
	await ui.confirm("Delete the branch?", "child asks", { timeout: 200 }).catch(() => undefined);
	await ui.select("Pick a target", ["a", "b"], { timeout: 200 }).catch(() => undefined);
	await ui.input("Name it", undefined, { timeout: 200 }).catch(() => undefined);
	await ui.editor("Edit it", "draft", { timeout: 200 }).catch(() => undefined);

	assert.deepEqual(parentChat, [], "the parent's chat shows none of the subagent's prompts");
	// The parent's own prompts still open in its chat.
	assert.equal(await parent.extensionRunner.createContext().ui.confirm("Parent asks", "own"), true);
	assert.deepEqual(parentChat, ["confirm Parent asks"]);
});

test("a nested subagent's prompts never open in the chat of the session above its launcher", async () => {
	const root = tempRoot();
	const mainChat: string[] = [];
	const main = await newSession(root);
	await main.bindExtensions({ uiContext: chatUi(mainChat), mode: "tui" });
	const child = await subagentOf(main, root);
	const grandchild = await subagentOf(child, root);

	await ask(grandchild);
	await grandchild.extensionRunner
		.createContext()
		.ui.confirm("Nested", "grandchild asks", { timeout: 200 })
		.catch(() => undefined);

	assert.deepEqual(mainChat, []);
});

test("an SDK host still answers a subagent's prompts, told which session asks", async () => {
	const root = tempRoot();
	const requests: Array<{ method: string; options: HostInputOptions }> = [];
	const host: HostInput = {
		confirm: async (_title, _message, options) => {
			requests.push({ method: "confirm", options });
			return true;
		},
		select: async (_title, choices, options) => {
			requests.push({ method: "select", options });
			return choices[0];
		},
		input: async (_title, _placeholder, options) => {
			requests.push({ method: "input", options });
			return "typed";
		},
		editor: async (_title, _initial, options) => {
			requests.push({ method: "editor", options });
			return "edited";
		},
		questionnaire: async (params, options) => {
			requests.push({ method: "questionnaire", options });
			return {
				cancelled: false,
				answers: [
					{
						questionIndex: 0,
						question: params.questions[0]!.question,
						kind: "option",
						answer: params.questions[0]!.options[0]!.label,
					},
				],
			};
		},
	};
	const parent = await newSession(root, { extensionBindings: { humanInput: host } });
	const child = await subagentOf(parent, root);
	const childId = child.sessionManager.getSessionId();

	assert.equal(await child.extensionRunner.createContext().ui.confirm("Proceed?", "child asks"), true);
	await ask(child);

	assert.deepEqual(
		requests.map(({ method, options }) => [method, options.sessionId]),
		[
			["confirm", childId],
			["questionnaire", childId],
		],
	);
});

test("a subagent's dialog waits in its own session, and a reply meant for an earlier prompt never answers it", async () => {
	const root = tempRoot();
	const parentChat: string[] = [];
	const parent = await newSession(root);
	await parent.bindExtensions({ uiContext: chatUi(parentChat), mode: "tui" });
	const child = await subagentOf(parent, root);
	const childId = child.sessionManager.getSessionId();
	const ui = child.extensionRunner.createContext().ui;

	const first = ui.confirm("Delete the branch?", "first");
	const firstPrompt = heldPrompts().current(childId);
	assert.ok(firstPrompt, "the confirmation is held in the subagent's session");
	assert.equal(firstPrompt.kind, "confirm");
	const firstRoute = { sessionId: childId, promptId: firstPrompt.promptId };
	// Esc in the subagent's view cancels exactly this prompt.
	assert.equal(heldPrompts().cancel(firstRoute), true);
	assert.equal(await first, false);

	const second = ui.confirm("Delete the tag?", "second");
	const secondPrompt = heldPrompts().current(childId);
	assert.ok(secondPrompt);
	assert.notEqual(secondPrompt.promptId, firstPrompt.promptId);
	assert.equal(heldPrompts().answer(firstRoute, { value: true }).ok, false, "a stale reply is refused");
	assert.equal(heldPrompts().cancel(firstRoute), false);
	assert.equal(heldPrompts().current(childId)?.promptId, secondPrompt.promptId, "the later prompt still waits");
	assert.equal(
		heldPrompts().answer({ sessionId: childId, promptId: secondPrompt.promptId }, { value: true }).ok,
		true,
	);
	assert.equal(await second, true);
	assert.deepEqual(parentChat, []);
});

test("a subagent's held prompt ends with its session, never moved to its parent", async () => {
	const root = tempRoot();
	const parentChat: string[] = [];
	const parent = await newSession(root);
	await parent.bindExtensions({ uiContext: chatUi(parentChat), mode: "tui" });
	const child = await subagentOf(parent, root);
	const childId = child.sessionManager.getSessionId();

	const pending = child.extensionRunner
		.createContext()
		.ui.select("Pick", ["a", "b"])
		.then(
			() => "settled",
			(error: Error & { code?: string }) => error.code ?? error.message,
		);
	assert.equal(heldPrompts().current(childId)?.kind, "select");
	child.dispose();
	assert.notEqual(await pending, "settled");
	assert.equal(heldPrompts().current(childId), undefined);
	assert.deepEqual(parentChat, []);
});

test("held prompt answers validate form values, preserve numeric option labels, and keep questionnaire summaries single-line", async () => {
	const controller = new AbortController();
	cleanups.push(() => controller.abort());
	const sessionId = "held-validation-session";

	const selectPromise = heldPromptInput.select("Pick a value", ["alpha", "1", "8080"], {
		signal: controller.signal,
		requestId: "select-1",
		sessionId,
	});
	const selectHeld = heldPrompts().current(sessionId);
	assert.ok(selectHeld);
	const selectRoute = { sessionId, promptId: selectHeld.promptId };
	assert.equal(
		heldPrompts().answer(selectRoute, { value: "not-a-choice" }).ok,
		false,
		"an invalid choice value is refused without settling the prompt",
	);
	assert.equal(heldPrompts().current(sessionId)?.promptId, selectHeld.promptId);
	assert.equal(heldPrompts().answer(selectRoute, { value: "1" }).ok, true);
	assert.equal(await selectPromise, "1");

	const numericSelect = heldPromptInput.select("Pick port", ["3000", "8080"], {
		signal: controller.signal,
		requestId: "select-2",
		sessionId,
	});
	assert.equal(heldPrompts().answer({ sessionId, promptId: "select-2" }, { value: "8080" }).ok, true);
	assert.equal(await numericSelect, "8080");

	const confirmPromise = heldPromptInput.confirm("Proceed?", "detail", {
		signal: controller.signal,
		requestId: "confirm-1",
		sessionId,
	});
	assert.equal(heldPrompts().answer({ sessionId, promptId: "confirm-1" }, { value: "yes" }).ok, false);
	assert.equal(heldPrompts().answer({ sessionId, promptId: "confirm-1" }, { value: true }).ok, true);
	assert.equal(await confirmPromise, true);

	const qPromise = heldPromptInput.questionnaire(
		{
			questions: [
				{
					question: "\nFirst line question\nSecond line detail",
					header: "Header",
					options: [
						{ label: "left", description: "l" },
						{ label: "right", description: "r" },
					],
				},
			],
		},
		{ signal: controller.signal, requestId: "q-1", sessionId },
	);
	const qHeld = heldPrompts().current(sessionId);
	assert.ok(qHeld);
	assert.equal(qHeld.question, "First line question");
	assert.equal(
		heldPrompts().answer({ sessionId, promptId: "q-1" }, { value: { cancelled: true, answers: [] } }).ok,
		false,
		"a cancelled questionnaire value cannot be submitted as an answer",
	);
	assert.equal(heldPrompts().cancel({ sessionId, promptId: "q-1" }), true);
	assert.equal((await qPromise).cancelled, true);
});

test("a replacement session that detaches its presentation does not fall back to holding prompts", async () => {
	const root = tempRoot();
	const shown: string[] = [];
	const first = await newSession(root);
	await first.bindExtensions({ uiContext: chatUi(shown), mode: "tui" });

	// A replacement session inherits getChildHostBindings() and the presentation UI, as AgentSessionRuntime does.
	const replacement = await newSession(root, {
		extensionBindings: {
			...first.extensionRunner.getChildHostBindings(),
			uiContext: chatUi(shown),
			mode: "tui",
		},
	});
	assert.equal(replacement.extensionRunner.createContext().hasHumanInput, true);

	// Retiring the replacement detaches its presentation; it must not fall back to heldPromptInput.
	replacement.extensionRunner.detachPresentation();
	assert.equal(replacement.extensionRunner.createContext().hasHumanInput, false);
	assert.equal(replacement.extensionRunner.getChildHostBindings().humanInput, undefined);
	await assert.rejects(() => replacement.extensionRunner.createContext().ui.confirm("Retired asks", "after detach"), {
		code: "HumanInputUnavailable",
	});
	assert.equal(heldPrompts().current(replacement.sessionManager.getSessionId()), undefined);
});

test("space or enter on a Needs input task opens the subagent transcript, and ← preserves caret and form state across input, editor, and questionnaire forms", async () => {
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
	const sessionId = "subagent-form-nav";
	const taskId = "task-nav-1" as TaskId;
	const childTranscript = SessionManager.inMemory();
	for (let i = 0; i < 30; i++) {
		await childTranscript.appendMessage({
			role: "user",
			content: `LINE-${String(i).padStart(2, "0")}`,
			timestamp: i,
		});
	}

	const currentTask = (): TaskRecord => {
		const held = heldPrompts().current(sessionId);
		return {
			ref: { ownerId: "owner-1" as never, taskId, sessionId: "parent-1" },
			kind: "agent",
			title: "Ask subagent",
			agentName: "asker",
			wasBackground: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			execution: { kind: "running" },
			attention: held
				? {
						kind: "input-needed",
						requestId: held.promptId,
						prompt: held.question,
						route: { sessionId, promptId: held.promptId },
					}
				: { kind: "none" },
			observation: { kind: "background" },
			output: { byteCount: "0", omittedRanges: [] },
			capabilities: { canCancel: true, canForeground: false, hasStdin: false },
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

	const plain = () =>
		inspector
			.renderViewport(80, 24)
			.map((line) => stripTerminalSequences(line).trimEnd())
			.join("\n");

	const inputPromise = track(
		heldPromptInput.input("Enter branch name", "feature/x", {
			signal: controller.signal,
			requestId: "input-1",
			sessionId,
		}),
	);
	assert.match(plain(), /Needs input/);
	assert.match(plain(), /Enter branch name/);
	inspector.handleInput(" ");
	assert.match(plain(), /^Transcript/);
	assert.match(plain(), /Enter branch name/);
	assert.doesNotMatch(plain(), /esc to interrupt/);
	assert.doesNotMatch(plain(), /\? keys/);
	assert.match(plain(), /← task/);

	inspector.handleInput("a");
	inspector.handleInput("b");
	assert.doesNotMatch(plain().split("\n").at(-1) ?? "", /← task/);
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /^Transcript/, "← with caret at 1 moves caret, does not leave");
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /^Transcript/, "← moving caret to 0 stays in transcript");
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /Needs input/, "← at caret 0 leaves transcript without cancelling");
	assert.equal(heldPrompts().current(sessionId)?.promptId, "input-1", "input prompt remains held");

	inspector.handleInput("\r");
	assert.match(plain(), /^Transcript/);
	assert.match(plain(), /LINE-29/);
	inspector.handleInput("\x1b[5~");
	assert.doesNotMatch(plain(), /LINE-29/, "PageUp scrolls transcript while held form is open");
	inspector.handleInput("X");
	inspector.handleInput("\r");
	assert.equal(await inputPromise, "Xab");
	assert.match(plain(), /esc to interrupt/);

	const editorPromise = track(
		heldPromptInput.editor("Edit commit message", "hi", {
			signal: controller.signal,
			requestId: "editor-1",
			sessionId,
		}),
	);
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /^Transcript/);
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /^Transcript/);
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /Needs input/);
	assert.equal(heldPrompts().current(sessionId)?.promptId, "editor-1");
	inspector.handleInput("\r");
	inspector.handleInput("!");
	inspector.handleInput("\r");
	assert.equal(await editorPromise, "!hi");

	const qPromise = track(
		heldPromptInput.questionnaire(QUESTION, {
			signal: controller.signal,
			requestId: "q-nav-1",
			sessionId,
		}),
	);
	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[B");
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /Needs input/, "← on empty Type something. leaves transcript");
	inspector.handleInput("\r");
	inspector.handleInput("z");
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /^Transcript/);
	inspector.handleInput("\x1b[D");
	assert.match(plain(), /Needs input/);
	inspector.handleInput("\r");
	inspector.handleInput("a");
	inspector.handleInput("\r");
	const qResult = await qPromise;
	assert.equal(qResult.cancelled, false);
	assert.equal(qResult.answers[0]?.answer, "az");

	const stalePrompt: HeldPrompt = {
		sessionId,
		promptId: "already-settled",
		kind: "confirm",
		question: "Stale?",
		title: "Stale?",
		createdAt: Date.now(),
	};
	const firstStale = heldPromptForm(stalePrompt, { requestRender: () => {} });
	const secondStale = heldPromptForm(stalePrompt, { requestRender: () => {} });
	assert.notEqual(firstStale, secondStale, "settled prompts are not cached in the live forms map");
	keys.setUserBindings({ "app.nav.back": ["escape", "left"] });
	const cancelled = track(
		heldPromptInput.confirm("Cancel this question?", "Do not approve", {
			signal: controller.signal,
			requestId: "escape-remap",
			sessionId,
		}),
	);
	assert.doesNotMatch(plain(), /esc\/← task/);
	inspector.handleInput("\x1b");
	assert.equal(heldPrompts().current(sessionId), undefined);
	assert.equal(await cancelled, false);
	assert.match(plain(), /^Transcript/);
	inspector.handleInput("?");
	assert.doesNotMatch(plain(), /esc\/←\s+back/);
	assert.match(plain(), /←\s+back, on an empty prompt/);
});

for (const mode of [undefined, "rpc", "tui"] as const) {
	test(`a ${mode ?? "plain SDK"} presentation without a task inspector still answers child dialogs (#5354)`, async () => {
		const root = tempRoot();
		const shown: string[] = [];
		const parent = await newSession(root);
		const pending: RpcPendingExtensionRequests = new Map();
		const rpc = createRpcExtensionUIContext({
			pendingExtensionRequests: pending,
			capabilities: { questionnaire: true },
			output: (request) => {
				if (!("id" in request) || typeof request.id !== "string" || !("method" in request)) return;
				const reply = pending.get(request.id);
				if (request.method === "confirm") {
					shown.push("confirm Allow?");
					reply?.resolve({ type: "extension_ui_response", id: request.id, confirmed: true });
				} else if (request.method === "questionnaire") {
					shown.push("questionnaire");
					reply?.resolve({ type: "extension_ui_response", id: request.id, cancelled: true });
				} else if (["select", "input", "editor"].includes(String(request.method))) {
					const method = String(request.method);
					shown.push(`${method} ${method === "select" ? "Pick" : method === "input" ? "Name" : "Edit"}`);
					reply?.resolve({
						type: "extension_ui_response",
						id: request.id,
						value: method === "select" ? "one" : method === "input" ? "typed" : "edited",
					});
				}
			},
		});
		await parent.bindExtensions({
			uiContext: mode === "rpc" ? rpc : chatUi(shown, false),
			...(mode === undefined ? {} : { mode }),
		});
		const child = await subagentOf(parent, root);
		const ui = child.extensionRunner.createContext().ui;
		assert.equal(await ui.confirm("Allow?", "child asks", { timeout: 20 }), true);
		assert.equal(await ui.select("Pick", ["one", "two"], { timeout: 20 }), "one");
		assert.equal(await ui.input("Name", undefined, { timeout: 20 }), "typed");
		assert.equal(await ui.editor("Edit", "draft", { timeout: 20 }), "edited");
		await ask(child);
		assert.equal(heldPrompts().current(child.sessionManager.getSessionId()), undefined);
		assert.deepEqual(shown, ["confirm Allow?", "select Pick", "input Name", "editor Edit", "questionnaire"]);
	});
}
