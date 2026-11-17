/**
 * The agent panel's workflow rows against a real store and answer path: a run's question shows on its row until it is
 * answered or cancelled (#5224, formerly the BACKGROUND widget's pending-input preview, #2529 / #3027).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
	AgentPanelSourceHub,
	agentPanelItems,
	answerAgentPanelItem,
	openAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import factory from "../../packages/workflows/src/extension/extension-factory.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { workflowPanelSource } from "../../packages/workflows/src/extension/workflow-panel-source.js";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { buildGraphOverlayAdapter, type OverlayUISurface } from "../../packages/workflows/src/tui/overlay-adapter.js";
import {
	markWorkflowRunViewed,
	panelItemsFromSnapshot,
	viewedWorkflowRuns,
} from "../../packages/workflows/src/tui/panel-runs.js";
import { injectStageLabelIntoEditorTopRule } from "../../packages/workflows/src/tui/stage-chat-view-footer-status.js";
import type { StageChatViewContext } from "../../packages/workflows/src/tui/stage-chat-view-types.js";
import { testRunId } from "../helpers/run-id.js";

const runIds = new Set<string>();
const mountedComponents = new Set<PiCustomComponent>();

afterEach(() => {
	for (const component of mountedComponents) component.dispose?.();
	mountedComponents.clear();
	for (const runId of runIds) store.removeRun(runId);
	runIds.clear();
});

function makeRun(seed: string, name: string, stages: StageSnapshot[], startedAt = Date.now()) {
	const id = testRunId(seed);
	runIds.add(id);
	store.recordRunStart({ id, name, inputs: {}, status: "running", toolNodes: [], stages, startedAt });
	return id;
}

const stage = (id: string, status: StageSnapshot["status"], parentIds: string[] = []): StageSnapshot =>
	({ id, name: id, status, parentIds, toolEvents: [] }) as StageSnapshot;

function prompt(id: string, message: string): PendingPrompt {
	return { id, kind: "input", message, createdAt: Date.now() };
}

function row(runId: string) {
	return panelItemsFromSnapshot(store.runs()).find((item) => item.id === `run:${runId}`);
}

test("a run's row names its current stage and counts its settled stages (#5224)", () => {
	const runId = makeRun("panel-progress", "ralph", [
		stage("plan", "completed"),
		stage("implement", "running", ["plan"]),
		stage("review", "pending", ["implement"]),
	]);
	const run = row(runId);
	assert.equal(run?.kind, "workflow");
	assert.equal(run?.name, "ralph");
	assert.equal(run?.state, "running");
	assert.equal(run?.task, "stage implement");
	assert.deepEqual(run?.progress, { done: 1, total: 3 });
	assert.ok((run?.elapsedMs ?? -1) >= 0);
});

test("a waiting question shows on the run's row until it is answered (#5224)", async () => {
	const runId = makeRun("panel-question", "answerable", [stage("ask", "running")]);
	assert.equal(store.recordStagePendingPrompt(runId, "ask", prompt("answer-prompt", "Approve the plan?")), true);
	assert.equal(row(runId)?.state, "input");
	assert.equal(row(runId)?.question, "Approve the plan?");
	assert.equal(row(runId)?.task, "Approve the plan?");

	const result = await workflowAnswerAction({ runId, text: "ship it" });
	assert.equal(result.status, "ok");
	assert.equal(row(runId)?.state, "running");
	assert.equal(row(runId)?.question, undefined);
});

test("a failed run's row carries a one-line reason (#5224)", () => {
	const runId = makeRun("panel-failed", "broken", [stage("build", "running")]);
	store.recordStageEnd(runId, {
		...stage("build", "failed"),
		error: "npm ERR! missing script: build\n    at run (cli.js:1:1)",
	} as StageSnapshot);
	store.recordRunEnd(runId, "failed", undefined, "stage build failed");
	const run = row(runId);
	assert.equal(run?.state, "failed");
	assert.ok(run?.endedAt !== undefined);
	assert.ok(run?.reason !== undefined && !run.reason.includes("\n"), "the reason is one line");
	assert.equal(run?.task, run?.reason);
});

// Ported from the retired BACKGROUND widget's pending-input tests (#2529, #3027): the agent panel now carries them.

const prompt2 = (id: string, message: string): PendingPrompt => ({ id, kind: "input", message, createdAt: Date.now() });

test("answer and cancellation clear only the owning run's question (#2529, #5224)", () => {
	const ownerA = makeRun("owner-a", "alpha", [stage("ask", "running")]);
	const ownerB = makeRun("owner-b", "beta", [stage("ask", "running")]);
	assert.equal(store.recordStagePendingPrompt(ownerA, "ask", prompt2("prompt-a", "Answer alpha?")), true);
	assert.equal(store.recordStagePendingPrompt(ownerB, "ask", prompt2("prompt-b", "Answer beta?")), true);
	assert.equal(row(ownerA)?.question, "Answer alpha?");
	assert.equal(row(ownerB)?.question, "Answer beta?");
	assert.equal(store.resolveStagePendingPrompt(ownerA, "ask", "prompt-a", true), true);
	assert.equal(row(ownerA)?.question, undefined);
	assert.equal(row(ownerB)?.question, "Answer beta?");
	assert.equal(store.resolveStagePendingPrompt(ownerB, "ask", "prompt-b", true, { recordAnswer: false }), true);
	assert.equal(row(ownerB)?.question, undefined);
	assert.equal(row(ownerB)?.state, "running");
});

test("a waiting question reaches the panel without transcript or model messages (#3027, #5224)", async () => {
	const noticesBefore = store.notices().length;
	const runId = makeRun("silent-root", "silent", [stage("ask", "running")]);
	assert.equal(store.recordStagePendingPrompt(runId, "ask", prompt2("silent-prompt", "Stay off transcript?")), true);
	await Promise.resolve();
	assert.equal(store.notices().length, noticesBefore);
	assert.equal(row(runId)?.question, "Stay off transcript?");
});

test("the panel answers a waiting run end to end through its source (#5224)", async () => {
	const hub = new AgentPanelSourceHub();
	const opened: string[] = [];
	hub.register(
		workflowPanelSource(captureWorkflowOwnerResources(), {
			open: (runId) => opened.push(runId),
			quit: async () => {
				throw new Error("not used");
			},
		}),
	);
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const runId = makeRun("panel-answer", "answerable", [stage("ask", "running")]);
	assert.equal(store.recordStagePendingPrompt(runId, "ask", prompt2("panel-prompt", "Ship it?")), true);
	const item = agentPanelItems(session).find((candidate) => candidate.id === `run:${runId}`);
	assert.equal(item?.state, "input");
	assert.equal(item?.question, "Ship it?");
	assert.deepEqual(await answerAgentPanelItem(session, `run:${runId}`, "yes", item), { ok: true });
	assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.pendingPrompt, undefined);
	assert.equal(agentPanelItems(session).find((candidate) => candidate.id === `run:${runId}`)?.question, undefined);
	assert.equal(openAgentPanelItem(session, `run:${runId}`), true);
	assert.deepEqual(opened, [runId], "Enter opens the run's graph");
});

test("hostile prompt text is sanitised to one plain line on the panel row (#5224)", () => {
	const runId = makeRun("hostile", "hostile", [stage("ask", "running")]);
	assert.equal(
		store.recordStagePendingPrompt(runId, "ask", prompt2("hostile-prompt", "Pick\x1b[31m red\x07\n\u202Eone\u0000?")),
		true,
	);
	const question = row(runId)?.question ?? "";
	assert.doesNotMatch(question, /[\x00-\x1f\x7f\u202e]/);
	assert.match(question, /Pick/);
});

test("a structured question shows when it is the only one; a multi-question form stays general (#3027, #5224)", () => {
	const unique = buildStagePromptAdapter(
		"unique-structured",
		"ask_user_question",
		{ questions: [{ question: "Ready to continue?", options: [{ label: "Yes" }, { label: "No" }] }] },
		1,
	);
	const form = buildStagePromptAdapter(
		"form-structured",
		"ask_user_question",
		{
			questions: [
				{ question: "First structured field?", options: [] },
				{ question: "Second structured field?", options: [] },
			],
		},
		1,
	);
	assert.ok(unique && form);
	const broker = new StageUiBroker(store);
	const uniqueId = makeRun("structured-unique", "structured-unique", [stage("ask", "running")]);
	const formId = makeRun("structured-form", "structured-form", [stage("ask", "running")]);
	broker.provideStagePrompt(uniqueId, "ask", unique);
	broker.provideStagePrompt(formId, "ask", form);
	assert.equal(store.recordStageAwaitingInput(uniqueId, "ask", true), true);
	assert.equal(store.recordStageAwaitingInput(formId, "ask", true), true);
	assert.equal(row(uniqueId)?.state, "input");
	assert.equal(row(uniqueId)?.question, "Ready to continue?");
	assert.deepEqual(row(uniqueId)?.choices, ["Yes", "No"]);
	assert.equal(row(formId)?.state, "input", "a form still marks its run as needing input");
	assert.equal(row(formId)?.question, undefined, "but no single question is shown for it");
	assert.equal(row(formId)?.choices, undefined);
	broker.clearStagePrompt(uniqueId, "ask");
	assert.equal(store.recordStageAwaitingInput(uniqueId, "ask", false), true);
	assert.equal(row(uniqueId)?.question, undefined);
	assert.equal(row(uniqueId)?.choices, undefined);
	assert.equal(row(uniqueId)?.state, "running");
	broker.clearStagePrompt(formId, "ask");
	assert.equal(store.recordStageAwaitingInput(formId, "ask", false), true);
});

test("a single-select brokered prompt projects choices and answers by option index through the panel source (#5224)", async () => {
	const owner = captureWorkflowOwnerResources();
	const adapter = buildStagePromptAdapter(
		"release-channel",
		"ask_user_question",
		{
			questions: [
				{
					question: "Which release channel?",
					options: [{ label: "stable" }, { label: "canary" }],
				},
			],
		},
		1,
	);
	assert.ok(adapter);
	const hub = new AgentPanelSourceHub();
	hub.register(
		workflowPanelSource(owner, {
			open: () => {},
			quit: async () => {
				throw new Error("not used");
			},
		}),
	);
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const runId = makeRun("channel-choice", "release", [stage("ask", "running")]);
	owner.stageUiBroker.provideStagePrompt(runId, "ask", adapter);
	const customUiPromise = owner.stageUiBroker.requestCustomUi(runId, "ask", async () => ({
		render: () => [],
		invalidate: () => {},
	}));
	const item = agentPanelItems(session).find((candidate) => candidate.id === `run:${runId}`);
	assert.equal(item?.state, "input");
	assert.equal(item?.question, "Which release channel?");
	assert.deepEqual(item?.choices, ["stable", "canary"]);
	assert.deepEqual(await answerAgentPanelItem(session, `run:${runId}`, "2", item), { ok: true });
	const resolved = (await customUiPromise) as {
		answers: Array<{ kind: string; answer: string | null }>;
		cancelled: boolean;
	};
	assert.equal(resolved.cancelled, false);
	assert.equal(resolved.answers[0]?.kind, "option");
	assert.equal(resolved.answers[0]?.answer, "canary");
});

test("a hidden nested child's wait marks its top-level run as needing input (#5224)", () => {
	const now = Date.now();
	const run = (id: string, stages: StageSnapshot[], extra: Partial<RunSnapshot> = {}): RunSnapshot =>
		({ id, name: id, inputs: {}, status: "running", toolNodes: [], stages, startedAt: now, ...extra }) as RunSnapshot;
	const ask = {
		...stage("ask", "awaiting_input"),
		pendingPrompt: { id: "nested", kind: "confirm", message: "Child asks?", createdAt: now },
	} as StageSnapshot;
	const items = panelItemsFromSnapshot([
		run("child", [ask], { parentRunId: "parent", rootRunId: "root" }),
		run("parent", [], { parentRunId: "root", rootRunId: "root" }),
		run("root", []),
	]);
	assert.deepEqual(
		items.map((item) => item.id),
		["run:root"],
		"nested runs have no rows of their own",
	);
	assert.equal(items[0]?.state, "input");
});

function registeredWorkflowPanelSource(ui?: OverlayUISurface) {
	let registered: Parameters<NonNullable<ExtensionAPI["registerAgentPanelSource"]>>[0] | undefined;
	let f2Handler: (() => void) | undefined;
	const pi = {
		ui,
		events: { on() {}, emit() {} },
		on() {},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerShortcut(key: string, options: { handler: () => void }) {
			if (key === "F2") f2Handler = options.handler;
		},
		registerAgentPanelSource(source: Parameters<NonNullable<ExtensionAPI["registerAgentPanelSource"]>>[0]) {
			registered = source;
			return { dispose() {} };
		},
	} as unknown as ExtensionAPI;
	factory(pi);
	assert.ok(registered);
	return { source: registered, pressF2: () => f2Handler?.() };
}

test("nested child prompts surface on the root row and answer the child's exact prompt (#5224)", async () => {
	const rootId = makeRun("panel-nested-root", "parent-wf", [
		{
			...stage("to-child", "running"),
			workflowChildRun: { alias: "child", workflow: "child-wf", runId: "nested-child-ask" },
		},
	]);
	runIds.add("nested-child-ask");
	store.recordRunStart({
		id: "nested-child-ask",
		name: "child-wf",
		inputs: {},
		status: "running",
		parentRunId: rootId,
		parentStageId: "to-child",
		rootRunId: rootId,
		toolNodes: [],
		stages: [stage("confirm-db", "running")],
		startedAt: Date.now(),
	});
	assert.equal(
		store.recordStagePendingPrompt("nested-child-ask", "confirm-db", {
			id: "child-prompt",
			kind: "select",
			message: "Delete the production database?",
			choices: ["no", "yes"],
			createdAt: Date.now(),
		}),
		true,
	);

	const { source } = registeredWorkflowPanelSource();
	const rootRow = source.items().find((item) => item.id === `run:${rootId}`);
	assert.equal(rootRow?.state, "input");
	assert.equal(rootRow?.question, "Delete the production database?");
	assert.equal(rootRow?.task, "Delete the production database?");
	assert.deepEqual(rootRow?.choices, ["no", "yes"]);
	assert.equal(typeof rootRow?.promptId, "string");

	const res = await source.answer!(`run:${rootId}`, "no", {
		promptId: rootRow?.promptId,
		question: rootRow?.question,
		choices: rootRow?.choices,
	});
	assert.deepEqual(res, { ok: true });
	assert.equal(row(rootId)?.state, "running");

	assert.equal(
		store.recordStagePendingPrompt("nested-child-ask", "confirm-db", {
			id: "child-prompt-1",
			kind: "input",
			message: "First question?",
			createdAt: Date.now(),
		}),
		true,
	);
	const firstRow = source.items().find((item) => item.id === `run:${rootId}`);
	assert.equal(firstRow?.question, "First question?");
	store.resolveStagePendingPrompt("nested-child-ask", "confirm-db", "child-prompt-1", "done");
	assert.equal(
		store.recordStagePendingPrompt("nested-child-ask", "confirm-db", {
			id: "child-prompt-2",
			kind: "input",
			message: "Unseen replacement question?",
			createdAt: Date.now(),
		}),
		true,
	);
	source.items();
	const staleAttempt = await source.answer!(`run:${rootId}`, "blind answer", {
		promptId: firstRow?.promptId,
		question: firstRow?.question,
	});
	assert.equal(staleAttempt.ok, false);
	const missingIdentityAttempt = await source.answer!(`run:${rootId}`, "blind answer");
	assert.equal(missingIdentityAttempt.ok, false);
});

test("a panel answer without an identity reports what is missing, not a changed question (#5233)", async () => {
	const { source } = registeredWorkflowPanelSource();
	const runId = makeRun("panel-missing-identity", "deploy", [stage("ask", "running")]);
	store.recordStagePendingPrompt(runId, "ask", prompt("p1", "Deploy to staging?"));
	const result = await source.answer!(`run:${runId}`, "yes");
	assert.deepEqual(result, { ok: false, reason: "This answer does not say which question it answers." });
	assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.id, "p1");
});

test("question text alone cannot answer a replacement with identical text (#5233)", async () => {
	const { source } = registeredWorkflowPanelSource();
	const runId = makeRun("panel-question-only", "deploy", [stage("ask", "running")]);
	store.recordStagePendingPrompt(runId, "ask", prompt("p1", "Deploy to staging?"));
	const displayed = source.items().find((item) => item.id === `run:${runId}`);
	assert.ok(displayed?.question);
	store.resolveStagePendingPrompt(runId, "ask", "p1", "done");
	store.recordStagePendingPrompt(runId, "ask", prompt("p2", displayed.question));
	const result = await source.answer!(`run:${runId}`, "yes", { question: displayed.question });
	assert.equal(result.ok, false);
	assert.equal(store.run(runId)?.stages[0]?.pendingPrompt?.id, "p2");
	const current = source.items().find((item) => item.id === `run:${runId}`);
	assert.deepEqual(await source.answer!(`run:${runId}`, "no", { promptId: current?.promptId }), { ok: true });
});

test("parallel prompts and custom-UI prompts omit single-prompt question and choices (#5224)", async () => {
	const { source } = registeredWorkflowPanelSource();
	const parallelId = makeRun("panel-parallel", "parallel-wf", [
		stage("branch-a", "running"),
		stage("branch-b", "running"),
	]);
	assert.equal(
		store.recordStagePendingPrompt(parallelId, "branch-a", {
			id: "p-a",
			kind: "select",
			message: "Approve A?",
			choices: ["yes", "no"],
			createdAt: Date.now(),
		}),
		true,
	);
	assert.equal(
		store.recordStagePendingPrompt(parallelId, "branch-b", {
			id: "p-b",
			kind: "select",
			message: "Approve B?",
			choices: ["yes", "no"],
			createdAt: Date.now(),
		}),
		true,
	);
	assert.equal(row(parallelId)?.state, "input");
	assert.equal(row(parallelId)?.question, undefined);
	assert.equal(row(parallelId)?.choices, undefined);
	assert.equal(row(parallelId)?.task, "stage branch-a");
	assert.equal((await source.answer!(`run:${parallelId}`, "yes")).ok, false);

	const customId = makeRun("panel-custom", "custom-wf", [
		{
			...stage("custom-gate", "awaiting_input"),
			promptFootprint: {
				id: "custom-1",
				kind: "custom",
				message: "Custom interactive UI prompt.",
				createdAt: Date.now(),
			},
		},
	]);
	assert.equal(row(customId)?.state, "input");
	assert.equal(row(customId)?.question, undefined);
	assert.equal(row(customId)?.choices, undefined);
	assert.equal(row(customId)?.task, "stage custom-gate");
	assert.equal((await source.answer!(`run:${customId}`, "yes")).ok, false);
});

test("panel rows sanitize questions and failure reasons while keeping exact choice values for answers (#5224)", () => {
	const askId = makeRun("panel-sanitize-ask", "sanitize-wf", [stage("ask", "running")]);
	assert.equal(
		store.recordStagePendingPrompt(askId, "ask", {
			id: "san-1",
			kind: "select",
			message: "\u202eApprove \x1b]0;pwned\x07this?",
			choices: ["\u202eyes\x1b]0;bad\x07", "no\x1b[2J"],
			createdAt: Date.now(),
		}),
		true,
	);
	assert.equal(row(askId)?.question, "Approve this?");
	assert.deepEqual(row(askId)?.choices, ["\u202eyes\x1b]0;bad\x07", "no\x1b[2J"]);

	const failId = makeRun("panel-sanitize-fail", "sanitize-fail", [stage("build", "running")]);
	store.recordStageEnd(failId, {
		...stage("build", "failed"),
		error: "\u202efatal \x1b]0;pwned\x07error",
	});
	store.recordRunEnd(failId, "failed", undefined, "\u202efatal \x1b]0;pwned\x07error");
	assert.equal(row(failId)?.reason, "<U+202E>fatal error");
	assert.doesNotMatch(row(failId)?.reason ?? "", /[\x00-\x1f\u202e]/);

	const surrogateReasonId = makeRun("panel-surrogate-reason", "surrogate-fail", [stage("build", "running")]);
	const boundaryError = `${"x".repeat(118)}🚀 tail`;
	store.recordStageEnd(surrogateReasonId, {
		...stage("build", "failed"),
		error: boundaryError,
	});
	store.recordRunEnd(surrogateReasonId, "failed", undefined, boundaryError);
	const truncatedReason = row(surrogateReasonId)?.reason;
	assert.equal(truncatedReason, `${"x".repeat(118)}…`);
	assert.equal(truncatedReason?.isWellFormed(), true);

	const controlNameId = makeRun("panel-sanitize-name", "\u202e\x1b[2J\x1b]0;pwned\x07", [stage("build", "running")]);
	assert.equal(row(controlNameId)?.name, "<U+202E>");
	assert.doesNotMatch(row(controlNameId)?.name ?? "", /[\x00-\x1f\u202e]/);
});

test("panel progress counts nested child workflow stages, and ended blocked runs remain paused (#5224)", () => {
	const rootId = makeRun("panel-nested-prog", "nested-prog", [
		{
			...stage("delegate", "running"),
			workflowChildRun: { alias: "child", workflow: "child-wf", runId: "nested-prog-child" },
		},
	]);
	assert.deepEqual(row(rootId)?.progress, { done: 0, total: 1 });

	runIds.add("nested-prog-child");
	store.recordRunStart({
		id: "nested-prog-child",
		name: "child-wf",
		inputs: {},
		status: "running",
		parentRunId: rootId,
		parentStageId: "delegate",
		rootRunId: rootId,
		toolNodes: [],
		stages: [stage("c1", "completed"), stage("c2", "running", ["c1"])],
		startedAt: Date.now(),
	});
	assert.deepEqual(row(rootId)?.progress, { done: 1, total: 2 });

	store.recordStageStart("nested-prog-child", stage("c3", "completed", ["c2"]));
	store.recordStageStart("nested-prog-child", stage("c4", "pending", ["c3"]));
	assert.deepEqual(row(rootId)?.progress, { done: 2, total: 4 });

	const blockedId = makeRun("panel-ended-blocked", "blocked-wf", [stage("s1", "completed")]);
	store.recordRunEnd(blockedId, "blocked", undefined, "blocked on external dependency");
	assert.equal(row(blockedId)?.state, "paused");
});

test("a failed workflow open through the extension source or F2 never marks the run viewed (#5224)", () => {
	const { source, pressF2 } = registeredWorkflowPanelSource();
	const runId = makeRun("panel-open-failed", "not-shown", [stage("s1", "completed")]);
	store.recordRunEnd(runId, "completed");
	assert.equal(source.open!(`run:${runId}`), false);
	assert.notEqual(source.items().find((item) => item.id === `run:${runId}`)?.viewed, true);
	pressF2();
	assert.equal(viewedWorkflowRuns(store).has(runId), false);
});

test("opening a finished run via source.open, overlay.open or F2 marks it viewed, and stage composer clock excludes paused time (#5224)", () => {
	const ui: OverlayUISurface = {
		custom: (factory) => {
			const component = factory({ requestRender() {}, terminal: { rows: 24, columns: 100 } }, {}, {}, () => {});
			assert.ok(!(component instanceof Promise));
			mountedComponents.add(component);
			return undefined;
		},
	};
	const { source, pressF2 } = registeredWorkflowPanelSource(ui);
	const doneA = makeRun("panel-viewed-a", "done-a", [stage("s1", "completed")]);
	store.recordRunEnd(doneA, "completed");
	const doneB = makeRun("panel-viewed-b", "done-b", [stage("s1", "completed")]);
	store.recordRunEnd(doneB, "completed");

	assert.equal(source.items().find((item) => item.id === `run:${doneA}`)?.viewed, undefined);
	source.open!(`run:${doneA}`);
	assert.equal(source.items().find((item) => item.id === `run:${doneA}`)?.viewed, true);

	assert.equal(source.items().find((item) => item.id === `run:${doneB}`)?.viewed, undefined);
	pressF2();
	assert.equal(source.items().find((item) => item.id === `run:${doneB}`)?.viewed, true);

	const doneC = makeRun("panel-viewed-c", "done-c", [stage("s1", "completed")]);
	store.recordRunEnd(doneC, "completed");
	const overlay = buildGraphOverlayAdapter({ ui }, store);
	assert.equal(overlay.open(doneC), true);
	assert.equal(row(doneC)?.viewed, true);
	assert.equal(viewedWorkflowRuns(store).has(doneC), true);
	store.removeRun(doneC);
	panelItemsFromSnapshot(store.runs());
	assert.equal(viewedWorkflowRuns(store).has(doneC), false);

	const storeA = createStore();
	const storeB = createStore();
	storeA.recordRunStart({
		id: "run-a",
		name: "wf-a",
		inputs: {},
		status: "completed",
		endedAt: 100,
		toolNodes: [],
		stages: [stage("s1", "completed")],
		startedAt: 10,
	});
	storeB.recordRunStart({
		id: "run-b",
		name: "wf-b",
		inputs: {},
		status: "completed",
		endedAt: 200,
		toolNodes: [],
		stages: [stage("s1", "completed")],
		startedAt: 20,
	});
	markWorkflowRunViewed("run-a", storeA);
	assert.equal(panelItemsFromSnapshot(storeA.runs(), 300, storeA)[0]?.viewed, true);
	assert.equal(panelItemsFromSnapshot(storeB.runs(), 300, storeB)[0]?.viewed, undefined);
	assert.equal(viewedWorkflowRuns(storeA).has("run-a"), true);
	assert.equal(panelItemsFromSnapshot(storeA.runs(), 300, storeA)[0]?.viewed, true);

	const ctx = {
		theme: deriveGraphTheme({}),
		chatHost: { hasInputText: () => false },
	} as unknown as StageChatViewContext;
	const lines = injectStageLabelIntoEditorTopRule(
		ctx,
		"implement",
		["─".repeat(80), "❯ ", "─".repeat(80)],
		{
			...stage("implement", "running"),
			startedAt: 0,
			pausedDurationMs: 15 * 60_000,
		},
		20 * 60_000,
	);
	assert.ok(lines[0]?.includes("5m"), `expected 5m in composer rule, got: ${lines[0]}`);
	assert.ok(!lines[0]?.includes("20m"), `expected paused time excluded, got: ${lines[0]}`);
});
