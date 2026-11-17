import { stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import {
	assert,
	createStore,
	deriveGraphTheme,
	flush,
	makeHandle,
	makePendingPrompt,
	makeTestTui,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

afterEach(() => {
	vi.useRealTimers();
});

test("a stage dialog with a deadline counts down in the stage chat and stops repainting once it settles", async () => {
	vi.useFakeTimers({ now: 1_000_000, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "pending");
	let renders = 0;
	const { handle } = makeHandle(undefined, [], "pending");
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(30),
		requestRender: () => {
			renders += 1;
		},
	});
	const shown = () => view.render(96).map(stripTerminalSequences).join("\n");
	try {
		const prompt = makePendingPrompt({
			kind: "confirm",
			source: "stage-dialog",
			message: "Allow deploy?\n\nDeploy to production",
			expiresAt: Date.now() + 5_000,
		});
		assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
		await flush();
		assert.match(shown(), /Allow deploy\? \(5s\)/);
		const beforeTicks = renders;
		vi.advanceTimersByTime(2_000);
		assert.ok(renders >= beforeTicks + 2, "the stage chat repaints each second while the deadline runs");
		assert.match(shown(), /Allow deploy\? \(3s\)/);
		assert.equal(store.resolveStagePendingPrompt("run-1", "stage-a", prompt.id, true), true);
		await flush();
		shown();
		const settled = renders;
		vi.advanceTimersByTime(5_000);
		assert.equal(renders, settled, "no countdown repaint outlives the settled prompt");
	} finally {
		view.dispose();
	}
});
