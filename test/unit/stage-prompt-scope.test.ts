import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { HostInput, HostInputOptions } from "../../packages/coding-agent/src/core/extensions/host-input.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
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
	store.recordRunStart({
		id: "3a8b8e63-2704-4212-af75-60bff16c299b",
		name: "prompt-scope",
		status: "running",
		inputs: {},
		stages: [],
		toolNodes: [],
		startedAt: Date.now(),
	});
	store.recordStageStart("3a8b8e63-2704-4212-af75-60bff16c299b", {
		id: "stage-1",
		name: "asker",
		status: "running",
		parentIds: [],
		toolEvents: [],
	});
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
		{ runId: "3a8b8e63-2704-4212-af75-60bff16c299b", stageId: "stage-1", stageName: "asker", signal: run.signal },
	)) as { session: AgentSession };
	cleanups.push(() => created.session.dispose());
	return { stage: created.session, store, broker };
}

test("a workflow stage's dialogs, and its subagent's prompts, never open in the main chat", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-prompt-scope-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
	const { stage } = await workflowStage(root, main);

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

test("a stage's confirmation waits as a stage prompt and workflow answer resolves only that prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
	const { stage, store, broker } = await workflowStage(root, main);
	const controller = new AbortController();
	cleanups.push(() => controller.abort());
	const pending = stage.extensionRunner.createContext().ui.confirm("Allow rm?", "Delete generated files", {
		signal: controller.signal,
	});
	void pending.catch(() => {});
	await vi.waitFor(() =>
		assert.equal(store.run("3a8b8e63-2704-4212-af75-60bff16c299b")?.stages[0]?.pendingPrompt?.kind, "confirm"),
	);
	const prompt = store.run("3a8b8e63-2704-4212-af75-60bff16c299b")!.stages[0]!.pendingPrompt!;
	assert.match(prompt.message, /Allow rm\?/);
	assert.match(prompt.message, /Delete generated files/);
	assert.deepEqual(shown, []);
	const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
	assert.equal(
		(
			await workflowAnswerAction(
				{
					action: "answer",
					runId: "3a8b8e63-2704-4212-af75-60bff16c299b",
					stageId: "stage-1",
					promptId: "stale",
					response: true,
				},
				owner,
			)
		).status,
		"noop",
	);
	const answered = await workflowAnswerAction(
		{
			action: "answer",
			runId: "3a8b8e63-2704-4212-af75-60bff16c299b",
			stageId: "stage-1",
			promptId: prompt.id,
			response: true,
		},
		owner,
	);
	assert.equal(answered.status, "ok", JSON.stringify(answered));
	assert.equal(await pending, true);
	assert.equal(store.run("3a8b8e63-2704-4212-af75-60bff16c299b")?.stages[0]?.pendingPrompt, undefined);
	assert.equal(store.getStagePromptAnswer("3a8b8e63-2704-4212-af75-60bff16c299b", "stage-1")?.value, true);
	const nextController = new AbortController();
	const next = stage.extensionRunner
		.createContext()
		.ui.input("Next decision", undefined, { signal: nextController.signal });
	void next.catch(() => {});
	try {
		assert.equal(store.run("3a8b8e63-2704-4212-af75-60bff16c299b")!.stages[0]!.promptAnswerState, undefined);
		assert.equal(store.getStagePromptAnswer("3a8b8e63-2704-4212-af75-60bff16c299b", "stage-1"), undefined);
	} finally {
		nextController.abort();
		assert.equal(await next, undefined);
	}
	assert.deepEqual(shown, []);
});

test.each(["select", "input", "editor"] as const)(
	"a stage's %s dialog can only be answered in its own session",
	async (kind) => {
		const root = mkdtempSync(join(tmpdir(), "stage-sibling-dialog-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const shown: string[] = [];
		const { session: main } = await createAgentSession(sessionOptions(root));
		cleanups.push(() => main.dispose());
		await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
		const own = await workflowStage(root, main);
		const sibling = await workflowStage(root, main);
		const ask = (session: AgentSession) => {
			const ui = session.extensionRunner.createContext().ui;
			return kind === "select"
				? ui.select("Pick", ["A", "B"])
				: kind === "input"
					? ui.input("Name", "your name")
					: ui.editor("Edit", "initial");
		};
		const ownAnswer = ask(own.stage);
		const siblingAnswer = ask(sibling.stage);
		void ownAnswer.catch(() => {});
		void siblingAnswer.catch(() => {});
		const ownPrompt = own.store.runs()[0]!.stages[0]!.pendingPrompt!;
		const siblingPrompt = sibling.store.runs()[0]!.stages[0]!.pendingPrompt!;
		assert.equal(ownPrompt?.kind, kind);
		assert.equal(siblingPrompt?.kind, kind);
		assert.notEqual(ownPrompt.id, siblingPrompt.id);
		const answer = async (target: typeof own, promptId: string, response: string) =>
			workflowAnswerAction(
				{ action: "answer", runId: "3a8b8e63-2704-4212-af75-60bff16c299b", stageId: "stage-1", promptId, response },
				{ ...captureWorkflowOwnerResources(), store: target.store, stageUiBroker: target.broker },
			);
		assert.equal((await answer(sibling, ownPrompt.id, "A")).status, "noop");
		assert.equal(sibling.store.runs()[0]!.stages[0]!.pendingPrompt?.id, siblingPrompt.id);
		assert.equal((await answer(own, ownPrompt.id, kind === "select" ? "2" : "own text")).status, "ok");
		assert.equal(await ownAnswer, kind === "select" ? "B" : "own text");
		assert.equal(sibling.store.runs()[0]!.stages[0]!.pendingPrompt?.id, siblingPrompt.id);
		assert.equal((await answer(sibling, siblingPrompt.id, kind === "select" ? "A" : "sibling text")).status, "ok");
		assert.equal(await siblingAnswer, kind === "select" ? "A" : "sibling text");
		assert.deepEqual(shown, []);
	},
);

test("aborting a stage dialog does not approve it or let a stale reply answer its next dialog", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-aborted-dialog-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
	const { stage, store, broker } = await workflowStage(root, main);
	const controller = new AbortController();
	const pending = stage.extensionRunner
		.createContext()
		.ui.confirm("Allow?", "Stage permission", { signal: controller.signal });
	const old = store.runs()[0]!.stages[0]!.pendingPrompt!;
	assert.equal(old.kind, "confirm");
	assert.equal(await main.extensionRunner.createContext().ui.confirm("Main?", "Main permission"), true);
	assert.equal(store.runs()[0]!.stages[0]!.pendingPrompt?.id, old.id);
	controller.abort();
	assert.equal(await pending, false);
	assert.equal(store.runs()[0]!.stages[0]!.pendingPrompt, undefined);
	assert.equal(store.getStagePromptAnswer("3a8b8e63-2704-4212-af75-60bff16c299b", "stage-1"), undefined);
	const next = stage.extensionRunner.createContext().ui.input("Next");
	void next.catch(() => {});
	const prompt = store.runs()[0]!.stages[0]!.pendingPrompt!;
	const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
	assert.equal(
		(
			await workflowAnswerAction(
				{
					action: "answer",
					runId: "3a8b8e63-2704-4212-af75-60bff16c299b",
					stageId: "stage-1",
					promptId: old.id,
					response: "late",
				},
				owner,
			)
		).status,
		"noop",
	);
	assert.equal(
		(
			await workflowAnswerAction(
				{
					action: "answer",
					runId: "3a8b8e63-2704-4212-af75-60bff16c299b",
					stageId: "stage-1",
					promptId: prompt.id,
					response: "current",
				},
				owner,
			)
		).status,
		"ok",
	);
	assert.equal(await next, "current");
	assert.deepEqual(shown, ["confirm Main?"]);
});

test("a stage cannot replace a live dialog with a custom prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-collision-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat([]), mode: "tui" });
	const { stage, store, broker } = await workflowStage(root, main);
	const dialogController = new AbortController();
	const pending = stage.extensionRunner
		.createContext()
		.ui.input("First", undefined, { signal: dialogController.signal });
	void pending.catch(() => {});
	const prompt = store.runs()[0]!.stages[0]!.pendingPrompt!;
	const customController = new AbortController();
	const collision = broker.requestCustomUi(
		"3a8b8e63-2704-4212-af75-60bff16c299b",
		"stage-1",
		() => ({ render: () => [] }),
		undefined,
		customController.signal,
	);
	customController.abort(new Error("accepted second prompt"));
	await assert.rejects(collision, /already has a pending/);
	assert.equal(store.runs()[0]!.stages[0]!.pendingPrompt?.id, prompt.id);
	dialogController.abort();
	assert.equal(await pending, undefined);
});

test("a stage's explicit SDK host answers its journalled dialog with the asking session identity", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-host-dialog-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
	const { stage, store } = await workflowStage(root, main);
	const hostAnswer = Promise.withResolvers<boolean>();
	const requests: HostInputOptions[] = [];
	const host: HostInput = {
		confirm: async (_title, _message, options) => {
			requests.push(options);
			return hostAnswer.promise;
		},
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		questionnaire: async () => ({ answers: [], cancelled: true }),
	};
	await stage.bindExtensions({ humanInput: host });
	const pending = stage.extensionRunner.createContext().ui.confirm("Allow?", "Stage permission");
	void pending.catch(() => {});
	await vi.waitFor(() => assert.equal(requests.length, 1));
	assert.equal(store.run("3a8b8e63-2704-4212-af75-60bff16c299b")?.stages[0]?.pendingPrompt?.kind, "confirm");
	assert.equal(requests[0]!.sessionId, stage.sessionId);
	hostAnswer.resolve(true);
	assert.equal(await pending, true);
	assert.equal(store.getStagePromptAnswer("3a8b8e63-2704-4212-af75-60bff16c299b", "stage-1")?.value, true);
	await stage.bindExtensions({ humanInput: { ...host, confirm: async () => "yes" as never } });
	await assert.rejects(
		stage.extensionRunner.createContext().ui.confirm("Allow again?", "Permission"),
		/InvalidHostInput/,
	);
	assert.deepEqual(shown, []);
});
