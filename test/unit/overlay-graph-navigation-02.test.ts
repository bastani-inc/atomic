// @ts-nocheck

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { GraphViewLayout, graphLayoutBodyRows } from "../../packages/workflows/src/tui/graph-view-layout.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const {
	makeStage,
	makeSnap,
	makeRunPromptSnap,
	makePendingPrompt,
	makeAwaitingInputStage,
	makeInputRequest,
	makeStore,
	makeRun,
	makeTestTui,
	defaultTheme,
	visibleText,
	typeIntoView,
	makeView,
} = h;

describe("GraphView keyboard navigation", () => {
	it("horizontally scrolls wide fan-out graphs instead of switching to a compact list", () => {
		const stages = [
			makeStage("root"),
			makeStage("child-0", ["root"]),
			makeStage("child-1", ["root"]),
			makeStage("child-2", ["root"]),
			makeStage("child-3", ["root"]),
			makeStage("child-4", ["root"]),
			makeStage("child-5", ["root"]),
		];
		const view = makeView(stages);

		assert.doesNotMatch(visibleText(view.render(80)), /╭.*child-5/);
		view.handleInput("\x1b[B");
		for (let i = 0; i < 5; i++) view.handleInput("\x1b[C");
		const afterNav = visibleText(view.render(80));
		assert.match(afterNav, /╭.*child-5/);
		assert.doesNotMatch(afterNav, /^\s*○ child-5\s+pending/m);
		view.dispose();
	});

	it("pans a wide graph horizontally without moving focus or vertical scroll", () => {
		const stages = [
			makeStage("root"),
			makeStage("child-0", ["root"]),
			makeStage("child-1", ["root"]),
			makeStage("child-2", ["root"]),
			makeStage("child-3", ["root"]),
			makeStage("child-4", ["root"]),
			makeStage("child-5", ["root"]),
		];
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store: makeStore(makeSnap(stages)),
			graphTheme: defaultTheme,
			piTui: makeTestTui(32),
		});

		const beforePan = visibleText(view.render(48));
		while (view._graphScrollColOffset > 0) {
			assert.equal(view.handleInput("\x1b[<66;10;10M"), true);
		}
		const verticalOffset = view._graphScrollOffset;

		assert.equal(view.handleInput("\x1b[<67;10;10M"), true);
		assert.ok(view._graphScrollColOffset > 0);
		assert.equal(view._graphScrollOffset, verticalOffset);
		assert.equal(view._focusedIndex, 0);
		const afterPan = visibleText(view.render(48));
		assert.ok(view._graphScrollColOffset > 0);
		assert.notEqual(afterPan, beforePan);

		assert.equal(view.handleInput("\x1b[<66;10;10M"), true);
		assert.equal(view._graphScrollColOffset, 0);

		const legacyWheelRight = `\x1b[M${String.fromCharCode(67 + 32)}**`;
		assert.equal(view.handleInput(legacyWheelRight), true);
		assert.ok(view._graphScrollColOffset > 0);
		assert.equal(view._graphScrollOffset, verticalOffset);
		assert.notEqual(visibleText(view.render(48)), beforePan);

		const legacyWheelLeft = `\x1b[M${String.fromCharCode(66 + 32)}**`;
		assert.equal(view.handleInput(legacyWheelLeft), true);
		assert.equal(view._graphScrollColOffset, 0);
		assert.equal(view._graphScrollOffset, verticalOffset);
		assert.equal(view._focusedIndex, 0);
		view.dispose();
	});

	it("keeps horizontal graph panning live while a run-level prompt is active", () => {
		const stages = [
			makeStage("root"),
			...Array.from({ length: 6 }, (_, index) => makeStage(`child-${index}`, ["root"])),
		];
		const store = makeStore(makeRunPromptSnap(stages, makePendingPrompt({ id: "legacy-prompt" })));
		const resolved: h.PromptResolution[] = [];
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(32),
			onPromptResolve: (runId, promptId, response) => {
				resolved.push({ runId, promptId, response });
			},
		});

		const beforePan = visibleText(view.render(48));
		assert.equal(view.handleInput("\x1b[<67;10;10M"), true);
		const afterPan = visibleText(view.render(48));
		assert.ok(view._graphScrollColOffset > 0);
		assert.notEqual(afterPan, beforePan);
		assert.deepEqual(resolved, []);

		typeIntoView(view, "answer");
		view.handleInput("\r");
		assert.deepEqual(resolved, [{ runId: "run-1", promptId: "legacy-prompt", response: "answer" }]);
		view.dispose();
	});

	it("render returns lines in overlay mode", () => {
		const stages = [makeStage("A"), makeStage("B", ["A"])];
		const view = makeView(stages);
		const lines = view.render(120);
		assert.equal(Array.isArray(lines), true);
		assert.ok(lines.length > 0);
		const text = visibleText(lines);
		assert.match(text, /↵ open stage chat/);
		assert.doesNotMatch(text, /↵ attach/);
		view.dispose();
	});

	it("render returns lines in widget mode", () => {
		const snap = makeSnap([makeStage("A")]);
		const store = makeStore(snap);
		const view = new GraphView({
			mode: "widget",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
		});
		const lines = view.render(80);
		assert.equal(Array.isArray(lines), true);
		assert.ok(lines.length > 0);
		view.dispose();
	});

	it("sizes an unhosted overlay from its layout content instead of a fixed frame", () => {
		const stages = [makeStage("A"), makeStage("B", ["A"])] as const;
		const view = makeView([...stages]);
		const lines = view.render(96);
		assert.equal(lines.length, 21);
		assert.ok(lines.length < 32, "a short graph must not use the old fixed rectangle");
		view.dispose();
	});
	it("tracks unhosted frame height with a large graph while keeping the body scrollable", () => {
		const stages = Array.from({ length: 400 }, (_, index) =>
			makeStage(`stage-${index}`, index === 0 ? [] : [`stage-${index - 1}`]),
		);
		const view = makeView(stages);
		const lines = view.render(96);
		assert.ok(lines.length >= 32, "a large graph must not collapse to a short fixed frame");
		assert.ok(lines.length > stages.length, "the natural frame must track graph content");
		assert.ok(lines.length < stages.length * 10, "the frame should use graph geometry, not one row per stage");
		view.dispose();
	});

	it("keeps unpainted margin rows around the layout root", () => {
		const stages = [makeStage("A"), makeStage("B", ["A"])] as const;
		const view = makeView([...stages]);
		const lines = view.render(96);
		assert.equal(lines[0], " ".repeat(96));
		assert.equal(lines.length, 21);
		assert.equal(lines.at(-1), " ".repeat(96));
		assert.match(visibleText(lines.slice(1, 4)), /ORCHESTRATOR/);
		assert.match(visibleText(lines.slice(-4, -1)), /GRAPH/);
		view.dispose();
	});
	it("keeps the ScrollView body box aligned with its viewport formula", () => {
		const layout = new GraphViewLayout({
			renderHeader: () => ["", "", ""],
			renderBody: (_width, _top, rows) => Array.from({ length: rows }, () => ""),
			renderFooter: () => ["", "", ""],
			bodyContentHeight: (_width, rows) => rows,
		});
		try {
			for (let height = 1; height <= 60; height++) {
				const frame = layout.render(96, height);
				assert.ok(frame.bodyBox, `layout should expose a body box at height ${height}`);
				assert.equal(frame.bodyBox.rect.height, graphLayoutBodyRows(height), `body height at ${height}`);
			}
		} finally {
			layout.dispose();
		}
	});
	it("reserves the scrollbar column only while the body overflows", () => {
		let overflowing = true;
		const layout = new GraphViewLayout({
			renderHeader: () => ["", "", ""],
			renderBody: (_width, _top, rows) => Array.from({ length: rows }, () => ""),
			renderFooter: () => ["", "", ""],
			bodyContentHeight: (_width, rows) => (overflowing ? rows + 1 : rows),
		});
		try {
			const overflowingFrame = layout.render(96, 20);
			assert.ok(overflowingFrame.bodyBox);
			assert.equal(overflowingFrame.bodyBox.children[0]?.rect.width, 95);
			assert.equal(overflowingFrame.scrollbar?.column, 95);

			overflowing = false;
			const fittedFrame = layout.render(96, 20);
			assert.ok(fittedFrame.bodyBox);
			assert.equal(fittedFrame.bodyBox.children[0]?.rect.width, 96);
			assert.equal(fittedFrame.scrollbar, undefined);
		} finally {
			layout.dispose();
		}
	});
	it("terminates pi-tui's above-viewport image scan after one hidden row", () => {
		const layout = new GraphViewLayout({
			renderHeader: () => ["", "", ""],
			renderBody: (_width, _top, rows) => Array.from({ length: rows }, () => "row"),
			renderFooter: () => ["", "", ""],
			bodyContentHeight: () => 5_000,
		});
		try {
			layout.render(96, 24);
			layout.scrollView.scrollTo(4_000);
			const frame = layout.render(96, 24);
			const content = frame.bodyBox?.scrollContentLines;
			const scrollTop = layout.scrollView.scrollTop;
			assert.ok(content && scrollTop > 0);
			assert.equal(content[scrollTop - 1], " ", "the sentinel must stop the scan at the viewport edge");
			assert.equal(content[scrollTop - 2], undefined, "rows above the sentinel remain unmaterialized");
			assert.equal(content.length, 5_000);
			assert.equal(frame.wrappedRows[frame.bodyBox!.rect.y], true, "painted body rows are tagged for normalization");
		} finally {
			layout.dispose();
		}
	});
	it("preserves content OSC-8 terminators and composite seam resets", () => {
		const view = makeView([makeStage("A")]);
		const wrapper = "\x1b[0m\x1b]8;;\x07";
		const content = "\x1b]8;;https://example.com\x07label\x1b[0m\x1b]8;;\x07";
		const [line] = view._normalizeLayoutLines([`${wrapper}${content}${wrapper}`], [true], 96, 1, 0, 0);
		assert.match(line, /\x1b\]8;;https:\/\/example\.com\x07label\x1b\[0m\x1b\]8;;\x07/);
		assert.equal((line.match(/\x1b\[0m\x1b\]8;;\x07/g) ?? []).length, 1);

		const sideBySide = `${wrapper}\x1b[41mleft${wrapper}\x1b[42mright${wrapper}`;
		const [composited] = view._normalizeLayoutLines([sideBySide], [true], 96, 1, 0, 0);
		assert.match(composited, /\x1b\[41mleft\x1b\[0m\x1b\]8;;\x07\x1b\[42mright/);

		const unwrapped = "\x1b]8;;https://example.com\x07label\x1b[0m\x1b]8;;\x07";
		const [kept] = view._normalizeLayoutLines([unwrapped], [false], 96, 1, 0, 0);
		assert.ok(kept.startsWith(unwrapped), "unwrapped content keeps its own OSC-8 terminator");
		assert.equal((kept.match(/\x1b\[0m\x1b\]8;;\x07/g) ?? []).length, 1);
		view.dispose();
	});

	it("expands overlay to the reported viewport row count", () => {
		// Full-screen overlay path: when the host surfaces terminal.rows
		// from the host TUI's terminal rows, the renderer must paint that many
		// lines so pi-tui anchors the popup as a full-frame overlay.
		const stages = [makeStage("A"), makeStage("B", ["A"])];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(48),
		});
		const lines = view.render(96);
		assert.equal(lines.length, 48);
		view.dispose();
	});

	it("respects short reported viewport rows and keeps status controls visible", () => {
		const stages = [makeStage("A")];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(10),
		});
		const lines = view.render(96);
		assert.equal(lines.length, 10);
		assert.match(visibleText(lines.slice(-4)), /GRAPH/);
		view.dispose();
	});

	it("keeps tiny terminal frames bounded while shrinking chrome", () => {
		let rows = 5;
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store: makeStore(makeSnap([makeStage("tiny")])),
			graphTheme: defaultTheme,
			piTui: makeTestTui(() => rows),
		});
		for (rows of [5, 3, 1]) {
			const lines = view.render(96);
			assert.equal(lines.length, rows);
			assert.ok(lines.every((line) => visibleWidth(line) === 96));
		}
		view.dispose();
	});

	it("reflows the ScrollView body across terminal resize without losing graph scrolling", () => {
		const stages = Array.from({ length: 12 }, (_, index) =>
			makeStage(`resize-${index}`, index === 0 ? [] : [`resize-${index - 1}`]),
		);
		const store = makeStore(makeSnap(stages));
		let terminalRows = 10;
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(() => terminalRows),
		});

		assert.equal(view.render(96).length, 10);
		const shortScrollbar = view._graphScrollbarGeometry;
		assert.ok(shortScrollbar, "the short graph viewport has a ScrollView scrollbar");
		assert.equal(view.handleInput("\x1b[<65;1;1M"), true);
		view.render(96);
		assert.ok(view._graphScrollOffset > 0);

		terminalRows = 40;
		const tallLines = view.render(96);
		const tallScrollbar = view._graphScrollbarGeometry;
		assert.equal(tallLines.length, 40);
		assert.ok(tallScrollbar, "the taller graph viewport keeps a ScrollView scrollbar");
		assert.ok(tallScrollbar.trackHeight > shortScrollbar.trackHeight, "the scrollbar track follows the resized body");
		assert.match(visibleText(tallLines.slice(-4)), /GRAPH/);
		assert.ok(view._graphScrollOffset > 0, "a taller viewport keeps the still-valid ScrollView offset");
		assert.ok(view._graphScrollOffset <= tallScrollbar.maxScrollTop);

		terminalRows = 8;
		const shortLines = view.render(96);
		const resizedShortScrollbar = view._graphScrollbarGeometry;
		assert.equal(shortLines.length, 8);
		assert.ok(resizedShortScrollbar, "the short resized graph viewport keeps a scrollbar");
		assert.match(visibleText(shortLines.slice(-4)), /GRAPH/);
		assert.ok(view._graphScrollOffset <= resizedShortScrollbar.maxScrollTop);
		view.dispose();
	});

	it("keeps the last hosted frame height while the host terminal disappears", () => {
		let terminalRows: number | undefined = 40;
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store: makeStore(makeSnap([makeStage("lifecycle")])),
			graphTheme: defaultTheme,
			piTui: makeTestTui(() => terminalRows),
		});

		assert.equal(view.render(96).length, 40);
		terminalRows = undefined;
		assert.equal(view.render(96).length, 40, "a torn-down terminal keeps the last hosted frame height");
		terminalRows = 12;
		assert.equal(view.render(96).length, 12, "a returning host resizes immediately");
		view.dispose();
	});
	it("hides unstarted placeholder stages while a prompt stage is awaiting input", () => {
		const stages = [
			makeStage("capture"),
			{
				...makeStage("input"),
				status: "awaiting_input" as const,
				startedAt: Date.now() - 1000,
				awaitingInputSince: Date.now() - 1000,
				attachable: true,
				pendingPrompt: {
					id: "prompt-1",
					kind: "input" as const,
					message: "Favorite color?",
					createdAt: Date.now() - 1000,
				},
			},
		];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(32),
		});

		const rendered = visibleText(view.render(96));
		assert.doesNotMatch(rendered, /capture/);
		assert.match(rendered, /input/);
		assert.match(rendered, /waiting for response/);
		view.dispose();
	});

	it("renders stage-local pending prompts as graph nodes without the global prompt overlay", () => {
		const stages = [
			{
				...makeStage("input"),
				status: "awaiting_input" as const,
				startedAt: Date.now() - 1000,
				awaitingInputSince: Date.now() - 1000,
				attachable: true,
				pendingPrompt: {
					id: "prompt-1",
					kind: "input" as const,
					message: "Your name?",
					createdAt: Date.now() - 1000,
				},
			},
		];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const onStageAttach = vi.fn(() => {});
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(32),
			onStageAttach,
		});

		const rendered = visibleText(view.render(96));
		assert.doesNotMatch(rendered, /AWAITING INPUT/);
		assert.match(rendered, /waiting for response/);
		assert.match(rendered, /enter to respond/);
		view.handleInput("\r");
		assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "input"]);
		view.dispose();
	});

	it("honors remapped select keybindings for run-level prompt cards", () => {
		const store = createStore();
		store.recordRunStart(makeRun([makeStage("prompt-owner")]));
		const prompt = {
			id: "prompt-select-1",
			kind: "select" as const,
			message: "Choose a branch.",
			choices: ["alpha", "beta", "gamma"],
			createdAt: Date.now(),
		};
		assert.equal(store.recordPendingPrompt("run-1", prompt), true);
		const resolved: Array<{ runId: string; promptId: string; response: unknown }> = [];
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(32),
			piKeybindings: makeFakeKeybindings({
				"tui.select.down": ["d"],
				"tui.select.confirm": ["s"],
			}),
			onPromptResolve: (runId, promptId, response) => {
				resolved.push({ runId, promptId, response });
				store.resolvePendingPrompt(runId, promptId, response);
			},
		});

		assert.equal(view.handleInput("d"), true);
		assert.deepEqual(resolved, []);
		assert.equal(store.runs()[0]?.pendingPrompt?.id, prompt.id);

		assert.equal(view.handleInput("\x1b[6~"), true, "raw PageDown remains owned by the select prompt");
		assert.equal(view.handleInput("\x1b[5~"), true, "raw PageUp remains owned by the select prompt");

		assert.equal(view.handleInput("s"), true);
		assert.deepEqual(resolved, [{ runId: "run-1", promptId: prompt.id, response: "beta" }]);
		assert.equal(store.runs()[0]?.pendingPrompt, undefined);
		view.dispose();
	});

	it("auto-focuses a newly awaiting stage prompt node so Enter attaches to the HIL UI", () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-1",
			name: "Test Run",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart("run-1", {
			id: "search-candidates",
			name: "search-candidates",
			status: "completed",
			parentIds: [],
			toolEvents: [],
		});
		const onStageAttach = vi.fn(() => {});
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(32),
			onStageAttach,
		});
		assert.equal(view._focusedIndex, 0);

		store.recordStageStart("run-1", {
			id: "editor-stage",
			name: "editor",
			status: "running",
			parentIds: ["search-candidates"],
			toolEvents: [],
			attachable: true,
		});
		store.recordStagePendingPrompt("run-1", "editor-stage", {
			id: "prompt-editor-1",
			kind: "editor",
			message: "Edit and save to continue.",
			initial: "approval json",
			createdAt: Date.now(),
		});

		assert.equal(view._focusedIndex, 1);
		view.handleInput("\r");
		assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "editor-stage"]);
		view.dispose();
	});

	it("keeps graph navigation live while a stage-local pendingPrompt is awaiting input", () => {
		const stages = [
			{ ...makeStage("done"), status: "completed" as const },
			makeAwaitingInputStage("input", ["done"], {
				pendingPrompt: makePendingPrompt(),
			}),
		];
		const view = makeView(stages);

		assert.equal(view._focusedIndex, 1);
		view.handleInput("\x1b[A");
		assert.equal(view._focusedIndex, 0);
		view.dispose();
	});

	it("keeps graph navigation live while a stage-local inputRequest is awaiting input", () => {
		const stages = [
			{ ...makeStage("done"), status: "completed" as const },
			makeAwaitingInputStage("question", ["done"], {
				inputRequest: makeInputRequest(),
			}),
		];
		const view = makeView(stages);

		assert.equal(view._focusedIndex, 1);
		view.handleInput("\x1b[A");
		assert.equal(view._focusedIndex, 0);
		view.dispose();
	});

	it("keeps graph shell controls live while a stage-local HIL request is active", () => {
		const stages = [
			{ ...makeStage("done"), status: "completed" as const },
			makeAwaitingInputStage("question", ["done"], {
				inputRequest: makeInputRequest(),
			}),
		];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const onStageAttach = vi.fn(() => {});
		let detached = 0;
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			onStageAttach,
			onDetach: () => {
				detached += 1;
			},
		});

		view.handleInput("/");
		assert.equal(view._switcherOpen, true);
		view.handleInput("\x1b");
		assert.equal(view._switcherOpen, false);

		view.handleInput("\r");
		assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "question"]);

		view.handleInput("\x18");
		assert.equal(detached, 1);
		view.dispose();
	});
});
