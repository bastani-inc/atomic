import assert from "node:assert/strict";
import { test } from "vitest";
import type { PendingPrompt } from "../../packages/workflows/src/shared/store-types.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import {
	createStore,
	deriveGraphTheme,
	FakePromptEditor,
	makeFakeKeybindings,
	makeHandle,
	makePendingPrompt,
	StageChatView,
	setupRun,
	stripAnsi,
} from "./stage-chat-view-helpers.js";

const RUN_ID = "339e05a4-2289-408e-9076-d1a348f582ae";
const WORKFLOW_NAME = "primitive-attribution";
const STAGE_NAME = "review-a";
const AWAITING_INPUT_TOP = /^╭ AWAITING INPUT(?: {2}\[stage: [^\]]+\])? ─*╮$/;

function assertWellFormedTopBorder(line: string, width: number, context: string): void {
	assert.equal(visibleWidth(line), width, `${context} display width`);
	assert.ok(line.startsWith("╭") && line.endsWith("╮"), `${context} missing corners: ${line}`);
	const inner = line.slice(1, -1);
	const fillStart = inner.search(/─/);
	const title = fillStart < 0 ? inner : inner.slice(0, fillStart);
	if (fillStart >= 0) {
		assert.match(inner.slice(fillStart), /^─+$/, `${context} malformed fill: ${line}`);
	}
	if (title.length === 0) return;
	assert.match(title, /AWAITING INPUT/, `${context} unexpected title: ${line}`);
	const labels = title.match(/\[stage: [^\]]+\]/g) ?? [];
	assert.ok(labels.length <= 1, `${context} duplicate labels: ${line}`);
	assert.doesNotMatch(title, /\[stage:\s*\]/, `${context} empty stage label: ${line}`);
	assert.doesNotMatch(title, /\[stage:[^\]]*$/, `${context} unclosed stage label: ${line}`);
}

function countStageLabels(text: string, stageName = STAGE_NAME): number {
	return text.split(`[stage: ${stageName}]`).length - 1;
}

for (const kind of ["input", "editor"] as const satisfies readonly PendingPrompt["kind"][]) {
	test(`attached-stage ${kind} prompt renders the full run identity above the primitive editor`, () => {
		const store = createStore();
		setupRun(store, RUN_ID, "stage-a");
		const question = kind === "input" ? "What value should the workflow use?" : "Explain the workflow decision.";
		const prompt = makePendingPrompt({ kind, message: question, initial: kind === "editor" ? "initial draft" : "" });
		assert.equal(store.recordStagePendingPrompt(RUN_ID, "stage-a", prompt), true);
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: RUN_ID,
			stageId: "stage-a",
			workflowName: WORKFLOW_NAME,
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: {
				requestRender: () => {},
				terminal: { rows: 32, columns: 100 },
			} as never,
			piTheme: {},
			piKeybindings: makeFakeKeybindings(),
			piEditorFactory: () => new FakePromptEditor(),
		});

		const lines = view.render(100).map((line) => stripAnsi(line));
		view.dispose();
		const bannerStarts = lines
			.map((line, index) => (AWAITING_INPUT_TOP.test(line) ? index : -1))
			.filter((index) => index >= 0);
		assert.equal(bannerStarts.length, 1, `${kind} must render exactly one AWAITING INPUT title`);
		assertWellFormedTopBorder(lines[bannerStarts[0]!]!, 100, `${kind} identity banner`);
		assert.equal(
			countStageLabels(lines[bannerStarts[0]!]!),
			1,
			`${kind} identity banner must include the stage label`,
		);
		const bannerStart = bannerStarts[0]!;
		const bannerEnd = lines.findIndex((line, index) => index > bannerStart && /^╰─+╯$/.test(line));
		assert.ok(bannerEnd > bannerStart, `${kind} attribution banner must have a bottom border`);
		const banner = lines.slice(bannerStart, bannerEnd + 1).join("\n");
		const rendered = lines.join("\n");

		assert.ok(banner.includes(RUN_ID), `${kind} attribution banner is missing the full run id:\n${rendered}`);
		assert.ok(
			banner.includes(WORKFLOW_NAME),
			`${kind} attribution banner is missing the workflow name:\n${rendered}`,
		);
		assert.equal(bannerEnd - bannerStart + 1, 4, `${kind} attribution banner must contain exactly two body rows`);
		assert.doesNotMatch(banner, new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const questionRow = lines.findIndex((line) => line.includes(question));
		const editorRow = lines.findIndex((line) => line.includes("fake-pi-editor:"));
		assert.ok(questionRow > bannerEnd, `${kind} question must remain below the attribution banner`);
		assert.ok(editorRow > bannerEnd, `${kind} primitive editor must remain below the attribution banner`);
	});
}

test("primitive prompt row budgets emit only complete attribution and editor boxes", () => {
	for (const kind of ["input", "editor"] as const satisfies readonly PendingPrompt["kind"][]) {
		for (let viewportRows = 1; viewportRows <= 24; viewportRows += 1) {
			const store = createStore();
			setupRun(store, RUN_ID, "stage-a");
			const prompt = makePendingPrompt({ kind, message: "Budgeted question", initial: "draft" });
			assert.equal(store.recordStagePendingPrompt(RUN_ID, "stage-a", prompt), true);
			const { handle } = makeHandle();
			const view = new StageChatView({
				store,
				graphTheme: deriveGraphTheme({}),
				runId: RUN_ID,
				stageId: "stage-a",
				workflowName: WORKFLOW_NAME,
				handle,
				onDetach: () => {},
				onClose: () => {},
				piTui: {
					requestRender: () => {},
					terminal: { rows: viewportRows, columns: 100 },
				} as never,
				piTheme: {},
				piKeybindings: makeFakeKeybindings(),
				piEditorFactory: () => new FakePromptEditor(),
			});

			const lines = view.render(100).map((line) => stripAnsi(line));
			view.dispose();
			let boxOpen = false;
			for (const line of lines) {
				if (line.startsWith("╭")) {
					assert.equal(boxOpen, false, `${kind} rows=${viewportRows} opens a box before closing the previous one`);
					assertWellFormedTopBorder(line, 100, `${kind} rows=${viewportRows}`);
					boxOpen = true;
				}
				if (line.startsWith("╰")) {
					assert.equal(boxOpen, true, `${kind} rows=${viewportRows} closes a box before opening one`);
					assert.match(line, /^╰─+╯$/);
					boxOpen = false;
				}
			}
			assert.equal(boxOpen, false, `${kind} rows=${viewportRows} leaves a prompt box unclosed`);

			const rendered = lines.join("\n");
			if (rendered.includes(RUN_ID.slice(0, 8))) {
				assert.ok(rendered.includes(RUN_ID), `${kind} rows=${viewportRows} has a partial run id`);
				assert.ok(rendered.includes(WORKFLOW_NAME), `${kind} rows=${viewportRows} has a partial workflow identity`);
			}
			if (viewportRows === 14) {
				assert.ok(rendered.includes(RUN_ID), `${kind} must shrink prompt spacing before omitting attribution`);
				assert.ok(rendered.includes("Budgeted question"), `${kind} question must remain below a compact banner`);
				assert.ok(rendered.includes("fake-pi-editor:"), `${kind} editor must remain below a compact banner`);
			}
			// The primitive path degrades through the same three rungs as the standard
			// prompt surface. Row 10 is the middle rung, which this path was missing:
			// the run id survives alone once both identity rows no longer fit.
			if (viewportRows === 10) {
				assert.ok(rendered.includes(RUN_ID), `${kind} must keep the run id on the middle rung`);
				assert.match(rendered, /╭ AWAITING INPUT /, `${kind} must retain the complete interactive prompt box`);
				assert.ok(rendered.includes("Budgeted question"), `${kind} question must survive banner degradation`);
				assert.ok(rendered.includes("fake-pi-editor:"), `${kind} editor must survive banner degradation`);
			}
			if (viewportRows === 9) {
				assert.doesNotMatch(
					rendered,
					new RegExp(RUN_ID),
					`${kind} must drop attribution entirely below the middle rung`,
				);
				assert.ok(rendered.includes("Budgeted question"), `${kind} question must survive attribution omission`);
				assert.ok(rendered.includes("fake-pi-editor:"), `${kind} editor must survive attribution omission`);
				assert.equal(
					countStageLabels(rendered),
					1,
					`${kind} must keep one stage label on the remaining AWAITING INPUT box`,
				);
			}
			for (const line of lines) {
				if (line.startsWith("╭") && line.includes("AWAITING INPUT")) {
					assert.ok(
						countStageLabels(line) >= 1,
						`${kind} rows=${viewportRows} unlabeled boxed AWAITING INPUT: ${line}`,
					);
				}
			}
		}
	}
});

test("primitive prompt stage labels truncate wide Unicode names without overflowing", () => {
	const unicodeName = `${"审".repeat(40)}-é-👩‍💻`;
	for (const width of [40, 60, 80, 100, 120] as const) {
		const store = createStore();
		store.recordRunStart({
			id: RUN_ID,
			name: WORKFLOW_NAME,
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart(RUN_ID, {
			id: "stage-a",
			name: unicodeName,
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		const prompt = makePendingPrompt({ kind: "input", message: "Budgeted question" });
		assert.equal(store.recordStagePendingPrompt(RUN_ID, "stage-a", prompt), true);
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: RUN_ID,
			stageId: "stage-a",
			workflowName: WORKFLOW_NAME,
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: {
				requestRender: () => {},
				terminal: { rows: 32, columns: width },
			} as never,
			piTheme: {},
			piKeybindings: makeFakeKeybindings(),
			piEditorFactory: () => new FakePromptEditor(),
		});
		const lines = view.render(width).map((line) => stripAnsi(line));
		view.dispose();
		const top = lines.find((line) => line.startsWith("╭") && line.includes("AWAITING INPUT"));
		assert.ok(top, `width=${width} missing AWAITING INPUT top`);
		assertWellFormedTopBorder(top!, Math.max(40, width), `unicode width=${width}`);
		assert.match(top!, /\[stage: /);
		if (width <= 80) assert.ok(top!.includes("…"), `width=${width} should truncate a wide name`);
	}
});
