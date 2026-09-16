import assert from "node:assert/strict";
import { test } from "vitest";
import { createPromptCardState, renderPromptCard } from "../../packages/workflows/src/tui/prompt-card.js";
import { assertNoRawControls } from "../helpers/terminal-controls.js";
import {
	CURSOR_MARKER,
	createStore,
	deriveGraphTheme,
	makeHandle,
	makePendingPrompt,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

const payload = "Polaris 雪\x1b]0;ACTIVE\x07\x1b]2;ST\x1b\\\x9d0;C1\x9c\x1b[31m\x1b[2J\x9b2J\x00\x08\x0d\x7fZ";

function assertSafe(view: StageChatView): void {
	for (const width of [40, 120, 400]) {
		const visible = assertNoRawControls(view.render(width).join("\n"), {
			markers: [CURSOR_MARKER],
			allowSgr: true,
		});
		if (width === 400) {
			assert.ok(visible.includes("Polaris 雪"));
			assert.ok(visible.includes("\\x1b[31m"), "injected styling is literal text");
		}
	}
}

for (const kind of ["input", "editor"] as const) {
	for (const native of [true, false]) {
		test(`active ${kind} native=${native} escapes initial and retained drafts while editing raw values`, () => {
			const store = createStore();
			setupRun(store, "run-1", "stage-a");
			const prompt = makePendingPrompt({ kind, message: "Safe question", initial: payload });
			store.recordStagePendingPrompt("run-1", "stage-a", prompt);
			const { handle } = makeHandle();
			const open = () =>
				new StageChatView({
					store,
					graphTheme: deriveGraphTheme({}),
					runId: "run-1",
					stageId: "stage-a",
					workflowName: "test",
					handle,
					onDetach() {},
					onClose() {},
					...(native ? { piTui: { requestRender() {}, terminal: { rows: 60, columns: 400 } } as never } : {}),
				});
			let view = open();
			try {
				assertSafe(view);
				if (native)
					assert.ok(
						view.render(400).every((line) => !line.includes("\n")),
						"native multiline drafts stay in separate terminal rows",
					);
				view.handleInput("\x1b[D");
				view.handleInput("X");
				assertSafe(view);
				assert.ok(
					view.render(400).join("\n").includes("\x1b[1mZ\x1b[0m"),
					"cursor remains on the raw character after insertion",
				);
				// Native Editor already canonicalizes CR to LF when seeding text.
				const seeded = native ? payload.replaceAll("\r", "\n") : payload;
				const edited = `${seeded.slice(0, -1)}XZ`;
				assert.equal(store.getStagePromptDraft("run-1", "stage-a", prompt.id), edited);
				view.dispose();
				view = open();
				assertSafe(view);
				if (!native && kind === "editor") view.handleInput("\t");
				view.handleInput("\r");
				assert.equal(store.getStagePromptAnswer("run-1", "stage-a")?.value, edited);
				assert.equal(store.runs()[0]!.stages[0]!.promptFootprint?.initial, payload);
			} finally {
				view.dispose();
			}
		});
	}
}

for (const targetIndex of [1, 2]) {
	test(`active select escapes duplicate labels and submits raw choice at index ${targetIndex}`, () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const choice = "\x1b]0;ACTIVE\x07\x1b[31mPolaris 雪";
		const choices = [choice, "ordinary", choice];
		const prompt = makePendingPrompt({ kind: "select", message: "Safe question", choices });
		store.recordStagePendingPrompt("run-1", "stage-a", prompt);
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test",
			handle,
			onDetach() {},
			onClose() {},
		});
		try {
			assertSafe(view);
			for (let index = 0; index < targetIndex; index++) view.handleInput("\x1b[B");
			assertSafe(view);
			view.handleInput("\r");
			assert.equal(store.getStagePromptAnswer("run-1", "stage-a")?.value, choices[targetIndex]);
			assert.deepEqual(store.runs()[0]!.stages[0]!.promptFootprint?.choices, choices);
		} finally {
			view.dispose();
		}
	});
}

for (const kind of ["input", "select"] as const) {
	test(`compact ${kind} response summary escapes terminal controls`, () => {
		const state = createPromptCardState(
			makePendingPrompt({ kind, message: "Safe question", initial: payload, choices: [payload] }),
		);
		const lines = renderPromptCard({ state, theme: deriveGraphTheme({}), width: 400, maxRows: 5, cursorOn: true });
		const visible = assertNoRawControls(lines.join("\n"), { allowSgr: true });
		assert.ok(visible.includes("Polaris 雪"));
		assert.ok(visible.includes("\\x1b[31m"));
	});
}
