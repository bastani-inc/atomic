import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { AgentWakeDispatcher } from "../../packages/coding-agent/src/core/agent-wake-dispatcher.js";
import { heldPrompts } from "../../packages/coding-agent/src/core/extensions/held-prompts.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { getOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { liveChildEnvironment } from "../helpers/live-child-environment.js";
import { agent } from "../helpers/released-task-launch.js";

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

/** The main chat's presentation: records every prompt it is asked to show. */
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
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
	});
	cleanups.push(() => session.dispose());
	await session.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
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
			// What the main chat gives a subagent it launches, as its own child options do.
			getChildSessionOptions: (options) => ({
				...base.getChildSessionOptions!(options),
				extensionBindings: main.extensionRunner.getChildHostBindings(),
			}),
			index: 0,
		},
		wakeDispatcher: new AgentWakeDispatcher(),
		wait: { kind: "background" },
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
		// The main chat shows nothing, and its own input stays free.
		assert.deepEqual(shown, []);
		assert.equal(await main.extensionRunner.createContext().ui.confirm("Main asks", "own"), true);
		assert.deepEqual(shown, ["confirm Main asks"]);

		// An answer meant for another prompt never reaches this one.
		assert.equal(heldPrompts().answer({ ...attention.route, promptId: "earlier" }, { text: "1" }).ok, false);
		assert.equal(heldPrompts().answer(attention.route, { text: "2" }).ok, true);
		assert.equal(heldPrompts().answer(attention.route, { text: "1" }).ok, false, "answered once");

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
		assert.equal(heldPrompts().answer(attention.route, { text: "1" }).ok, false);
		assert.deepEqual(shown, [], "the main chat never shows the question");
	},
	CHILD_TIMEOUT_MS * 2,
);
