import { test } from "vitest";
import { assertNoRawControls } from "../helpers/terminal-controls.js";
import {
	assert,
	createStore,
	deriveGraphTheme,
	makePendingPrompt,
	makeTestTui,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

// PR #2700 LIVE-U2: completing a prompt must not reopen terminal-control injection.
for (const kind of ["input", "editor", "select"] as const) {
	test(`completed ${kind} archive escapes controls without changing retained prompt or answer`, () => {
		const payload =
			"Polaris 雪\nsecond line\t\x1b]0;ARCHIVE-BEL\x07\x1b]2;ARCHIVE-ST\x1b\\\x1b[2J\x1b[31m" +
			"\x9d2;ARCHIVE-C1\x9c\x9b2J\x00\x01\x08\x0d\x7f";
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const prompt = makePendingPrompt({
			kind,
			message: `MESSAGE ${payload}`,
			initial: `INITIAL ${payload}`,
			choices: [`CHOICE ${payload}`, "ordinary", `CHOICE ${payload}`],
		});
		const response = `ANSWER ${payload}`;
		assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
		assert.equal(store.resolveStagePendingPrompt("run-1", "stage-a", prompt.id, response), true);
		const stage = store.runs()[0]!.stages[0]!;
		store.recordStageEnd("run-1", { ...stage, status: "completed", endedAt: Date.now(), durationMs: 1 });
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle: undefined,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(100),
		});
		try {
			const raw = view.render(400).join("\n");
			// Permit renderer-owned SGR only; OSC/CSI and C0/C1 are never stripped by the oracle.
			const visible = assertNoRawControls(raw, { allowSgr: true });
			for (const label of ["MESSAGE", kind === "select" ? "CHOICE" : "INITIAL", "ANSWER"]) {
				assert.ok(visible.includes(`${label} Polaris 雪`));
			}
			assert.ok(visible.includes("second line \\x1b]0;ARCHIVE-BEL\\x07\\x1b]2;ARCHIVE-ST\\x1b\\"));
			assert.ok(visible.includes("\\x1b[2J\\x1b[31m\\x9d2;ARCHIVE-C1\\x9c\\x9b2J\\x00\\x01\\x08\\x0d\\x7f"));
			assert.deepEqual(store.runs()[0]!.stages[0]!.promptFootprint, prompt);
			assert.equal(store.getStagePromptAnswer("run-1", "stage-a")!.value, response);
			assert.deepEqual(prompt.choices, [`CHOICE ${payload}`, "ordinary", `CHOICE ${payload}`]);
			assert.equal(JSON.stringify(store.snapshot()).includes("ANSWER"), false);
		} finally {
			view.dispose();
		}
	});
}
