import assert from "node:assert/strict";
import { test } from "vitest";
import type { PendingPrompt } from "../../packages/workflows/src/shared/store-types.js";
import { assertNoRawControls } from "../helpers/terminal-controls.js";
import {
	CURSOR_MARKER,
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
			.map((line, index) => (/^╭ AWAITING INPUT ─*╮$/.test(line) ? index : -1))
			.filter((index) => index >= 0);
		assert.equal(bannerStarts.length, 1, `${kind} must render exactly one AWAITING INPUT title`);
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
					assert.match(line, /^╭(?: AWAITING INPUT )?─+╮$/);
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
			}
		}
	}
});

// PR2700 LIVE-U2: exercise the attached primitive rendering sink, not just a sanitizer.
for (const { kind, primitive } of [
	{ kind: "input", primitive: true },
	{ kind: "editor", primitive: true },
	{ kind: "input", primitive: false },
	{ kind: "editor", primitive: false },
] as const) {
	test(`attached ${kind} prompt primitive=${primitive} renders terminal controls inert and preserves response submission`, () => {
		const store = createStore();
		setupRun(store, RUN_ID, "stage-a");
		const message =
			"\x1b]0;PR2700_TITLE_INJECTION\x07Readable Ω 中文\n" +
			"\x1b]2;ST_TITLE\x1b\\Second line\n" +
			"\x9d0;C1_TITLE\x9c\x1b[31mRed\x1b[0m \x9b2Jclear\n" +
			"\x00\x07\x08\x0d\x7f\x85Final text";
		const prompt = makePendingPrompt({ kind, message });
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
			...(primitive ? { piTui: { requestRender: () => {}, terminal: { rows: 60, columns: 160 } } as never } : {}),
			onClose: () => {},
			piTheme: {},
			piKeybindings: makeFakeKeybindings(),
			...(primitive ? { piEditorFactory: () => new FakePromptEditor() } : {}),
		});
		try {
			// Permit renderer-owned styles/cursor marker only, never controls from the prompt.
			const rendered = assertNoRawControls(view.render(160).join("\n"), {
				markers: [CURSOR_MARKER],
				allowSgr: true,
			});
			assert.ok(rendered.includes("\\x1b[31m"), "untrusted CSI styling must also be inert");
			for (const text of ["Readable Ω 中文", "Second line", "Red", "clear", "Final text"]) {
				assert.ok(rendered.includes(text), `legitimate text missing: ${text}`);
			}
			assert.equal(store.runs()[0]?.stages[0]?.pendingPrompt?.message, message);
			view.handleInput("Controls-Polaris");
			if (!primitive && kind === "editor") view.handleInput("\t");
			view.handleInput("\r");
			assert.equal(store.getStagePromptAnswer(RUN_ID, "stage-a")?.value, "Controls-Polaris");
		} finally {
			view.dispose();
		}
	});
}
