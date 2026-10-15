/**
 * BACKGROUND pending-input affordance against a real store and answer path. #2529 / #3027
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflowAnswerAction } from "../../packages/workflows/src/extension/workflow-tool-answer.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { installStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.js";
import {
	buildThemedWidgetLines,
	renderWidgetLines,
	type WorkflowWidgetRowLayout,
} from "../../packages/workflows/src/tui/widget.js";
import { testRunId } from "../helpers/run-id.js";

const runIds = new Set<string>();

afterEach(() => {
	for (const runId of runIds) store.removeRun(runId);
	runIds.clear();
});

function makeRun(seed: string, name: string, startedAt = Date.now()) {
	const id = testRunId(seed);
	runIds.add(id);
	store.recordRunStart({
		id,
		name,
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }] as StageSnapshot[],
		startedAt,
	});
	return id;
}

function rangeCard(lines: string[], layout: WorkflowWidgetRowLayout, runId: string): string {
	const range = layout.runs.find((run) => run.id === runId);
	assert.ok(range, `missing layout range for ${runId}`);
	return lines.slice(range.start, range.end).join("\n");
}

function prompt(id: string, message: string): PendingPrompt {
	return { id, kind: "input", message, createdAt: Date.now() };
}

test("answer and cancellation clear only the owning background affordance", () => {
	const ownerA = makeRun("owner-a", "alpha");
	const ownerB = makeRun("owner-b", "beta");
	assert.equal(store.recordStagePendingPrompt(ownerA, "ask", prompt("prompt-a", "Answer alpha?")), true);
	assert.equal(store.recordStagePendingPrompt(ownerB, "ask", prompt("prompt-b", "Answer beta?")), true);

	const both = renderWidgetLines(store.snapshot(), 120).join("\n");
	assert.match(both, /"Answer alpha\?"/);
	assert.match(both, /"Answer beta\?"/);

	assert.equal(store.resolveStagePendingPrompt(ownerA, "ask", "prompt-a", true), true);
	const afterAnswer = renderWidgetLines(store.snapshot(), 120).join("\n");
	assert.doesNotMatch(afterAnswer, /Answer alpha/);
	assert.match(afterAnswer, /"Answer beta\?"/);

	assert.equal(store.resolveStagePendingPrompt(ownerB, "ask", "prompt-b", true, { recordAnswer: false }), true);
	const afterCancel = renderWidgetLines(store.snapshot(), 120).join("\n");
	assert.doesNotMatch(afterCancel, /Answer beta/);
	assert.doesNotMatch(afterCancel, new RegExp(`/workflow connect ${ownerB}`));
});

test("background preview updates emit no transcript or model messages", async () => {
	const widgetCalls: Array<{ key: string; factory: unknown }> = [];
	const dispose = installStoreWidget(
		{
			ui: {
				setWidget(key, factory) {
					widgetCalls.push({ key, factory });
				},
				requestRender() {},
			},
		},
		store,
	);
	try {
		const noticesBefore = store.notices().length;
		const runId = makeRun("silent-root", "silent");
		assert.equal(store.recordStagePendingPrompt(runId, "ask", prompt("silent-prompt", "Stay off transcript?")), true);
		await Promise.resolve();
		assert.equal(store.notices().length, noticesBefore);
		assert.equal(
			widgetCalls.every((call) => call.key === "workflow.run"),
			true,
		);
		assert.match(renderWidgetLines(store.snapshot(), 120).join("\n"), /"Stay off transcript\?"/);
	} finally {
		dispose();
	}
});

test("existing explicit workflow answer remains available", async () => {
	const runId = makeRun("answer-root", "answerable");
	assert.equal(store.recordStagePendingPrompt(runId, "ask", prompt("answer-prompt", "Answer me?")), true);
	assert.match(renderWidgetLines(store.snapshot(), 120).join("\n"), /"Answer me\?"/);

	const result = await workflowAnswerAction({ runId, text: "ship it" });
	assert.equal(result.status, "ok");
	assert.doesNotMatch(renderWidgetLines(store.snapshot(), 120).join("\n"), /Answer me/);
	assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.pendingPrompt, undefined);
});

test("structured stage prompts preview one question and keep multi-question roots general", () => {
	const uniqueAdapter = buildStagePromptAdapter(
		"unique-structured",
		"ask_user_question",
		{ questions: [{ question: "Ready to continue?", options: [{ label: "Yes" }, { label: "No" }] }] },
		1,
	);
	const formAdapter = buildStagePromptAdapter(
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
	assert.ok(uniqueAdapter);
	assert.equal(uniqueAdapter.prompt.questions.length, 1);
	assert.ok(formAdapter);
	assert.equal(formAdapter.prompt.questions.length, 2);

	const assertIsolation = (order: "form-first" | "unique-first") => {
		const broker = new StageUiBroker(store);
		const uniqueStartedAt = order === "form-first" ? 1_000 : 2_000;
		const formStartedAt = order === "form-first" ? 2_000 : 1_000;
		const uniqueId = makeRun(`structured-unique-${order}`, "structured-unique", uniqueStartedAt);
		const formId = makeRun(`structured-form-${order}`, "structured-form", formStartedAt);
		broker.provideStagePrompt(uniqueId, "ask", uniqueAdapter);
		broker.provideStagePrompt(formId, "ask", formAdapter);
		assert.equal(store.recordStageAwaitingInput(uniqueId, "ask", true), true);
		assert.equal(store.recordStageAwaitingInput(formId, "ask", true), true);

		const layout: WorkflowWidgetRowLayout = { runs: [] };
		const lines = buildThemedWidgetLines(store.snapshot(), undefined, 180, Date.now(), layout);
		const uniqueIndex = lines.findIndex((line) => line.includes(uniqueId));
		const formIndex = lines.findIndex((line) => line.includes(formId));
		assert.notEqual(uniqueIndex, -1);
		assert.notEqual(formIndex, -1);
		if (formStartedAt > uniqueStartedAt) assert.ok(formIndex < uniqueIndex);
		else assert.ok(uniqueIndex < formIndex);

		const uniqueCard = rangeCard(lines, layout, uniqueId);
		const formCard = rangeCard(lines, layout, formId);
		assert.match(uniqueCard, /"Ready to continue\?"/);
		assert.equal([...uniqueCard.matchAll(/Answer: \/workflow connect/g)].length, 1);
		assert.match(uniqueCard, new RegExp(`Answer: /workflow connect ${uniqueId}`));
		assert.doesNotMatch(formCard, /First structured field/);
		assert.doesNotMatch(formCard, /Second structured field/);
		assert.doesNotMatch(formCard, /Answer: \/workflow connect/);
		assert.match(lines[0] ?? "", /needs attention/);

		const answerOwners = new Map<number, string>();
		for (const range of layout.runs) {
			const card = lines.slice(range.start, range.end);
			for (const [offset, line] of card.entries()) {
				if (!line.includes("Answer: /workflow connect")) continue;
				const absolute = range.start + offset;
				assert.equal(answerOwners.has(absolute), false, `answer row ${absolute} reused`);
				answerOwners.set(absolute, range.id);
			}
		}
		assert.equal(answerOwners.size, 1);
		assert.deepEqual([...answerOwners.values()], [uniqueId]);
		for (const [absolute, ownerId] of answerOwners) {
			const owners = layout.runs.filter((range) => absolute >= range.start && absolute < range.end);
			assert.deepEqual(
				owners.map((range) => range.id),
				[ownerId],
			);
		}

		broker.clearStagePrompt(uniqueId, "ask");
		assert.equal(store.recordStageAwaitingInput(uniqueId, "ask", false), true);
		assert.equal(store.runs().find((run) => run.id === uniqueId)?.stages[0]?.inputRequest, undefined);
		const afterUniqueLayout: WorkflowWidgetRowLayout = { runs: [] };
		const afterUniqueClear = buildThemedWidgetLines(store.snapshot(), undefined, 180, Date.now(), afterUniqueLayout);
		assert.doesNotMatch(rangeCard(afterUniqueClear, afterUniqueLayout, uniqueId), /Ready to continue/);
		assert.doesNotMatch(rangeCard(afterUniqueClear, afterUniqueLayout, uniqueId), /Answer: \/workflow connect/);
		assert.doesNotMatch(rangeCard(afterUniqueClear, afterUniqueLayout, formId), /Answer: \/workflow connect/);

		broker.clearStagePrompt(formId, "ask");
		assert.equal(store.recordStageAwaitingInput(formId, "ask", false), true);
		assert.equal(store.runs().find((run) => run.id === formId)?.stages[0]?.inputRequest, undefined);
		const clearedLayout: WorkflowWidgetRowLayout = { runs: [] };
		const cleared = buildThemedWidgetLines(store.snapshot(), undefined, 180, Date.now(), clearedLayout);
		assert.doesNotMatch(rangeCard(cleared, clearedLayout, uniqueId), /Ready to continue/);
		assert.doesNotMatch(rangeCard(cleared, clearedLayout, formId), /First structured field/);
		assert.doesNotMatch(cleared.join("\n"), /Answer: \/workflow connect/);

		store.removeRun(uniqueId);
		store.removeRun(formId);
		runIds.delete(uniqueId);
		runIds.delete(formId);
	};

	assertIsolation("form-first");
	assertIsolation("unique-first");
});
