// @ts-nocheck

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { stripVTControlCharacters as stripAnsi } from "../helpers/visible-text.ts";
import { makeFakeKeybindings as s5aKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const { makeStage, makeSnap, makeStore, makeRun, defaultTheme, visibleText, makeView } = h;

const CTRL_X_VARIANTS = ["\x18", "\x1b[120;5u", "\x1b[120;5:1u", "\x1b[27;5;120~"];

describe("GraphView return to main chat", () => {
	it("← only moves between siblings and never leaves the graph, including at the leftmost node (#5234)", () => {
		const onDetach = vi.fn(() => {});
		const view = new GraphView({
			piKeybindings: s5aKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store: makeStore(makeSnap([makeStage("A"), makeStage("B", ["A"]), makeStage("C", ["A"])])),
			graphTheme: defaultTheme,
			onDetach,
		});
		view.handleInput("\x1b[B");
		view.handleInput("\x1b[C");
		const sibling = view._focusedIndex;
		const hint = () => stripAnsi(view.render(140).join("\n"));
		assert.match(hint(), /esc back/);
		assert.doesNotMatch(hint(), /esc\/← back/);
		view.handleInput("\x1b[D");
		assert.match(hint(), /esc back/);
		assert.notEqual(view._focusedIndex, sibling, "← moves to the sibling on the left");
		assert.equal(onDetach.mock.calls.length, 0);
		const leftmost = view._focusedIndex;
		view.handleInput("\x1b[D");
		assert.equal(view._focusedIndex, leftmost);
		assert.equal(onDetach.mock.calls.length, 0, "← at the leftmost node does nothing");
		view.handleInput("\x1b");
		assert.equal(onDetach.mock.calls.length, 1, "only Esc leaves the graph");
		view.dispose();
	});

	it("Esc returns a nested workflow graph to main chat without changing workflow lifecycle (#5224)", () => {
		const rootBoundary: StageSnapshot = {
			...makeStage("workflow:child"),
			status: "running",
			workflowChildRun: { alias: "child", workflow: "child-workflow", runId: "child-run" },
		};
		const snap: StoreSnapshot = {
			runs: [
				makeRun([rootBoundary]),
				{
					id: "child-run",
					name: "child-workflow",
					inputs: {},
					status: "running",
					toolNodes: [],
					stages: [makeStage("child-first")],
					startedAt: Date.now(),
				},
			],
			notices: [],
			version: 1,
		};
		let returnedToChat = 0;
		const before = structuredClone(snap.runs);
		const view = new GraphView({
			piKeybindings: s5aKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store: makeStore(snap),
			graphTheme: defaultTheme,
			initialFocusedStageId: "child-first",
			onDetach: () => {
				returnedToChat += 1;
			},
		});

		view.handleInput("\x18");
		assert.equal(returnedToChat, 0, "Ctrl+X no longer navigates");
		view.handleInput("\x1b");

		assert.equal(returnedToChat, 1);
		assert.deepEqual(snap.runs, before);
		view.dispose();
	});

	it("Ctrl+X variants never navigate; with the stage switcher open, Esc pops one level at a time (#5224)", () => {
		for (const key of CTRL_X_VARIANTS) {
			const store = makeStore(makeSnap([makeStage("A"), makeStage("B")]));
			const onDetach = vi.fn(() => {});
			const before = structuredClone(store.runs());
			const view = new GraphView({
				piKeybindings: s5aKeybindings(),
				mode: "overlay",
				runId: "run-1",
				store,
				graphTheme: defaultTheme,
				onDetach,
			});

			view.handleInput("/");
			assert.equal(view._switcherOpen, true);
			view.handleInput(key);
			assert.equal(onDetach.mock.calls.length, 0, JSON.stringify(key));
			view.handleInput("\x1b");
			assert.equal(view._switcherOpen, false);
			assert.equal(onDetach.mock.calls.length, 0, "the first Esc only closes the switcher");
			view.handleInput("\x1b");

			assert.equal(onDetach.mock.calls.length, 1, JSON.stringify(key));
			assert.deepEqual(store.runs(), before);
			view.dispose();
		}
	});

	it("q remains printable in the stage switcher instead of navigating or quitting", () => {
		const onDetach = vi.fn(() => {});
		const view = new GraphView({
			piKeybindings: s5aKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store: makeStore(makeSnap([makeStage("A")])),
			graphTheme: defaultTheme,
			onDetach,
		});

		view.handleInput("/");
		view.handleInput("q");
		assert.equal(view.handleInput("\x04"), false);

		assert.equal(onDetach.mock.calls.length, 0);
		assert.equal(view._switcherState.query, "q");
		view.dispose();
	});

	it("Ctrl+D no longer returns from the graph", () => {
		const onDetach = vi.fn(() => {});
		const view = new GraphView({
			piKeybindings: s5aKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store: makeStore(makeSnap([makeStage("A")])),
			graphTheme: defaultTheme,
			onDetach,
		});

		assert.equal(view.handleInput("\x04"), false);
		assert.equal(onDetach.mock.calls.length, 0);
		view.dispose();
	});

	it("render names the back key to main chat (#5224)", () => {
		const view = makeView([makeStage("A"), makeStage("B", ["A"])]);
		const text = visibleText(view.render(120));

		assert.match(text, /ORCHESTRATOR/);
		assert.match(text, /GRAPH/);
		assert.match(text, /move/);
		assert.match(text, /↵ open stage chat/);
		assert.match(text, /stages/);
		assert.match(text, /esc(?:\/←)?\s+back/i);
		assert.doesNotMatch(text, /ctrl\+x/i);
		assert.doesNotMatch(text, /ctrl\+d|q\s+(?:quit|detach|return)/i);

		const mediumText = visibleText(view.render(96));
		assert.match(mediumText, /↵ open stage chat/);

		const compactText = visibleText(view.render(40));
		assert.match(compactText, /\besc(?:\s+back)?\s*·/i);
		assert.doesNotMatch(compactText, /←|ctrl\+x|ctrl\+d/i);
		view.dispose();
	});
});
