import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { heldPrompts, taskPromptHost } from "../../packages/coding-agent/src/core/extensions/held-prompts.js";
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
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { adoptStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";
import { renderFooterWithOrchestratorReturnHint } from "../../packages/workflows/src/tui/stage-chat-view-footer-status.js";
import {
	deriveGraphTheme,
	makeFakeKeybindings,
	makeTestTui,
	StageChatView,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

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
		builtins: { subagents: false, mcp: false, intercom: false, "web-access": false },
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

test("a workflow stage's dialogs, and its subagent's prompts, never open in an interactive main chat", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-prompt-scope-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: taskPromptHost(mainChat(shown)), mode: "tui" });
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

test.each([true, false])(
	"workflow answer without a prompt id answers a dialog above a questionnaire with stage specified %s (#5354)",
	async (specifyStage) => {
		const root = mkdtempSync(join(tmpdir(), "stage-stacked-questionnaire-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const shown: string[] = [];
		const { session: main } = await createAgentSession(sessionOptions(root));
		cleanups.push(() => main.dispose());
		await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
		const { stage, store, broker } = await workflowStage(root, main);
		const runId = "3a8b8e63-2704-4212-af75-60bff16c299b";
		const params = {
			questions: [{ question: "Which path?", options: [{ label: "Left" }, { label: "Right" }] }],
		};
		const adapter = buildStagePromptAdapter("question-1", "ask_user_question", params, Date.now());
		assert.ok(adapter);
		broker.provideStagePrompt(runId, "stage-1", adapter);
		const ask = stage.agent.state.tools.find((tool) => tool.name === "ask_user_question");
		assert.ok(ask);
		const questionnaire = ask.execute("question-1", params);
		void questionnaire.catch(() => {});
		await vi.waitFor(() => assert.ok(broker.peekStageQuestionnaire(runId, "stage-1")));
		const dialog = stage.extensionRunner.createContext().ui.confirm("Allow?", "Continue this form?");
		void dialog.catch(() => {});
		const prompt = store.run(runId)!.stages[0]!.pendingPrompt!;
		assert.equal(prompt.source, "stage-dialog");
		assert.equal(prompt.kind, "confirm");
		assert.equal(broker.peekStagePrompt(runId, "stage-1")?.id, "question-1");
		const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
		const answered = await workflowAnswerAction(
			{ action: "answer", runId, ...(specifyStage ? { stageId: "stage-1" } : {}), response: true },
			owner,
		);
		assert.equal(answered.status, "ok");
		assert.equal(answered.message, `Answered prompt ${prompt.id}.`);
		assert.equal(await dialog, true);
		assert.equal(broker.peekStagePrompt(runId, "stage-1")?.id, "question-1");
		assert.ok(broker.peekStageQuestionnaire(runId, "stage-1"));
		assert.equal(
			(await workflowAnswerAction({ action: "answer", runId, stageId: "stage-1", response: "Right" }, owner)).status,
			"ok",
		);
		const result = await questionnaire;
		assert.equal(result.details?.cancelled, false);
		assert.equal(result.details?.answers[0]?.answer, "Right");
		assert.deepEqual(shown, []);
	},
);

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

test.each(["stage-chat", "workflow-answer", "escape"] as const)(
	"a confirmation opened inside stage custom UI stacks above it and settles through %s (#5354)",
	async (answerer) => {
		const root = mkdtempSync(join(tmpdir(), "stage-nested-dialog-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const shown: string[] = [];
		const { session: main } = await createAgentSession(sessionOptions(root));
		cleanups.push(() => main.dispose());
		await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
		const { stage, store, broker } = await workflowStage(root, main);
		const runId = "3a8b8e63-2704-4212-af75-60bff16c299b";
		let detaches = 0;
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId,
			stageId: "stage-1",
			workflowName: "prompt-scope",
			onDetach() {
				detaches++;
			},
			onClose() {},
			piTui: makeTestTui(32),
			piTheme: {},
			piKeybindings: makeFakeKeybindings(),
			stageUiBroker: broker,
		});
		cleanups.push(() => view.dispose());
		const ui = stage.extensionRunner.createContext().ui;
		let confirmed: boolean | undefined;
		const customInputs: string[] = [];
		const custom = ui.custom<boolean>((_tui, _theme, _keys, done) => ({
			render: () => [
				confirmed === undefined ? "CUSTOM-WAITING" : confirmed ? "CUSTOM-CONFIRMED" : "CUSTOM-CANCELLED",
			],
			invalidate() {},
			handleInput(data) {
				customInputs.push(data);
				if (data === "ask") {
					void ui
						.confirm("Nested confirmation?", "Continue this component?")
						.then((value) => {
							confirmed = value;
						})
						.catch(() => {});
				} else if (data === "\r") done(confirmed === true);
				return true;
			},
		}));
		void custom.catch(() => {});
		await vi.waitFor(() => assert.match(stripAnsi(view.render(80).join("\n")), /CUSTOM-WAITING/));
		view.handleInput("ask");
		await vi.waitFor(() => assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.kind, "confirm"));
		const prompt = store.run(runId)!.stages[0]!.pendingPrompt!;
		const rendered = stripAnsi(view.render(80).join("\n"));
		assert.match(rendered, /Nested confirmation\?/);
		assert.match(rendered, /esc cancel/);
		assert.doesNotMatch(rendered, /esc close/i);
		const footerRows = renderFooterWithOrchestratorReturnHint(view as never, 80, ["stage footer"]);
		assert.equal(footerRows.length, 1);
		const footer = stripAnsi(footerRows[0]!);
		assert.match(footer, /esc cancel/);
		assert.doesNotMatch(footer, /esc close/i);
		assert.doesNotMatch(rendered, /CUSTOM-WAITING/);
		if (answerer === "stage-chat") {
			view.handleInput("\x1b[C");
			view.handleInput("\r");
		} else if (answerer === "escape") {
			view.handleInput("\x1b");
		} else {
			const answered = await workflowAnswerAction(
				{ action: "answer", runId, stageId: "stage-1", promptId: prompt.id, response: true },
				{ ...captureWorkflowOwnerResources(), store, stageUiBroker: broker },
			);
			assert.equal(answered.status, "ok");
		}
		const expected = answerer !== "escape";
		await vi.waitFor(() => assert.equal(confirmed, expected));
		assert.equal(detaches, 0, "settling the nested dialog keeps its custom component open");
		assert.equal(store.run(runId)?.stages[0]?.status, "awaiting_input");
		assert.equal(store.run(runId)?.stages[0]?.pendingPrompt, undefined);
		assert.match(stripAnsi(view.render(80).join("\n")), expected ? /CUSTOM-CONFIRMED/ : /CUSTOM-CANCELLED/);
		assert.deepEqual(customInputs, ["ask"]);
		view.handleInput("x");
		view.handleInput("\r");
		assert.equal(await custom, expected);
		assert.deepEqual(customInputs, ["ask", "x", "\r"]);
		assert.equal(store.run(runId)?.stages[0]?.status, "running");
		assert.deepEqual(shown, []);
	},
);

test.each(["select", "input", "editor"] as const)(
	"Escape cancels a stacked %s dialog without selecting or submitting its initial value (#5354)",
	async (kind) => {
		const root = mkdtempSync(join(tmpdir(), "stage-custom-dialog-cancel-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const { session: main } = await createAgentSession(sessionOptions(root));
		cleanups.push(() => main.dispose());
		await main.bindExtensions({ uiContext: mainChat([]), mode: "tui" });
		const { stage, store, broker } = await workflowStage(root, main);
		const runId = "3a8b8e63-2704-4212-af75-60bff16c299b";
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId,
			stageId: "stage-1",
			workflowName: "prompt-scope",
			onDetach() {
				assert.fail("the custom component stays attached");
			},
			onClose() {
				assert.fail("the stage chat stays open");
			},
			piTui: makeTestTui(32),
			piTheme: {},
			piKeybindings: makeFakeKeybindings(),
			stageUiBroker: broker,
		});
		cleanups.push(() => view.dispose());
		const inputs: string[] = [];
		const ui = stage.extensionRunner.createContext().ui;
		const custom = ui.custom<boolean>((_tui, _theme, _keys, done) => ({
			render: () => ["CUSTOM-WAITING"],
			invalidate() {},
			handleInput(data) {
				inputs.push(data);
				if (data === "\r") done(true);
				return true;
			},
		}));
		void custom.catch(() => {});
		await vi.waitFor(() => assert.match(stripAnsi(view.render(80).join("\n")), /CUSTOM-WAITING/));
		let result: string | undefined = "pending";
		const dialog =
			kind === "select"
				? ui.select("Choose", ["Approve", "Reject"])
				: kind === "input"
					? ui.input("Name")
					: ui.editor("Edit", "initial");
		void dialog
			.then((value) => {
				result = value;
			})
			.catch(() => {});
		assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.kind, kind);
		const rendered = stripAnsi(view.render(80).join("\n"));
		assert.match(rendered, /esc cancel/);
		assert.doesNotMatch(rendered, /esc close/i);
		assert.doesNotMatch(rendered, /← (?:return to )?graph/);
		const footerRows = renderFooterWithOrchestratorReturnHint(view as never, 80, ["stage footer"]);
		assert.equal(footerRows.length, 1);
		const footer = stripAnsi(footerRows[0]!);
		assert.match(footer, /esc cancel/);
		assert.doesNotMatch(footer, /esc close/i);
		view.handleInput("\x1b");
		await vi.waitFor(() => assert.equal(result, undefined));
		assert.equal(await dialog, undefined);
		assert.equal(store.run(runId)?.stages[0]?.pendingPrompt, undefined);
		assert.match(stripAnsi(view.render(80).join("\n")), /CUSTOM-WAITING/);
		view.handleInput("x");
		view.handleInput("\r");
		assert.equal(await custom, true);
		assert.deepEqual(inputs, ["x", "\r"]);
	},
);

test.each(["select", "input", "editor"] as const)(
	"Left and Backspace on a stacked %s dialog keep the custom UI attached (#5354)",
	async (kind) => {
		const root = mkdtempSync(join(tmpdir(), "stage-custom-dialog-left-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const { session: main } = await createAgentSession(sessionOptions(root));
		cleanups.push(() => main.dispose());
		await main.bindExtensions({ uiContext: mainChat([]), mode: "tui" });
		const { stage, store, broker } = await workflowStage(root, main);
		const runId = "3a8b8e63-2704-4212-af75-60bff16c299b";
		let detaches = 0;
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId,
			stageId: "stage-1",
			workflowName: "prompt-scope",
			onDetach() {
				detaches++;
			},
			onClose() {},
			piTui: makeTestTui(32),
			piTheme: {},
			piKeybindings: makeFakeKeybindings(),
			stageUiBroker: broker,
		});
		cleanups.push(() => view.dispose());
		const ui = stage.extensionRunner.createContext().ui;
		const custom = ui.custom<boolean>((_tui, _theme, _keys, done) => ({
			render: () => ["CUSTOM-WAITING"],
			invalidate() {},
			handleInput(data) {
				if (data === "\r") done(true);
				return true;
			},
		}));
		void custom.catch(() => {});
		await vi.waitFor(() => assert.match(stripAnsi(view.render(80).join("\n")), /CUSTOM-WAITING/));
		const dialog =
			kind === "select"
				? ui.select("Choose", ["Approve", "Reject"])
				: kind === "input"
					? ui.input("Name")
					: ui.editor("Edit", "");
		void dialog.catch(() => {});
		assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.kind, kind);
		view.handleInput("\x1b[D");
		view.handleInput("\x7f");
		assert.equal(detaches, 0);
		assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.kind, kind);
		view.handleInput("\x1b");
		assert.equal(await dialog, undefined);
		assert.match(stripAnsi(view.render(80).join("\n")), /CUSTOM-WAITING/);
		view.handleInput("\r");
		assert.equal(await custom, true);
	},
);

test("a stage's custom prompt waits behind its live dialog instead of replacing it", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-collision-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat([]), mode: "tui" });
	const { stage, store, broker } = await workflowStage(root, main);
	const shownCustom: string[] = [];
	cleanups.push(
		broker.registerHost("3a8b8e63-2704-4212-af75-60bff16c299b", "stage-1", {
			showCustomUi: (request) => shownCustom.push(request.id),
		}),
	);
	const dialogController = new AbortController();
	const pending = stage.extensionRunner
		.createContext()
		.ui.input("First", undefined, { signal: dialogController.signal });
	void pending.catch(() => {});
	const prompt = store.runs()[0]!.stages[0]!.pendingPrompt!;
	const customController = new AbortController();
	const custom = broker.requestCustomUi(
		"3a8b8e63-2704-4212-af75-60bff16c299b",
		"stage-1",
		() => ({ render: () => [] }),
		undefined,
		customController.signal,
	);
	void custom.catch(() => {});
	await assert.rejects(
		broker.requestCustomUi("3a8b8e63-2704-4212-af75-60bff16c299b", "stage-1", () => ({ render: () => [] })),
		/already has a pending custom UI request/,
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(store.runs()[0]!.stages[0]!.pendingPrompt?.id, prompt.id);
	assert.deepEqual(shownCustom, []);
	dialogController.abort();
	assert.equal(await pending, undefined);
	await vi.waitFor(() => assert.equal(shownCustom.length, 1));
	customController.abort(new Error("custom dismissed"));
	await assert.rejects(custom, /custom dismissed/);
});

test("a subagent a stage launches under a task-holding chat waits in its own session, not the stage's or main chat", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-subagent-held-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({
		uiContext: taskPromptHost(mainChat(shown)),
		mode: "tui",
	});
	const { stage, store } = await workflowStage(root, main);
	const { session: child } = await createAgentSession({
		...stage.extensionRunner.createContext().getChildSessionOptions!({ cwd: root }),
		...sessionOptions(root),
	});
	cleanups.push(() => child.dispose());
	const controller = new AbortController();
	const asked = child.extensionRunner.createContext().ui.input("Name", undefined, { signal: controller.signal });
	void asked.catch(() => {});
	await vi.waitFor(() => assert.equal(heldPrompts().current(child.sessionId)?.kind, "input"));
	assert.equal(store.runs()[0]!.stages[0]!.pendingPrompt, undefined);
	controller.abort();
	await asked.catch(() => undefined);
	assert.deepEqual(shown, []);
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

test("a stage's concurrent dialogs wait their turn and each gets its own answer", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-queue-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
	const { stage, store, broker } = await workflowStage(root, main);
	const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
	const ui = stage.extensionRunner.createContext().ui;
	const first = ui.confirm("Allow rm?", "first tool");
	const second = ui.select("Pick target", ["staging", "prod"]);
	void first.catch(() => {});
	void second.catch(() => {});
	const pendingKind = () => store.run("3a8b8e63-2704-4212-af75-60bff16c299b")?.stages[0]?.pendingPrompt?.kind;
	await vi.waitFor(() => assert.equal(pendingKind(), "confirm"));
	const answer = async (response: string | boolean) => {
		const prompt = store.run("3a8b8e63-2704-4212-af75-60bff16c299b")!.stages[0]!.pendingPrompt!;
		return workflowAnswerAction(
			{
				action: "answer",
				runId: "3a8b8e63-2704-4212-af75-60bff16c299b",
				stageId: "stage-1",
				promptId: prompt.id,
				response,
			},
			owner,
		);
	};
	assert.equal((await answer(true)).status, "ok");
	assert.equal(await first, true);
	await vi.waitFor(() => assert.equal(pendingKind(), "select"));
	assert.equal((await answer("prod")).status, "ok");
	assert.equal(await second, "prod");
	assert.deepEqual(shown, []);
});

test("a stage dialog's timeout is shown as its prompt's deadline", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-deadline-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat([]), mode: "tui" });
	const { stage, store } = await workflowStage(root, main);
	const controller = new AbortController();
	const before = Date.now();
	const pending = stage.extensionRunner
		.createContext()
		.ui.confirm("Allow?", "Stage permission", { timeout: 60_000, signal: controller.signal });
	await vi.waitFor(() =>
		assert.equal(store.run("3a8b8e63-2704-4212-af75-60bff16c299b")?.stages[0]?.pendingPrompt?.kind, "confirm"),
	);
	const after = Date.now();
	const expiresAt = store.run("3a8b8e63-2704-4212-af75-60bff16c299b")!.stages[0]!.pendingPrompt!.expiresAt;
	assert.ok(expiresAt !== undefined && expiresAt >= before + 60_000 && expiresAt <= after + 60_000, `${expiresAt}`);
	controller.abort();
	assert.equal(await pending, false);
});

test("a queued stage dialog cancelled while another is live does not let a later dialog jump the queue", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-dialog-queue-cancel-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat([]), mode: "tui" });
	const { stage, store, broker } = await workflowStage(root, main);
	const owner = { ...captureWorkflowOwnerResources(), store, stageUiBroker: broker };
	const ui = stage.extensionRunner.createContext().ui;
	const pendingPrompt = () => store.run("3a8b8e63-2704-4212-af75-60bff16c299b")?.stages[0]?.pendingPrompt;
	const live = ui.confirm("Allow rm?", "live tool");
	void live.catch(() => {});
	await vi.waitFor(() => assert.equal(pendingPrompt()?.kind, "confirm"));
	const livePrompt = pendingPrompt()!;
	const queuedController = new AbortController();
	const queued = ui.input("Queued", undefined, { signal: queuedController.signal });
	queuedController.abort();
	assert.equal(await queued, undefined);
	let laterSettled = false;
	const later = ui.select("Pick target", ["staging", "prod"]).finally(() => {
		laterSettled = true;
	});
	void later.catch(() => {});
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(laterSettled, false, "the later dialog waits for the live one");
	assert.equal(pendingPrompt()?.id, livePrompt.id);
	const answer = async (promptId: string, response: string | boolean) =>
		workflowAnswerAction(
			{ action: "answer", runId: "3a8b8e63-2704-4212-af75-60bff16c299b", stageId: "stage-1", promptId, response },
			owner,
		);
	assert.equal((await answer(livePrompt.id, true)).status, "ok");
	assert.equal(await live, true);
	await vi.waitFor(() => assert.equal(pendingPrompt()?.kind, "select"));
	assert.equal((await answer(pendingPrompt()!.id, "prod")).status, "ok");
	assert.equal(await later, "prod");
});

for (const mode of [undefined, "rpc"] as const) {
	test(`a subagent keeps its ${mode ?? "SDK"} presentation route through a workflow stage (#5354)`, async () => {
		const root = mkdtempSync(join(tmpdir(), "stage-subagent-presentation-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const shown: string[] = [];
		const { session: main } = await createAgentSession(sessionOptions(root));
		cleanups.push(() => main.dispose());
		await main.bindExtensions({ uiContext: mainChat(shown), ...(mode === undefined ? {} : { mode }) });
		const { stage, store } = await workflowStage(root, main);
		const { session: child } = await createAgentSession({
			...stage.extensionRunner.createContext().getChildSessionOptions!({ cwd: root }),
			...sessionOptions(root),
		});
		cleanups.push(() => child.dispose());
		assert.equal(
			await child.extensionRunner.createContext().ui.input("Child name", undefined, { timeout: 20 }),
			"typed",
		);
		assert.deepEqual(shown, ["input Child name"]);
		assert.equal(store.runs()[0]!.stages[0]!.pendingPrompt, undefined);
		assert.equal(heldPrompts().current(child.sessionId), undefined);
	});
}

test("a replacement stage uses its own presentation and drops inherited fallback input when detached (#5354)", async () => {
	const root = mkdtempSync(join(tmpdir(), "stage-replacement-presentation-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const shown: string[] = [];
	const { session: main } = await createAgentSession(sessionOptions(root));
	cleanups.push(() => main.dispose());
	await main.bindExtensions({ uiContext: mainChat(shown), mode: "tui" });
	const { stage, store } = await workflowStage(root, main);
	const { session: replacement } = await createAgentSession({
		...sessionOptions(root),
		extensionBindings: {
			...stage.extensionRunner.getChildHostBindings(),
			uiContext: stage.extensionRunner.getUIContext(),
			mode: "tui",
		},
	});
	cleanups.push(() => replacement.dispose());
	const controller = new AbortController();
	const pending = replacement.extensionRunner
		.createContext()
		.ui.confirm("Replacement asks", "Stage", { signal: controller.signal });
	void pending.catch(() => {});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(shown, []);
	assert.equal(store.runs()[0]!.stages[0]!.pendingPrompt?.kind, "confirm");
	controller.abort();
	assert.equal(await pending, false);
	replacement.extensionRunner.detachPresentation();
	assert.equal(replacement.extensionRunner.createContext().hasHumanInput, false);
	assert.equal(replacement.extensionRunner.getChildHostBindings().humanInput, undefined);
});
