import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	RunSnapshot,
	StageSnapshot,
	StoreSnapshot,
	ToolNodeSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphViewOpts } from "../../packages/workflows/src/tui/graph-view-types.js";
import { stripVTControlCharacters as stripAnsi } from "../helpers/visible-text.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const { makeStage, makeStore, defaultTheme } = h;

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";
const ENTER = "\r";
const CTRL_C = "\x03";

function stage(
	id: string,
	status: StageSnapshot["status"],
	extra: Partial<StageSnapshot> = {},
	parents: string[] = [],
): StageSnapshot {
	return { ...makeStage(id, parents), status, ...extra };
}

function opts(extra: Partial<GraphViewOpts> = {}): GraphViewOpts {
	return {
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: "run-1",
		store: makeStore(h.makeSnap([])),
		graphTheme: defaultTheme,
		piTui: h.makeTestTui(40),
		...extra,
	};
}

function view(
	stages: StageSnapshot[],
	runExtra: Partial<RunSnapshot> = {},
	extra: Partial<GraphViewOpts> = {},
): GraphView {
	const baseRun = h.makeSnap(stages).runs[0]!;
	const run: RunSnapshot = { ...baseRun, ...runExtra };
	return new GraphView(
		opts({
			runId: run.id,
			store: makeStore({ runs: [run], notices: [], version: 1 }),
			...extra,
		}),
	);
}

function lines(graph: GraphView, width = 160): string[] {
	return graph.render(width).map((line) => stripAnsi(line));
}

function screen(graph: GraphView, width = 160): string {
	return lines(graph, width).join("\n");
}

function hint(graph: GraphView, width = 160): string {
	return lines(graph, width).find((line) => line.includes("│ GRAPH │")) ?? "";
}

function toastRow(graph: GraphView, width = 160): string {
	const rendered = lines(graph, width);
	const index = rendered.findIndex((line) => line.includes("│ GRAPH │"));
	return index > 0 ? (rendered[index - 1] ?? "") : "";
}

function dynamicView(
	stages: StageSnapshot[],
	runExtra: Partial<RunSnapshot> = {},
	extra: Partial<GraphViewOpts> = {},
): {
	graph: GraphView;
	run: RunSnapshot;
	change: (next: Partial<RunSnapshot>) => void;
} {
	const baseRun = h.makeSnap(stages).runs[0]!;
	const run: RunSnapshot = { ...baseRun, ...runExtra };
	const snap: { runs: RunSnapshot[]; notices: StoreSnapshot["notices"]; version: number } = {
		runs: [run],
		notices: [],
		version: 1,
	};
	const listeners: Array<() => void> = [];
	const store = {
		...makeStore(snap),
		subscribeInvalidation: (listener: () => void) => {
			listeners.push(listener);
			return () => {};
		},
	};
	const graph = new GraphView(opts({ runId: run.id, store, ...extra }));
	const change = (next: Partial<RunSnapshot>): void => {
		snap.runs = [{ ...run, ...next }];
		snap.version += 1;
		for (const listener of listeners) listener();
	};
	return { graph, run, change };
}

describe("workflow graph run details navigation and caching (#5224)", () => {
	it("Enter on a selected failed tool blocker opens that tool's detail, and Esc returns to the same blocker in run details (#5224)", () => {
		const store = createStore();
		const tools: ToolNodeSnapshot[] = [
			{
				kind: "tool",
				id: "tool:t1",
				name: "migrate-db",
				args: {},
				argsHash: "h1",
				ordinal: 1,
				parentIds: ["prepare"],
				status: "failed",
				startedAt: 2,
				endedAt: 3,
				error: "migration lock timeout",
				attachable: false,
			},
			{
				kind: "tool",
				id: "tool:t2",
				name: "deploy-api",
				args: {},
				argsHash: "h2",
				ordinal: 2,
				parentIds: ["prepare"],
				status: "failed",
				startedAt: 4,
				endedAt: 5,
				error: "gateway 502 bad upstream",
				attachable: false,
			},
		];
		store.recordRunStart({
			id: "run-1",
			name: "gate",
			inputs: {},
			status: "failed",
			stages: [stage("prepare", "completed", { startedAt: 1, endedAt: 2 })],
			toolNodes: tools,
			startedAt: 1,
			endedAt: 6,
			error: "gateway 502 bad upstream",
		});
		const graph = new GraphView(opts({ runId: "run-1", store }));
		try {
			assert.equal(graph.handleInput("o"), true);
			assert.match(screen(graph), /Blockers · 2/);
			assert.match(screen(graph), /❯ ✗ migrate-db/);
			assert.equal(graph.handleInput(DOWN), true);
			assert.match(screen(graph), /❯ ✗ deploy-api/);
			assert.equal(graph.handleInput(ENTER), true);
			const detailText = screen(graph);
			assert.doesNotMatch(detailText, /Blockers · 2/);
			assert.match(detailText, /deploy-api/);
			assert.match(detailText, /gateway 502 bad upstream/);
			assert.doesNotMatch(detailText, /migration lock timeout/);
			assert.match(hint(graph), /esc back to graph/);
			assert.equal(graph.handleInput(ESC), true);
			const returned = screen(graph);
			assert.match(returned, /Blockers · 2/);
			assert.match(returned, /❯ ✗ deploy-api/);
			assert.equal(graph.handleInput(ESC), true);
			assert.match(hint(graph), /o run details/);
		} finally {
			graph.dispose();
		}
	});

	it("Enter on a stage blocker focuses the stage even when a tool node precedes it in the layout (#5224)", () => {
		const attached: string[] = [];
		const tool: ToolNodeSnapshot = {
			kind: "tool",
			id: "tool:t1",
			name: "lint",
			args: {},
			argsHash: "h1",
			ordinal: 1,
			parentIds: [],
			status: "failed",
			startedAt: 1,
			endedAt: 2,
			error: "lint failed",
			attachable: false,
		};
		const approve = stage(
			"approve",
			"awaiting_input",
			{
				pendingPrompt: { id: "p1", kind: "confirm", message: "Ship now?", createdAt: 3 },
			},
			["tool:t1"],
		);
		const graph = view(
			[approve],
			{ status: "running", toolNodes: [tool] },
			{ onStageAttach: (_runId, stageId) => attached.push(stageId) },
		);
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /❯ ◆ approve/);
			graph.handleInput(ENTER);
			assert.deepEqual(attached, ["approve"]);
		} finally {
			graph.dispose();
		}
	});

	it("a stage chat opened from a blocker clears the run-details return so a later stage detail Esc returns to the graph (#5224)", () => {
		const attached: string[] = [];
		const graph = view(
			[
				stage("verify", "failed", { error: "boom" }),
				stage("approve", "awaiting_input", {
					pendingPrompt: { id: "p1", kind: "confirm", message: "Approve?", createdAt: 1 },
				}),
			],
			{ status: "running" },
			{
				onStageAttach: (_runId, stageId) => attached.push(stageId),
				stageActions: { retry: async () => ({ ok: true, message: "ok" }) },
			},
		);
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /❯ ✗ verify/);
			graph.handleInput(DOWN);
			assert.match(screen(graph), /❯ ◆ approve/);
			graph.handleInput(ENTER);
			assert.deepEqual(attached, ["approve"]);
			for (let step = 0; step < 3 && !/open failure detail/.test(hint(graph)); step++) {
				graph.handleInput(LEFT);
			}
			assert.match(hint(graph), /open failure detail/);
			graph.handleInput(ENTER);
			assert.match(screen(graph), /✗ verify · failed/);
			graph.handleInput(ESC);
			assert.doesNotMatch(screen(graph), /Blockers · /);
			assert.match(hint(graph), /o run details/);
		} finally {
			graph.dispose();
		}
	});

	it("↑ and ↓ move between blockers and clamp at the first and last blocker (#5224)", () => {
		const graph = view(
			[
				stage("a", "failed", { error: "ea" }),
				stage("b", "failed", { error: "eb" }),
				stage("c", "failed", { error: "ec" }),
			],
			{ status: "failed", error: "x" },
		);
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /❯ ✗ a/);
			assert.equal(graph.handleInput(UP), true);
			assert.match(screen(graph), /❯ ✗ a/);
			assert.equal(graph.handleInput(DOWN), true);
			assert.match(screen(graph), /❯ ✗ b/);
			assert.equal(graph.handleInput(DOWN), true);
			assert.match(screen(graph), /❯ ✗ c/);
			assert.equal(graph.handleInput(DOWN), true);
			assert.match(screen(graph), /❯ ✗ c/);
			assert.equal(graph.handleInput(UP), true);
			assert.match(screen(graph), /❯ ✗ b/);
			assert.equal(graph.handleInput(UP), true);
			assert.equal(graph.handleInput(UP), true);
			assert.match(screen(graph), /❯ ✗ a/);
		} finally {
			graph.dispose();
		}
	});

	it("→ opens the selected blocker like Enter, and ctrl+c closes the view (#5224)", () => {
		const attached: string[] = [];
		const onClose = vi.fn();
		const graph = view(
			[
				stage("approve", "awaiting_input", {
					pendingPrompt: { id: "p1", kind: "confirm", message: "Approve?", createdAt: 1 },
				}),
			],
			{ status: "running" },
			{ onStageAttach: (_runId, stageId) => attached.push(stageId), onClose },
		);
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /❯ ◆ approve/);
			assert.equal(graph.handleInput(RIGHT), true);
			assert.deepEqual(attached, ["approve"]);
			graph.handleInput("o");
			assert.equal(graph.handleInput(CTRL_C), true);
			assert.equal(onClose.mock.calls.length, 1);
		} finally {
			graph.dispose();
		}
	});

	it("while the log view is shown or when there are no blockers, ↑↓ PgUp PgDn and wheel scroll without moving blocker selection (#5224)", () => {
		const manyLines = Array.from({ length: 40 }, (_, index) => `failure line ${index}`).join("\n");
		const graph = view(
			[stage("a", "failed", { error: manyLines }), stage("b", "failed", { error: "eb" })],
			{ status: "failed", error: manyLines },
			{ piTui: h.makeTestTui(18) },
		);
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /❯ ✗ a/);
			assert.equal(graph.handleInput("l"), true);
			assert.match(screen(graph), /failure line 0/);
			assert.equal(graph._graphScrollOffset, 0);
			assert.equal(graph.handleInput(DOWN), true);
			screen(graph);
			assert.equal(graph._graphScrollOffset, 1);
			assert.equal(graph.handleInput(UP), true);
			screen(graph);
			assert.equal(graph._graphScrollOffset, 0);
			assert.equal(graph.handleInput(PAGE_DOWN), true);
			screen(graph);
			const afterPageDown = graph._graphScrollOffset;
			assert.ok(afterPageDown > 1);
			assert.equal(graph.handleInput(PAGE_UP), true);
			screen(graph);
			assert.equal(graph._graphScrollOffset, 0);
			assert.equal(graph.handleInput(WHEEL_DOWN), true);
			screen(graph);
			assert.ok(graph._graphScrollOffset > 0);
			assert.equal(graph.handleInput(WHEEL_UP), true);
			screen(graph);
			assert.equal(graph._graphScrollOffset, 0);
			assert.equal(graph.handleInput("l"), true);
			assert.match(screen(graph), /❯ ✗ a/);
		} finally {
			graph.dispose();
		}

		const outputs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`out_${index}`, `value ${index}`]));
		const completedGraph = view(
			[stage("done", "completed")],
			{ status: "completed", endedAt: 5_000, result: outputs },
			{ piTui: h.makeTestTui(14) },
		);
		try {
			completedGraph.handleInput("o");
			screen(completedGraph);
			assert.equal(completedGraph._graphScrollOffset, 0);
			completedGraph.handleInput(DOWN);
			screen(completedGraph);
			assert.equal(completedGraph._graphScrollOffset, 1);
			completedGraph.handleInput(UP);
			screen(completedGraph);
			assert.equal(completedGraph._graphScrollOffset, 0);
			completedGraph.handleInput(PAGE_DOWN);
			screen(completedGraph);
			assert.ok(completedGraph._graphScrollOffset > 1);
			completedGraph.handleInput(PAGE_UP);
			screen(completedGraph);
			assert.equal(completedGraph._graphScrollOffset, 0);
		} finally {
			completedGraph.dispose();
		}
	});

	it("keeps the selection when the selected blocker moves to row 0, and falls back to the nearest row when it leaves (#5224)", () => {
		const { graph, change, run } = dynamicView(
			[
				stage("verify", "failed", { error: "ev" }),
				stage("approve", "awaiting_input", {
					pendingPrompt: { id: "p1", kind: "confirm", message: "Approve?", createdAt: 1 },
				}),
				stage("check", "failed", { error: "ec" }),
			],
			{ status: "running" },
		);
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /❯ ✗ verify/);
			graph.handleInput(DOWN);
			assert.match(screen(graph), /❯ ◆ approve/);
			change({
				stages: [{ ...run.stages[0]!, status: "running", error: undefined }, run.stages[1]!, run.stages[2]!],
			});
			assert.match(screen(graph), /❯ ◆ approve/);
			graph.handleInput(DOWN);
			assert.match(screen(graph), /❯ ✗ check/);
			change({
				stages: [run.stages[0]!, run.stages[1]!, { ...run.stages[2]!, status: "running", error: undefined }],
			});
			assert.match(screen(graph), /❯ ◆ approve/);
		} finally {
			graph.dispose();
		}
	});

	it("returning from a detail restores the selected blocker and reveals both the blocker and its action line when moving down and up (#5224)", () => {
		const stages = Array.from({ length: 8 }, (_, index) => stage(`s${index}`, "failed", { error: `boom ${index}` }));
		const graph = view(
			stages,
			{ status: "failed", error: "boom" },
			{ piTui: h.makeTestTui(14), stageActions: { retry: async () => ({ ok: true, message: "ok" }) } },
		);
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /Reason\s+boom/);
			for (let step = 0; step < 7; step++) {
				graph.handleInput(DOWN);
				screen(graph);
			}
			const atBottom = screen(graph);
			assert.match(atBottom, /❯ ✗ s7\s+boom 7/);
			assert.match(atBottom, /enter retry, fork, transcript or logs/);
			graph.handleInput(ENTER);
			assert.match(screen(graph), /✗ s7 · failed/);
			graph.handleInput(ESC);
			const restored = screen(graph);
			assert.match(restored, /❯ ✗ s7\s+boom 7/);
			assert.match(restored, /enter retry, fork, transcript or logs/);
			for (let step = 0; step < 7; step++) {
				graph.handleInput(UP);
				screen(graph);
			}
			const atTop = screen(graph);
			assert.match(atTop, /❯ ✗ s0\s+boom 0/);
			assert.match(atTop, /enter retry, fork, transcript or logs/);
		} finally {
			graph.dispose();
		}
	});

	it("updates the open run details when a new snapshot arrives or when the terminal width changes (#5224)", () => {
		const { graph, change, run } = dynamicView([stage("verify", "failed", { error: "boom one" })], {
			status: "failed",
			error: "boom one",
		});
		try {
			graph.handleInput("o");
			assert.match(screen(graph), /boom one/);
			change({ error: "bang two", stages: [{ ...run.stages[0]!, error: "bang two" }] });
			const updated = screen(graph);
			assert.match(updated, /bang two/);
			assert.doesNotMatch(updated, /boom one/);
		} finally {
			graph.dispose();
		}

		const longReason = "reason ".repeat(60);
		const makeWideThenNarrow = (): GraphView =>
			view([stage("verify", "failed", { error: longReason })], { status: "failed", error: longReason });
		const resized = makeWideThenNarrow();
		const freshNarrow = makeWideThenNarrow();
		try {
			resized.handleInput("o");
			resized.render(160);
			const afterWide = lines(resized, 60);
			freshNarrow.handleInput("o");
			assert.deepEqual(afterWide, lines(freshNarrow, 60));
		} finally {
			resized.dispose();
			freshNarrow.dispose();
		}
	});

	describe("elapsed time in run details headline (#5224)", () => {
		beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
		afterEach(() => vi.useRealTimers());

		it("advances the headline elapsed seconds between snapshots (#5224)", () => {
			const graph = view([stage("a", "running", { startedAt: 995_000 })], { status: "running", startedAt: 995_000 });
			try {
				graph.handleInput("o");
				assert.match(screen(graph), /running · 5s/);
				vi.setSystemTime(1_003_000);
				assert.match(screen(graph), /running · 8s/);
			} finally {
				graph.dispose();
			}
		});
	});

	it("run-details hints match blocker counts and toast notices add an ellipsis only when truncated (#5224)", () => {
		const noBlockers = view([stage("a", "completed")], {
			status: "completed",
			endedAt: 9_000,
			result: { summary: "ok" },
		});
		const oneBlocker = view([stage("a", "failed", { error: "ea" })], { status: "failed", error: "ea" });
		const twoBlockers = view([stage("a", "failed", { error: "ea" }), stage("b", "failed", { error: "eb" })], {
			status: "failed",
			error: "ea",
		});
		try {
			noBlockers.handleInput("o");
			assert.doesNotMatch(hint(noBlockers), /open/);
			assert.doesNotMatch(hint(noBlockers), /select/);
			assert.match(hint(noBlockers), /esc back to graph/);

			oneBlocker.handleInput("o");
			assert.match(hint(oneBlocker), /open/);
			assert.doesNotMatch(hint(oneBlocker), /select/);

			twoBlockers.handleInput("o");
			assert.match(hint(twoBlockers), /↑↓ select/);
			assert.match(hint(twoBlockers), /open/);
		} finally {
			noBlockers.dispose();
			oneBlocker.dispose();
			twoBlockers.dispose();
		}

		const statuses = new Map<string, string>([["notice", "Short status"]]);
		const footerData: NonNullable<GraphViewOpts["footerData"]> = {
			getGitBranch: () => null,
			getExtensionStatuses: () => statuses,
			onBranchChange: () => () => {},
			getAvailableProviderCount: () => 0,
		};
		const withToast = view([stage("a", "running")], {}, { footerData });
		try {
			const shortToast = toastRow(withToast, 160).trim();
			assert.match(shortToast, /Short status$/);
			assert.doesNotMatch(shortToast, /…$/);

			statuses.set("notice", "Long status message ".repeat(10));
			const longToast = toastRow(withToast, 80).trim();
			assert.match(longToast, /…$/);
		} finally {
			withToast.dispose();
		}
	});
});
