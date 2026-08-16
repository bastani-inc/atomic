import { TRANSCRIPT_JUMP_TO_END_URL } from "@bastani/atomic";

import { getKeybindings, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import {
	assert,
	createStore,
	deriveGraphTheme,
	fakeFooterAgentSession,
	flush,
	makeHandle,
	makePendingPrompt,
	makeTestTui,
	StageChatView,
	setupRun,
} from "./stage-chat-view-helpers.js";

async function makeScrollableStageChatFixture(
	rows: number | (() => number | undefined) = 12,
	withFooter = false,
	piKeybindings?: unknown,
): Promise<{
	store: ReturnType<typeof createStore>;
	view: StageChatView;
	handle: ReturnType<typeof makeHandle>["handle"];
}> {
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "pending");
	const { handle } = withFooter ? makeHandle(undefined, [], "pending", fakeFooterAgentSession()) : makeHandle();
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(rows),
		piKeybindings,
		footerData: withFooter
			? {
					getGitBranch: () => "main",
					getExtensionStatuses: () => new Map(),
					getAvailableProviderCount: () => 1,
					onBranchChange: () => () => {},
				}
			: undefined,
	});
	for (let i = 0; i < 18; i++) {
		for (const ch of `follow-msg-${i}`) view.handleInput(ch);
		view.handleInput("\r");
		await flush();
		await flush();
	}
	return { store, view, handle };
}

async function makeScrollableStageChat(
	rows: number | (() => number | undefined) = 12,
	withFooter = false,
): Promise<StageChatView> {
	return (await makeScrollableStageChatFixture(rows, withFooter)).view;
}
async function makeReadOnlyArchiveStageChatFixture(
	rows: number | (() => number | undefined) = 12,
): Promise<Awaited<ReturnType<typeof makeScrollableStageChatFixture>>> {
	const fixture = await makeScrollableStageChatFixture(rows);
	const stage = fixture.store.runs()[0]?.stages[0];
	assert.ok(stage);
	fixture.store.recordStageEnd("run-1", { ...stage, status: "completed", endedAt: Date.now() });
	Object.defineProperty(fixture.handle, "isDisposed", { value: true });
	return fixture;
}

describe("StageChatView", () => {
	test("expands the chat surface to the reported viewport row count", () => {
		// Full-screen overlay: when the host surfaces terminal.rows
		// Full-screen overlay: when the host surfaces terminal.rows,
		// the renderer must paint that many lines so the popup fills the terminal.
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(44),
		});
		const lines = view.render(96);
		assert.equal(lines.length, 44);
		view.dispose();
	});

	test("transcript body grows with the viewport so more entries stay visible", async () => {
		// The transcript body is `viewportRows - HEADER - INPUT - FOOTER`.
		// A larger viewport must surface more transcript entries inside
		// the body band; the fixed 32-row default would clip them.
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const { handle, state } = makeHandle();

		// Seed enough transcript entries that the 32-row body truncates; a
		// larger viewport must render strictly more message content even now
		// that Pi user-message boxes consume multiple terminal rows each.
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(60),
		});
		for (let i = 0; i < 30; i++) {
			for (const ch of `msg-${i}`) view.handleInput(ch);
			view.handleInput("\r");
			await flush();
			await flush();
		}
		// Sanity: stub handle recorded each prompt.
		assert.equal(state.promptCalls.length, 30);

		const wideText = view.render(96).join("\n");
		const wideOccurrences = wideText.split("\n").filter((line) => line.includes("msg-")).length;
		const narrow = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});
		for (const entry of view._transcript) {
			for (const ch of entry.text) narrow.handleInput(ch);
			narrow.handleInput("\r");
			await flush();
			await flush();
		}
		const narrowOccurrences = narrow
			.render(96)
			.join("\n")
			.split("\n")
			.filter((line) => line.includes("msg-")).length;
		assert.ok(
			wideOccurrences > narrowOccurrences,
			`expected wider viewport to show more entries (${wideOccurrences} <= ${narrowOccurrences})`,
		);
		narrow.dispose();
		view.dispose();
	});

	test("PageUp and PageDown scroll attached chat history", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});

		for (let i = 0; i < 18; i++) {
			for (const ch of `scroll-msg-${i}`) view.handleInput(ch);
			view.handleInput("\r");
			await flush();
			await flush();
		}

		const bottomText = view.render(96).join("\n");
		assert.match(bottomText, /scroll-msg-17/);
		assert.doesNotMatch(bottomText, /scroll-msg-0/);
		assert.ok(view._lastBodyMaxScroll > 0);

		view.handleInput("\x1b[5~");
		const offsetAfterPageUp = view._bodyScrollFromBottom;
		const olderText = view.render(96).join("\n");
		assert.ok(offsetAfterPageUp > 0);
		assert.notEqual(olderText, bottomText);

		view.handleInput("\x1b[6~");
		view.render(96);
		assert.equal(view._bodyScrollFromBottom, 0);
		view.dispose();
	});

	test("mouse wheel scrolls history without typing SGR bytes into the editor", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});

		for (let i = 0; i < 18; i++) {
			for (const ch of `wheel-msg-${i}`) view.handleInput(ch);
			view.handleInput("\r");
			await flush();
			await flush();
		}
		view.render(96);

		view.handleInput("\x1b[<64;10;10M");
		view.render(96);
		assert.ok(view._bodyScrollFromBottom > 0);

		const before = view._inputBuffer;
		view.handleInput("\x1b[<0;10;10M");
		assert.equal(view._inputBuffer, before);
		view.dispose();
	});
	test("hides the follow indicator and preserves the prompt card while awaiting input", async () => {
		const { store, view } = await makeScrollableStageChatFixture(16);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);

		assert.equal(
			store.recordStagePendingPrompt("run-1", "stage-a", makePendingPrompt({ id: "scrolled-prompt" })),
			true,
		);
		const scrolledPrompt = view.render(96).map(stripTerminalSequences);
		assert.doesNotMatch(scrolledPrompt.join("\n"), /Jump to bottom/);

		const { handle } = makeHandle();
		const controlView = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(16),
		});
		const controlPrompt = controlView.render(96).map(stripTerminalSequences);
		const controlBanner = controlPrompt.find((line) => line.includes("AWAITING INPUT"));
		const scrolledBanner = scrolledPrompt.find((line) => line.includes("AWAITING INPUT"));
		assert.ok(controlBanner);
		assert.equal(scrolledBanner, controlBanner);
		controlView.dispose();
		view.dispose();
	});

	test("keeps the follow indicator suppressed in a blocked stage chat", async () => {
		const { store, view } = await makeScrollableStageChatFixture(16);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);
		assert.equal(store.recordStageBlocked("run-1", "stage-a", "upstream-stage"), true);

		const blocked = view.render(96).map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(blocked, /Jump to bottom/);
		assert.match(blocked, /BLOCKED/);
		view.dispose();
	});
	test("shows the follow indicator in paused stage chat when scrolled", async () => {
		const { store, view } = await makeScrollableStageChatFixture(16);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);
		assert.equal(store.recordStagePaused("run-1", "stage-a"), true);

		const paused = view.render(96).map(stripTerminalSequences).join("\n");
		assert.match(paused, /Jump to bottom \(end\) ↓/);
		assert.match(paused, /PAUSED/);
		assert.equal(view.handleInput("\x1b[F"), true);
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(view.render(96).map(stripTerminalSequences).join("\n"), /Jump to bottom/);
		view.dispose();
	});
	test("drops the paused indicator before its callout rows in a tight viewport", async () => {
		let rows = 16;
		const { store, view } = await makeScrollableStageChatFixture(() => rows);
		view.render(96);
		assert.equal(store.recordStagePaused("run-1", "stage-a"), true);
		const control = view.render(96).map(stripTerminalSequences);
		assert.equal(view.handleInput("\x1b[5~"), true);
		rows = 9;

		const tight = view.render(96).map(stripTerminalSequences);
		assert.doesNotMatch(tight.join("\n"), /Jump to bottom/);
		assert.match(tight.join("\n"), /PAUSED/);
		assert.match(tight.join("\n"), /This workflow stage is paused\./);
		assert.equal(tight.length, 9);
		for (const marker of ["PAUSED", "This workflow stage is paused."]) {
			assert.equal(
				tight.find((line) => line.includes(marker)),
				control.find((line) => line.includes(marker)),
			);
		}
		view.dispose();
	});

	test("hides the follow indicator at the paused live end", async () => {
		const { store, view } = await makeScrollableStageChatFixture(16);
		view.render(96);
		assert.equal(store.recordStagePaused("run-1", "stage-a"), true);

		const paused = view.render(96).map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(paused, /Jump to bottom/);
		assert.match(paused, /PAUSED/);
		view.dispose();
	});

	test("shows the follow indicator in a read-only archive when scrolled and returns on the bound key", async () => {
		const { view } = await makeReadOnlyArchiveStageChatFixture(16);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);

		const scrolled = view.render(96).map(stripTerminalSequences).join("\n");
		assert.match(scrolled, /Jump to bottom \(end\) ↓/);
		assert.match(scrolled, /READ-ONLY SESSION/);

		assert.equal(view.handleInput("\x1b[F"), true);
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(view.render(96).map(stripTerminalSequences).join("\n"), /Jump to bottom/);
		view.dispose();
	});

	test("hides the follow indicator at the read-only archive live end", async () => {
		const { view } = await makeReadOnlyArchiveStageChatFixture(16);
		view.render(96);

		const archive = view.render(96).map(stripTerminalSequences).join("\n");
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(archive, /Jump to bottom/);
		assert.match(archive, /READ-ONLY SESSION/);
		view.dispose();
	});
	test("keeps the follow indicator suppressed for a scrolled read-only prompt archive", async () => {
		const { store, view } = await makeReadOnlyArchiveStageChatFixture(16);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);

		const archivedStage = store.runs()[0]?.stages[0];
		assert.ok(archivedStage);
		store.recordStageEnd("run-1", { ...archivedStage, status: "running", endedAt: undefined });
		const prompt = makePendingPrompt({ id: "archived-prompt", message: "Archived prompt question?" });
		assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", prompt), true);
		const promptedStage = store.runs()[0]?.stages[0];
		assert.ok(promptedStage);
		store.recordStageEnd("run-1", { ...promptedStage, status: "completed", endedAt: Date.now() });

		const archived = view.render(96).map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(archived, /Jump to bottom/);
		assert.match(archived, /QUESTION ASKED/);
		assert.match(archived, /Archived prompt question\?/);
		view.dispose();
	});
	test("drops the read-only archive indicator before its callout rows in a tight viewport", async () => {
		let rows = 16;
		const { view } = await makeReadOnlyArchiveStageChatFixture(() => rows);
		view.render(96);
		const control = view.render(96).map(stripTerminalSequences);
		assert.equal(view.handleInput("\x1b[5~"), true);
		rows = 7;

		const tight = view.render(96).map(stripTerminalSequences);
		assert.doesNotMatch(tight.join("\n"), /Jump to bottom/);
		assert.match(tight.join("\n"), /READ-ONLY SESSION/);
		assert.match(tight.join("\n"), /This node is no longer attached/);
		assert.equal(tight.length, 7);
		for (const marker of ["READ-ONLY SESSION", "This node is no longer attached"]) {
			assert.equal(
				tight.find((line) => line.includes(marker)),
				control.find((line) => line.includes(marker)),
			);
		}
		view.dispose();
	});
	test("hides the follow indicator after a live transcript resize clamps to the end", async () => {
		let rows = 12;
		const view = await makeScrollableStageChat(() => rows);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);

		rows = 200;
		const grown = view.render(96).map(stripTerminalSequences);
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(grown.join("\n"), /Jump to bottom/);
		assert.equal(grown.length, 200);
		view.dispose();
	});

	test("hides the follow indicator after a paused transcript resize clamps to the end", async () => {
		let rows = 12;
		const { store, view } = await makeScrollableStageChatFixture(() => rows);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);
		assert.equal(store.recordStagePaused("run-1", "stage-a"), true);

		rows = 200;
		const grown = view.render(96).map(stripTerminalSequences);
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(grown.join("\n"), /Jump to bottom/);
		assert.equal(grown.length, 200);
		view.dispose();
	});

	test("hides the follow indicator after an archive transcript resize clamps to the end", async () => {
		let rows = 12;
		const { view } = await makeReadOnlyArchiveStageChatFixture(() => rows);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.ok(view._bodyScrollFromBottom > 0);

		rows = 200;
		const grown = view.render(96).map(stripTerminalSequences);
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(grown.join("\n"), /Jump to bottom/);
		assert.equal(grown.length, 200);
		view.dispose();
	});

	test("uses and honors a remapped stage-chat jump-to-bottom binding", async () => {
		const previousKeybindings = getKeybindings();
		const keybindings = new KeybindingsManager({ "tui.altScreen.bottom": "ctrl+e" });
		setKeybindings(keybindings);
		let view: StageChatView | undefined;
		try {
			({ view } = await makeScrollableStageChatFixture(12, false, keybindings));
			view.render(96);
			assert.equal(view.handleInput("\x1b[5~"), true);
			const scrolled = stripTerminalSequences(view.render(96).join("\n"));
			assert.match(scrolled, /Jump to bottom \(ctrl\+e\) ↓/);

			assert.equal(view.handleInput("\x05"), true);
			assert.equal(view._bodyScrollFromBottom, 0);
			assert.doesNotMatch(stripTerminalSequences(view.render(96).join("\n")), /Jump to bottom/);
		} finally {
			view?.dispose();
			setKeybindings(previousKeybindings);
		}
	});

	test("hides the follow indicator at the pristine live end without consuming a body row", async () => {
		const view = await makeScrollableStageChat();
		const bottom = view.render(96);
		const visibleLines = bottom.map(stripTerminalSequences);

		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(visibleLines.join("\n"), /Jump to bottom/);
		assert.match(visibleLines[2] ?? "", /follow-msg-16/);
		assert.match(visibleLines[6] ?? "", /follow-msg-17/);
		assert.equal(bottom.length, 12);
		view.dispose();
	});

	test("shows the shared follow indicator after scrolling stage-chat history", async () => {
		const view = await makeScrollableStageChat();
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		const scrolled = view.render(96);
		const visible = stripTerminalSequences(scrolled.join("\n"));

		assert.ok(view._bodyScrollFromBottom > 0);
		assert.match(visible, /Jump to bottom \(end\) ↓/);
		assert.equal(scrolled.length, 12);
		view.dispose();
	});

	test("keeps the transcript viewport size stable while the follow indicator is visible", async () => {
		const view = await makeScrollableStageChat(13);
		view.render(96);

		assert.equal(view.handleInput("\x1b[5~"), true);
		const scrolled = view.render(96);
		assert.ok(view._bodyScrollFromBottom > 0);
		assert.match(stripTerminalSequences(scrolled.join("\n")), /Jump to bottom \(end\) ↓/);
		assert.equal(scrolled.length, 13);

		assert.equal(view.handleInput("\x1b[6~"), true);
		view.render(96);
		assert.equal(view._bodyScrollFromBottom, 0);
		view.dispose();
	});

	test("the OSC-8 jump URL returns stage chat to its live end", async () => {
		const view = await makeScrollableStageChat();
		view.render(96);
		view.handleInput("\x1b[5~");
		assert.ok(view._bodyScrollFromBottom > 0);

		assert.equal(view.handleInput(TRANSCRIPT_JUMP_TO_END_URL), true);
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(stripTerminalSequences(view.render(96).join("\n")), /Jump to bottom/);
		view.dispose();
	});

	test("handles the OSC-8 jump before a mounted custom UI can consume it", async () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a", "pending");
		const broker = new StageUiBroker(store);
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
			piTui: makeTestTui(12),
			piTheme: {},
			piKeybindings: new KeybindingsManager(),
			canSubmitPrompt: () => false,
			stageUiBroker: broker,
		});
		const customInputs: string[] = [];
		const abortController = new AbortController();
		try {
			for (let index = 0; index < 18; index += 1) {
				for (const character of `custom-jump-msg-${index}`) view.handleInput(character);
				view.handleInput("\r");
				await flush();
			}
			view.render(96);
			view.handleInput("\x1b[5~");
			assert.ok(view._bodyScrollFromBottom > 0);

			const pending = broker.requestCustomUi(
				"run-1",
				"stage-a",
				() => ({
					render: () => ["custom question"],
					handleInput: (data: string) => {
						customInputs.push(data);
						return true;
					},
					invalidate: () => {},
				}),
				undefined,
				abortController.signal,
			);
			pending.catch(() => {});
			await flush();

			assert.match(stripTerminalSequences(view.render(96).join("\n")), /custom question/);
			assert.equal(view.handleInput(TRANSCRIPT_JUMP_TO_END_URL), true);
			assert.equal(view._bodyScrollFromBottom, 0);
			assert.deepEqual(customInputs, []);
		} finally {
			abortController.abort();
			view.dispose();
		}
	});

	test("handles the OSC-8 jump before a pending prompt editor can consume it", async () => {
		const fixture = await makeScrollableStageChatFixture();
		const { store, view } = fixture;
		try {
			view.render(96);
			view.handleInput("\x1b[5~");
			assert.ok(view._bodyScrollFromBottom > 0);
			assert.equal(store.recordStagePendingPrompt("run-1", "stage-a", makePendingPrompt()), true);
			view.render(96);
			const promptEditor = (view as unknown as { promptEditor: { getText(): string } | null }).promptEditor;
			assert.ok(promptEditor);

			assert.equal(view.handleInput(TRANSCRIPT_JUMP_TO_END_URL), true);
			assert.equal(view._bodyScrollFromBottom, 0);
			assert.equal(promptEditor.getText(), "");
		} finally {
			view.dispose();
		}
	});

	test("the bound end key returns stage chat to the live end and hides the indicator", async () => {
		const view = await makeScrollableStageChat();
		view.render(96);
		view.handleInput("\x1b[5~");
		assert.match(stripTerminalSequences(view.render(96).join("\n")), /Jump to bottom \(end\) ↓/);

		assert.equal(view.handleInput("\x1b[F"), true);
		const bottom = view.render(96);
		const visible = stripTerminalSequences(bottom.join("\n"));
		assert.equal(view._bodyScrollFromBottom, 0);
		assert.doesNotMatch(visible, /Jump to bottom/);
		assert.equal(bottom.length, 12);
		view.dispose();
	});

	test("drops the indicator before the composer and footer in a tight viewport", async () => {
		let rows = 12;
		const view = await makeScrollableStageChat(() => rows, true);
		view.render(96);
		assert.equal(view.handleInput("\x1b[5~"), true);
		assert.match(stripTerminalSequences(view.render(96).join("\n")), /Jump to bottom \(end\) ↓/);

		rows = 8;
		const tight = view.render(96);
		const visible = stripTerminalSequences(tight.join("\n"));
		assert.ok(view._bodyScrollFromBottom > 0);
		assert.doesNotMatch(visible, /Jump to bottom/);
		assert.ok(visible.includes("❯"), "composer must survive the tight viewport");
		assert.match(visible, /ctrl\+x return to graph/);
		assert.equal(tight.length, 8);
		view.dispose();
	});
});
