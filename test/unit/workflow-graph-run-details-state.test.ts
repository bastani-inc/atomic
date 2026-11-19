import assert from "node:assert/strict";
import { stripTerminalSequences as strip, TuiMainScreen } from "@bastani/atomic-tui";
import { describe, it } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphViewOpts } from "../../packages/workflows/src/tui/graph-view-types.js";
import { ScreenTerminal } from "../helpers/screen-terminal.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const now = Date.now();

function makeStage(id: string, extra: Partial<StageSnapshot> = {}, parentIds: readonly string[] = []): StageSnapshot {
	return {
		id,
		name: id,
		status: "pending",
		parentIds: [...parentIds],
		toolEvents: [],
		startedAt: now - 5000,
		...extra,
	};
}

function makeFailedTool(): ToolNodeSnapshot {
	return {
		kind: "tool",
		id: "tool:abc",
		name: "deploy",
		args: {},
		argsHash: "h",
		ordinal: 1,
		status: "failed",
		error: "deploy refused",
		parentIds: ["plan"],
		executionOrder: 2,
		attachable: false,
		startedAt: now - 3000,
		endedAt: now - 2000,
	};
}

function makeFailedRunSnapshot(withTool = true): RunSnapshot {
	return {
		id: "run-1",
		name: "gate",
		inputs: {},
		status: "failed",
		startedAt: now - 5000,
		endedAt: now - 1000,
		error: "verify failed",
		stages: [
			makeStage("plan", { status: "completed", endedAt: now - 4000 }),
			makeStage("verify", { status: "failed", error: "verify failed", endedAt: now - 1000 }, ["plan"]),
		],
		toolNodes: withTool ? [makeFailedTool()] : [],
	};
}

function createGraphSetup(extra: Partial<GraphViewOpts> = {}) {
	const store = createStore();
	store.recordRunStart(structuredClone(makeFailedRunSnapshot()));
	let detached = 0;
	const graph = new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: "run-1",
		store,
		graphTheme: h.defaultTheme,
		piTui: h.makeTestTui(30),
		onDetach: () => {
			detached += 1;
		},
		...extra,
	});
	const lines = () => graph.render(140).map((line) => strip(line));
	const screen = () => lines().join("\n");
	const hint = () => lines().find((line) => line.includes("│ GRAPH │") || /esc back/.test(line)) ?? "";
	return { store, graph, screen, hint, detachedCount: () => detached };
}

function focusFailedStage(graph: GraphView, hint: () => string): void {
	for (const key of ["\x1b[D", "\x1b[C", "\x1b[A", "\x1b[B", "\x1b[D", "\x1b[C", "k", "j"]) {
		if (/open failure detail/.test(hint())) return;
		graph.handleInput(key);
	}
	assert.match(hint(), /open failure detail/);
}

describe("workflow graph run details state and painted input (#5224)", () => {
	it("closes run details and any saved return when the run leaves the store (#5224)", () => {
		const { store, graph, screen, hint, detachedCount } = createGraphSetup();
		try {
			graph.handleInput("o");
			assert.match(screen(), /Blockers · 2/);
			store.removeRun("run-1");
			const goneScreen = screen();
			assert.match(goneScreen, /No active workflow run\./);
			assert.doesNotMatch(hint(), /esc back to graph/);
			graph.handleInput(ESC);
			assert.equal(detachedCount(), 1);
			store.recordRunStart(structuredClone(makeFailedRunSnapshot()));
			assert.doesNotMatch(screen(), /Blockers · 2/);

			graph.handleInput("o");
			assert.match(screen(), /❯ ✗ verify/);
			graph.handleInput(ENTER);
			assert.match(screen(), /✗ verify · failed/);
			store.removeRun("run-1");
			assert.match(screen(), /No active workflow run\./);
			assert.doesNotMatch(hint(), /esc back to graph/);
			store.recordRunStart(structuredClone(makeFailedRunSnapshot()));
			assert.doesNotMatch(screen(), /Blockers · 2/);

			graph.handleInput("o");
			screen();
			graph.handleInput("?");
			assert.match(screen(), /keys · run details/);
			store.removeRun("run-1");
			const goneAfterHelp = screen();
			assert.match(goneAfterHelp, /No active workflow run\./);
			assert.doesNotMatch(goneAfterHelp, /keys · run details/);
			graph.handleInput(ESC);
			assert.equal(
				detachedCount(),
				2,
				"Esc over the painted empty graph leaves it rather than closing an invisible help overlay",
			);

			store.recordRunStart(structuredClone(makeFailedRunSnapshot()));
			screen();
			graph.handleInput("/");
			assert.equal(graph._switcherOpen, true);
			screen();
			store.removeRun("run-1");
			const goneAfterSwitcher = screen();
			assert.match(goneAfterSwitcher, /No active workflow run\./);
			assert.equal(graph._switcherOpen, false);
			graph.handleInput(ESC);
			assert.equal(detachedCount(), 3, "Esc over the painted empty graph after switcher vanish leaves it");
		} finally {
			graph.dispose();
		}
	});

	it("returns to run details without leaving a stale return when a tool detail closes via sync or run vanish (#5224)", () => {
		const { store, graph, screen, hint } = createGraphSetup();
		try {
			graph.handleInput("o");
			graph.handleInput(DOWN);
			assert.match(screen(), /❯ ✗ deploy/);
			graph.handleInput(ENTER);
			assert.doesNotMatch(screen(), /Blockers ·/);

			store.recordRunStart(structuredClone(makeFailedRunSnapshot(false)));
			assert.match(screen(), /Blockers · 1/);
			graph.handleInput(ESC);
			assert.doesNotMatch(screen(), /Blockers ·/);

			focusFailedStage(graph, hint);
			graph.handleInput(ENTER);
			assert.match(screen(), /✗ verify · failed/);
			graph.handleInput(ESC);
			assert.doesNotMatch(screen(), /Blockers · 1/);

			store.recordRunStart(structuredClone(makeFailedRunSnapshot(true)));
			screen();
			graph.handleInput("o");
			screen();
			graph.handleInput(DOWN);
			assert.match(screen(), /❯ ✗ deploy/);
			graph.handleInput(ENTER);
			assert.doesNotMatch(screen(), /Blockers ·/);
			store.removeRun("run-1");
			assert.match(screen(), /No active workflow run\./);
			store.recordRunStart(structuredClone(makeFailedRunSnapshot(false)));
			screen();
			focusFailedStage(graph, hint);
			graph.handleInput(ENTER);
			assert.match(screen(), /✗ verify · failed/);
			graph.handleInput(ESC);
			assert.doesNotMatch(screen(), /Blockers · 1/);
		} finally {
			graph.dispose();
		}
	});

	it("acts only on the painted blocker selection when Enter or Right precedes a throttled paint (#5224)", async () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-1",
			name: "gate",
			inputs: {},
			status: "running",
			startedAt: now - 5000,
			stages: [
				makeStage("verify", { status: "failed", error: "verify gate failed", endedAt: now - 1000 }),
				makeStage("approve", {
					status: "awaiting_input",
					pendingPrompt: { id: "p1", kind: "confirm", message: "Ship it?", createdAt: now },
				}),
			],
			toolNodes: [],
		});
		const attached: string[] = [];
		const terminal = new ScreenTerminal(120, 30);
		const tui = new TuiMainScreen(terminal);
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: h.defaultTheme,
			piTui: tui,
			requestRender: () => tui.requestRender(),
			onStageAttach: (_runId, stageId) => attached.push(stageId),
		});
		const unsubscribe = store.subscribeInvalidation(() => tui.requestRender());
		tui.addChild(graph);
		tui.setFocus(graph);
		tui.start();
		let renderCount = 0;
		const originalRender = graph.render.bind(graph);
		graph.render = (width: number) => {
			renderCount += 1;
			return originalRender(width);
		};
		const settle = async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return (await terminal.flushAndGetViewport()).join("\n");
		};
		try {
			await settle();
			renderCount = 0;
			terminal.sendInput("o");
			terminal.sendInput(ENTER);
			assert.equal(renderCount, 0);
			assert.match(await settle(), /❯ ✗ verify/);

			renderCount = 0;
			terminal.sendInput(DOWN);
			terminal.sendInput(ENTER);
			assert.equal(renderCount, 0);
			assert.deepEqual(attached, []);
			const afterDown = await settle();
			assert.match(afterDown, /❯ ◆ approve/);

			terminal.sendInput("\x1b[A");
			const before = await settle();
			assert.match(before, /❯ ✗ verify/);
			renderCount = 0;
			store.editRun("run-1", (run) => {
				const verify = run.stages.find((stage) => stage.id === "verify")!;
				verify.status = "running";
				delete verify.error;
				delete verify.endedAt;
				return { stageIds: ["verify"] };
			});
			terminal.sendInput(ENTER);
			assert.equal(renderCount, 0);
			assert.deepEqual(attached, []);

			const updated = await settle();
			assert.match(updated, /❯ ◆ approve/);
			terminal.sendInput(RIGHT);
			assert.deepEqual(attached, ["approve"]);
		} finally {
			unsubscribe();
			tui.stop();
			graph.dispose();
		}
	});

	it("makes Esc act on the painted stage detail even when the stage recovers before the next paint (#5224)", async () => {
		const store = createStore();
		store.recordRunStart(structuredClone(makeFailedRunSnapshot(false)));
		const left: string[] = [];
		const terminal = new ScreenTerminal(120, 30);
		const tui = new TuiMainScreen(terminal);
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: h.defaultTheme,
			piTui: tui,
			requestRender: () => tui.requestRender(),
			onDetach: () => left.push("detach"),
		});
		const unsubscribe = store.subscribeInvalidation(() => tui.requestRender());
		tui.addChild(graph);
		tui.setFocus(graph);
		tui.start();
		let renderCount = 0;
		const originalRender = graph.render.bind(graph);
		graph.render = (width: number) => {
			renderCount += 1;
			return originalRender(width);
		};
		const settle = async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return (await terminal.flushAndGetViewport()).join("\n");
		};
		try {
			terminal.sendInput("o");
			assert.match(await settle(), /❯ ✗ verify/);
			terminal.sendInput(ENTER);
			assert.match(await settle(), /✗ verify · failed/);
			renderCount = 0;
			store.editRun("run-1", (run) => {
				const verify = run.stages.find((stage) => stage.id === "verify")!;
				verify.status = "running";
				delete verify.error;
				delete verify.endedAt;
				return { stageIds: ["verify"] };
			});
			terminal.sendInput(ESC);
			assert.equal(renderCount, 0);
			const afterRunDetailEsc = await settle();
			assert.match(afterRunDetailEsc, /esc back to graph/);
			assert.equal(left.length, 0);

			terminal.sendInput(ESC);
			await settle();
			store.recordRunStart(structuredClone(makeFailedRunSnapshot(false)));
			await settle();
			focusFailedStage(
				graph,
				() =>
					originalRender(140)
						.map((line) => strip(line))
						.find((line) => line.includes("│ GRAPH │") || /esc back/.test(line)) ?? "",
			);
			terminal.sendInput(ENTER);
			assert.match(await settle(), /✗ verify · failed/);
			renderCount = 0;
			store.editRun("run-1", (run) => {
				const verify = run.stages.find((stage) => stage.id === "verify")!;
				verify.status = "running";
				delete verify.error;
				delete verify.endedAt;
				return { stageIds: ["verify"] };
			});
			terminal.sendInput(ESC);
			assert.equal(renderCount, 0);
			await settle();
			assert.deepEqual(left, []);
		} finally {
			unsubscribe();
			tui.stop();
			graph.dispose();
		}
	});

	it("keeps the graph open when a second Esc reaches painted run details before the next paint (#5224)", async () => {
		const store = createStore();
		store.recordRunStart(structuredClone(makeFailedRunSnapshot()));
		const left: string[] = [];
		const terminal = new ScreenTerminal(120, 30);
		const tui = new TuiMainScreen(terminal);
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: h.defaultTheme,
			piTui: tui,
			requestRender: () => tui.requestRender(),
			onDetach: () => left.push("detach"),
		});
		const unsubscribe = store.subscribeInvalidation(() => tui.requestRender());
		tui.addChild(graph);
		tui.setFocus(graph);
		tui.start();
		let renderCount = 0;
		const originalRender = graph.render.bind(graph);
		graph.render = (width: number) => {
			renderCount += 1;
			return originalRender(width);
		};
		const settle = async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return (await terminal.flushAndGetViewport()).join("\n");
		};
		try {
			terminal.sendInput("o");
			assert.match(await settle(), /Blockers · 2/);
			renderCount = 0;
			terminal.sendInput(ESC);
			terminal.sendInput(ESC);
			assert.equal(renderCount, 0, "both Escapes arrive before the graph is painted again");
			const graphScreen = await settle();
			assert.deepEqual(left, [], "the second Esc does not leave a graph that was never painted");
			assert.doesNotMatch(graphScreen, /Blockers ·/);

			terminal.sendInput(ESC);
			await settle();
			assert.deepEqual(left, ["detach"], "Esc over the painted graph leaves it");
		} finally {
			unsubscribe();
			tui.stop();
			graph.dispose();
		}
	});

	it("scrolls run details with ↑ and ↓ when only one blocker is listed (#5224)", () => {
		const stages: StageSnapshot[] = Array.from({ length: 12 }, (_, index) =>
			makeStage(`s${index}`, {
				status: "completed",
				startedAt: now + index * 1000,
				endedAt: now + index * 1000 + 500,
			}),
		);
		stages.push(
			makeStage("bad0", {
				status: "failed",
				error: "bad0 broke",
				startedAt: now + 20_000,
				endedAt: now + 21_000,
			}),
		);
		const run: RunSnapshot = {
			id: "run-1",
			name: "gate",
			inputs: {},
			status: "failed",
			error: "bad0 broke",
			startedAt: now,
			endedAt: now + 22_000,
			result: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`out${index}`, `value ${index}`])),
			stages,
			toolNodes: [],
		};
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: run.id,
			store: h.makeStore({ runs: [run], notices: [], version: 1 }),
			graphTheme: h.defaultTheme,
			piTui: h.makeTestTui(16),
		});
		const body = () =>
			graph
				.render(120)
				.map((line) => strip(line))
				.slice(3, -3)
				.join("\n");
		try {
			graph.handleInput("o");
			const start = body();
			assert.match(start, /Blockers · 1/);
			for (let index = 0; index < 4; index++) graph.handleInput(DOWN);
			const scrolledDown = body();
			assert.notEqual(scrolledDown, start);
			for (let index = 0; index < 4; index++) graph.handleInput("\x1b[A");
			assert.equal(body(), start);
		} finally {
			graph.dispose();
		}
	});

	it("opens the selected root blocker rather than a child stage with the same id (#5255)", () => {
		const root: RunSnapshot = {
			id: "root-run",
			name: "parent",
			inputs: {},
			status: "running",
			startedAt: now,
			stages: [
				makeStage("deploy", {
					status: "running",
					workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child-run" },
				}),
				makeStage(
					"approve",
					{
						status: "awaiting_input",
						pendingPrompt: {
							id: "root-question",
							kind: "confirm",
							message: "Approve ROOT deployment?",
							createdAt: now,
						},
					},
					["deploy"],
				),
			],
			toolNodes: [],
		};
		const child: RunSnapshot = {
			...root,
			id: "child-run",
			name: "child-wf",
			parentRunId: root.id,
			parentStageId: "deploy",
			rootRunId: root.id,
			stages: [
				makeStage("approve", {
					status: "awaiting_input",
					pendingPrompt: {
						id: "child-question",
						kind: "confirm",
						message: "Approve CHILD deployment?",
						createdAt: now,
					},
				}),
			],
		};
		const attached: string[] = [];
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: root.id,
			store: h.makeStore({ runs: [root, child], notices: [], version: 1 }),
			graphTheme: h.defaultTheme,
			piTui: h.makeTestTui(30),
			onStageAttach: (runId, stageId) => attached.push(`${runId}/${stageId}`),
		});
		try {
			graph.handleInput("o");
			graph.render(140);
			graph.handleInput(DOWN);
			const screen = strip(graph.render(140).join("\n"));
			assert.match(screen, /❯ ◆ approve\s+Approve ROOT deployment\?/);
			graph.handleInput(ENTER);
			assert.deepEqual(attached, ["root-run/approve"]);
		} finally {
			graph.dispose();
		}
	});

	it("focuses and activates nested child workflow stage and tool blockers from run details (#5224)", () => {
		const store = createStore();
		const root: RunSnapshot = {
			id: "root",
			name: "parent",
			inputs: {},
			status: "running",
			startedAt: now - 5000,
			stages: [
				makeStage("plan", { status: "completed", endedAt: now - 4000 }),
				makeStage(
					"deploy",
					{
						status: "running",
						workflowChildRun: { alias: "child", workflow: "child-wf", runId: "child" },
					},
					["plan"],
				),
			],
			toolNodes: [],
		};
		const child: RunSnapshot = {
			id: "child",
			name: "child-wf",
			inputs: {},
			status: "running",
			startedAt: now - 4000,
			parentRunId: "root",
			parentStageId: "deploy",
			rootRunId: "root",
			stages: [
				makeStage("ask", {
					status: "awaiting_input",
					pendingPrompt: { id: "p1", kind: "confirm", message: "Ship child?", createdAt: now },
				}),
			],
			toolNodes: [
				{
					...makeFailedTool(),
					id: "tool:child-1",
					name: "child-tool",
					parentIds: ["ask"],
				},
			],
		};
		store.recordRunStart(structuredClone(root));
		store.recordRunStart(structuredClone(child));
		const attached: string[] = [];
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "root",
			store,
			graphTheme: h.defaultTheme,
			piTui: h.makeTestTui(30),
			onStageAttach: (runId, stageId) => attached.push(`${runId}/${stageId}`),
		});
		const screen = () =>
			graph
				.render(140)
				.map((line) => strip(line))
				.join("\n");
		try {
			graph.handleInput("o");
			assert.match(screen(), /Ship child\?/);
			assert.match(screen(), /child-tool/);
			graph.handleInput(ENTER);
			assert.deepEqual(attached, ["child/ask"]);

			graph.handleInput("o");
			assert.match(screen(), /Ship child\?/);
			graph.handleInput(DOWN);
			assert.match(screen(), /❯ ✗ child-tool/);
			graph.handleInput(ENTER);
			assert.doesNotMatch(screen(), /Blockers ·/);
			assert.match(screen(), /child-tool/);
		} finally {
			graph.dispose();
		}
	});
});
