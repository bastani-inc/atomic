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
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { workflowPanelSource } from "../../packages/workflows/src/extension/workflow-panel-source.js";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { testRunId } from "../helpers/run-id.js";

const runIds = new Set<string>();

afterEach(() => {
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
	assert.deepEqual(await answerAgentPanelItem(session, `run:${runId}`, "yes"), { ok: true });
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
	assert.equal(row(formId)?.state, "input", "a form still marks its run as needing input");
	assert.equal(row(formId)?.question, undefined, "but no single question is shown for it");
	broker.clearStagePrompt(uniqueId, "ask");
	assert.equal(store.recordStageAwaitingInput(uniqueId, "ask", false), true);
	assert.equal(row(uniqueId)?.question, undefined);
	assert.equal(row(uniqueId)?.state, "running");
	broker.clearStagePrompt(formId, "ask");
	assert.equal(store.recordStageAwaitingInput(formId, "ask", false), true);
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
