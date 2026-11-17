import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { heldPrompts } from "../src/core/extensions/held-prompts.js";
import type { HostInput, HostInputOptions } from "../src/core/extensions/host-input.js";
import type { ExtensionUIContext, SubagentChildPolicy } from "../src/core/extensions/index.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import { createAgentSession } from "../src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk-types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { QuestionParams } from "../src/core/tools/ask-user-question/tool/types.js";
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
		tools: ["ask_user_question"],
		...options,
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** A chat's presentation: records every prompt it is asked to show. */
function chatUi(shown: string[]): ExtensionUIContext {
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
		input: async (title) => {
			shown.push(`input ${title}`);
			return "typed";
		},
		editor: async (title) => {
			shown.push(`editor ${title}`);
			return "edited";
		},
		custom: async () => {
			shown.push("questionnaire");
			return { answers: [], cancelled: true } as never;
		},
	};
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
	assert.equal(heldPrompts().answer(firstRoute, { text: "yes" }).ok, false, "a stale reply is refused");
	assert.equal(heldPrompts().cancel(firstRoute), false);
	assert.equal(heldPrompts().current(childId)?.promptId, secondPrompt.promptId, "the later prompt still waits");
	assert.equal(
		heldPrompts().answer({ sessionId: childId, promptId: secondPrompt.promptId }, { text: "yes" }).ok,
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
