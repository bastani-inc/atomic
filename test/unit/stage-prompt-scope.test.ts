import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { adoptStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sessionOptions(root: string): CreateAgentSessionOptions {
	return {
		cwd: root,
		agentDir: root,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false },
		tools: ["ask_user_question"],
	};
}

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

async function workflowStage(root: string, main: AgentSession) {
	const scope = {};
	const store = adoptStore(scope);
	const broker = adoptStageUiBroker(scope, false, store);
	const adapters = buildRuntimeAdapters(
		// The workflows extension's API: it has no `ui`, and its stages inherit the main session's child options.
		{ getChildSessionOptions: main.extensionRunner.createContext().getChildSessionOptions },
		{
			stageUiBroker: broker,
			createAgentSession: async (options) => createAgentSession({ ...options, ...sessionOptions(root) }),
		},
	);
	const run = new AbortController();
	cleanups.push(() => run.abort());
	const created = (await adapters.agentSession!.create(
		{ tools: ["ask_user_question"] },
		{ runId: "run-1", stageId: "stage-1", stageName: "asker", signal: run.signal },
	)) as { session: AgentSession };
	cleanups.push(() => created.session.dispose());
	return created.session;
}

test("a workflow stage's dialogs, and its subagent's prompts, never open in the main chat", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-prompt-scope-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
	const stage = await workflowStage(root, main);

	// An extension in the stage (a permission gate, say) asks before a tool runs.
	const stageUi = stage.extensionRunner.createContext().ui;
	await stageUi.confirm("Allow rm?", "stage asks", { timeout: 200 }).catch(() => undefined);
	await stageUi.select("Pick", ["a", "b"], { timeout: 200 }).catch(() => undefined);

	// A subagent the stage launched asks too.
	const { session: child } = await createAgentSession({
		...stage.extensionRunner.createContext().getChildSessionOptions!({ cwd: root }),
		...sessionOptions(root),
		subagentPolicy: {
			depth: 1,
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			executionEnded: new AbortController().signal,
		},
	});
	cleanups.push(() => child.dispose());
	await child.extensionRunner
		.createContext()
		.ui.input("Name", undefined, { timeout: 200 })
		.catch(() => undefined);
	const ask = child.agent.state.tools.find((tool) => tool.name === "ask_user_question");
	assert.ok(ask);
	await ask
		.execute(
			"ask-1",
			{
				questions: [
					{
						question: "Which?",
						header: "Pick",
						options: [
							{ label: "A", description: "a" },
							{ label: "B", description: "b" },
						],
					},
				],
			},
			AbortSignal.timeout(2_000),
		)
		.catch(() => undefined);

	assert.deepEqual(shown, [], "the main chat shows none of the stage's or its subagent's prompts");
});
