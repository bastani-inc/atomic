import assert from "node:assert/strict";
import { stripTerminalSequences as stripAnsi } from "@bastani/atomic-tui";
import { describe, it } from "vitest";
import type { RunSnapshot, StageSnapshot, StageStatus } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphViewOpts } from "../../packages/workflows/src/tui/graph-view-types.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const { makeStage, makeStore, defaultTheme } = h;

const ESC = "\x1b";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const ENTER = "\r";
const STACK = "Error: verify gate failed: 2 jobs\n    at verifyStage (/repo/ralph.ts:41:11)";

function stage(
	id: string,
	status: StageStatus,
	extra: Partial<StageSnapshot> = {},
	parents: string[] = [],
): StageSnapshot {
	return { ...makeStage(id, parents), status, ...extra };
}

function view(stages: StageSnapshot[], runExtra: Partial<RunSnapshot> = {}, opts: Partial<GraphViewOpts> = {}) {
	const run: RunSnapshot = { ...h.makeSnap(stages).runs[0]!, ...runExtra };
	return new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: run.id,
		store: makeStore({ runs: [run], notices: [], version: 1 }),
		graphTheme: defaultTheme,
		piTui: h.makeTestTui(40),
		...opts,
	});
}

function screen(graph: GraphView, width = 160) {
	return graph
		.render(width)
		.map((line) => stripAnsi(line))
		.join("\n");
}

function hint(graph: GraphView, width = 160) {
	const lines = graph.render(width).map((line) => stripAnsi(line));
	const index = lines.findIndex((line) => line.includes("│ GRAPH │"));
	return index < 0 ? "" : lines[index];
}

describe("workflow graph run details: outputs and diagnostics (#5224)", () => {
	it("o opens the run details with the run's outputs and artifacts, and esc returns to the graph", () => {
		const graph = view(
			[
				stage("plan", "completed", { startedAt: 1_000, endedAt: 2_000 }),
				stage(
					"implement",
					"completed",
					{ startedAt: 2_000, endedAt: 9_000, artifacts: [{ kind: "output", path: "/repo/out/report.md" }] },
					["plan"],
				),
			],
			{ status: "completed", startedAt: 1_000, endedAt: 9_000, result: { summary: "Shipped it" } },
		);
		assert.match(hint(graph), /o run details/, "the graph advertises the key");
		assert.equal(graph.handleInput("o"), true);
		const shown = screen(graph);
		assert.match(shown, /✓ Test Run · completed in 8s/);
		assert.match(shown, /summary\s+Shipped it/);
		assert.match(shown, /output\s+\/repo\/out\/report\.md/);
		assert.match(hint(graph), /esc back to graph/);
		assert.doesNotMatch(hint(graph), /←/, "← is not a back key in the run details");
		assert.equal(graph.handleInput(ESC), true);
		assert.doesNotMatch(screen(graph), /summary\s+Shipped it/);
		assert.match(hint(graph), /o run details/);
	});

	it("shows every declared output, not just the graph snapshot's compact result", () => {
		const compact: RunSnapshot = {
			...h.makeSnap([stage("plan", "completed")]).runs[0],
			status: "completed",
			result: { summary: "short" },
		};
		const full = { ...compact, result: { summary: "short", prNumber: 5236, files: ["a.ts"] } };
		const store = { ...makeStore({ runs: [compact], notices: [], version: 1 }), run: () => full };
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: compact.id,
			store,
			graphTheme: defaultTheme,
			piTui: h.makeTestTui(40),
		});
		graph.handleInput("o");
		const shown = screen(graph);
		assert.match(shown, /prNumber\s+5236/);
		assert.match(shown, /files\s+\["a\.ts"\]/);
	});

	it("a failed run's details show the short reason, never the stack, and l shows the full log", () => {
		const graph = view([stage("verify", "failed", { error: STACK })], {
			status: "failed",
			error: STACK,
			failedStageId: "verify",
		});
		graph.handleInput("o");
		const summary = screen(graph);
		assert.match(summary, /Reason\s+verify gate failed: 2 jobs/);
		assert.doesNotMatch(summary, /at verifyStage/);
		assert.doesNotMatch(hint(graph), /↑↓ select/, "one blocker: nothing to select between");
		assert.match(hint(graph), /↵ open/);
		assert.match(hint(graph), /l logs/);
		graph.handleInput("l");
		assert.match(screen(graph), /at verifyStage \(\/repo\/ralph\.ts:41:11\)/);
		assert.match(hint(graph), /l summary/);
		graph.handleInput(LEFT);
		assert.match(hint(graph), /l summary/, "← does nothing in the run details");
		graph.handleInput(ESC);
		assert.match(hint(graph), /o run details/, "esc goes back to the graph");
	});

	it("enter on a failed blocker opens that stage's failure detail with retry", () => {
		const graph = view(
			[stage("plan", "completed"), stage("verify", "failed", { error: STACK }, ["plan"])],
			{ status: "failed", error: STACK },
			{ stageActions: { retry: async () => ({ ok: true, message: "ok" }) } },
		);
		graph.handleInput("o");
		graph.render(160);
		assert.equal(graph.handleInput(ENTER), true);
		const shown = screen(graph);
		assert.match(shown, /✗ verify · failed/);
		assert.match(hint(graph), /r retry from stage/);
	});

	it("the selected blocker stays in view when the terminal is short", () => {
		const stages = Array.from({ length: 8 }, (_, index) => stage(`s${index}`, "failed", { error: `boom ${index}` }));
		const graph = view(stages, { status: "failed", error: "boom" }, { piTui: h.makeTestTui(14) });
		graph.handleInput("o");
		assert.match(screen(graph), /Reason\s+boom/, "it opens at the top, with the reason");
		for (let step = 0; step < 7; step++) graph.handleInput(DOWN);
		assert.match(screen(graph), /❯ ✗ s7\s+boom 7/);
	});

	it("esc from a detail opened from the run details goes back to the run details, one level", () => {
		const graph = view([stage("plan", "completed"), stage("verify", "failed", { error: STACK }, ["plan"])], {
			status: "failed",
			error: STACK,
		});
		graph.handleInput("o");
		graph.render(160);
		graph.handleInput(ENTER);
		assert.match(screen(graph), /✗ verify · failed/);
		graph.handleInput(ESC);
		assert.match(hint(graph), /esc back to graph/);
		assert.match(screen(graph), /Blockers · 1/, "back at the run details");
		graph.handleInput(ESC);
		assert.match(hint(graph), /o run details/, "then the graph");
	});

	it("↑↓ move between blockers, and enter on a waiting stage attaches its chat", () => {
		const attached: string[] = [];
		const graph = view(
			[
				stage("verify", "failed", { error: "boom" }),
				stage("approve", "awaiting_input", {
					pendingPrompt: { id: "p1", kind: "confirm", message: "Approve?", createdAt: 1 },
				}),
			],
			{ status: "running" },
			{ onStageAttach: (_runId, stageId) => attached.push(stageId) },
		);
		graph.handleInput("o");
		assert.match(screen(graph), /❯ ✗ verify/);
		graph.handleInput(DOWN);
		assert.match(screen(graph), /❯ ◆ approve/);
		graph.handleInput(ENTER);
		assert.deepEqual(attached, ["approve"]);
	});

	it("the run details fit 40, 80 and 160 columns, and ? lists the keys the hint offers", () => {
		const graph = view([stage("verify", "failed", { error: "x".repeat(300) })], {
			status: "failed",
			error: "x".repeat(300),
			result: { long: "y".repeat(400) },
		});
		graph.handleInput("o");
		for (const width of [40, 80, 160])
			for (const line of graph.render(width)) assert.ok(visibleWidth(line) <= width, stripAnsi(line));
		graph.handleInput("?");
		const help = screen(graph);
		assert.match(help, /keys · run details/);
		for (const label of ["back to graph", "open", "logs", "scroll"]) assert.match(help, new RegExp(label));
	});
	it("← never leaves the run details or the graph from them; only esc goes back (#5224)", () => {
		const graph = view([stage("verify", "failed", { error: "boom" })], { status: "failed", error: "boom" });
		graph.handleInput("o");
		for (let press = 0; press < 3; press++) assert.equal(graph.handleInput(LEFT), true);
		assert.match(screen(graph), /Blockers · 1/, "still on the run details");
		assert.match(hint(graph), /esc back to graph/);
		graph.handleInput(ESC);
		assert.match(hint(graph), /o run details/);
	});

	it("names, outputs, reasons, artifacts and log lines are shown inert, never as live escape sequences (#5224)", () => {
		const evil = "a\x1b]52;c;aGk=\x07b\x1b[2Jc\u202ed";
		const graph = view(
			[
				stage(`s${evil}`, "failed", {
					error: `boom ${evil}`,
					artifacts: [{ kind: "output", path: `/repo/${evil}.md`, captureError: `no ${evil}` }],
				}),
			],
			{ name: `wf ${evil}`, status: "failed", error: `boom ${evil}`, result: { [`k${evil}`]: `v ${evil}` } },
		);
		const check = (lines: string[]) => {
			for (const line of lines) {
				assert.doesNotMatch(line, /\x1b\]/, "no OSC sequence reaches the terminal");
				assert.doesNotMatch(line, /\x1b\[2J/, "no screen clear reaches the terminal");
				assert.doesNotMatch(line, /\u202e/, "no bidirectional override reaches the terminal");
			}
		};
		check(graph.render(160));
		graph.handleInput("/");
		check(graph.render(160));
		graph.handleInput(ESC);
		graph.handleInput("o");
		check(graph.render(160));
		assert.match(screen(graph), /<U\+202E>/, "the bidi override is shown, not obeyed");
		graph.handleInput("l");
		check(graph.render(160));
		graph.handleInput(ESC);
		graph.handleInput(ENTER);
		check(graph.render(160));
		graph.handleInput("l");
		check(graph.render(160));
	});

	it("a run that returned a blocked or failed status reads as blocked or failed, with its own words as the reason (#5224)", () => {
		const blocked = view([stage("plan", "completed")], {
			status: "completed",
			endedAt: 9_000,
			result: { status: "needs_human", summary: "Waiting on a design decision" },
		});
		blocked.handleInput("o");
		assert.match(screen(blocked), /↑ Test Run · blocked/);
		assert.match(screen(blocked), /Reason\s+Waiting on a design decision/);
		const failed = view([stage("plan", "completed")], {
			status: "completed",
			endedAt: 9_000,
			result: { status: "failed", summary: "Tests still red" },
		});
		failed.handleInput("o");
		assert.match(screen(failed), /✗ Test Run · failed/);
		assert.match(screen(failed), /Reason\s+Tests still red/);
	});

	it("an open run details view builds the run's outcome once per snapshot, not once per frame or key (#5224)", () => {
		const marker = { counted: true };
		let builds = 0;
		Object.defineProperty(marker, "toJSON", {
			value: () => {
				builds++;
				return { counted: true };
			},
		});
		const graph = view([stage("verify", "failed", { error: "boom" }), stage("check", "failed", { error: "bang" })], {
			status: "failed",
			error: "boom",
			result: { data: marker },
		});
		try {
			graph.handleInput("o");
			const first = screen(graph);
			assert.match(first, /Outputs/);
			assert.match(first, /data\s+\{"counted":true\}/);
			const firstBuilds = builds;
			assert.ok(firstBuilds > 0, "opening the run details inspects its output");
			for (let frame = 0; frame < 30; frame++) graph.render(frame % 2 === 0 ? 80 : 160);
			for (let press = 0; press < 10; press++) graph.handleInput(press % 2 === 0 ? DOWN : "\x1b[A");
			for (let frame = 0; frame < 10; frame++) graph.render(120);
			assert.equal(builds, firstBuilds, "frames and selection reuse the already built outcome");
		} finally {
			graph.dispose();
		}
	});

	it("keeps the selected blocker by identity when the blocker list changes under it (#5224)", () => {
		const attached: string[] = [];
		const run: RunSnapshot = {
			...h.makeSnap([
				stage("approve", "awaiting_input", {
					pendingPrompt: { id: "p1", kind: "confirm", message: "Approve?", createdAt: 1 },
				}),
				stage("verify", "running"),
			]).runs[0]!,
			status: "running",
		};
		const snap = { runs: [run], notices: [], version: 1 };
		const listeners: Array<() => void> = [];
		const store = {
			...makeStore(snap),
			subscribeInvalidation: (listener: () => void) => {
				listeners.push(listener);
				return () => {};
			},
		};
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: run.id,
			store,
			graphTheme: defaultTheme,
			piTui: h.makeTestTui(40),
			onStageAttach: (_runId, stageId) => attached.push(stageId),
		});
		graph.handleInput("o");
		assert.match(screen(graph), /❯ ◆ approve/);
		const next = {
			...run,
			stages: [stage("verify", "failed", { error: "boom" }), ...run.stages.filter((s) => s.id !== "verify")],
		};
		snap.runs = [next];
		snap.version = 2;
		for (const listener of listeners) listener();
		assert.match(screen(graph), /❯ ◆ approve/, "the selection stays on approve, not the new first blocker");
		graph.handleInput(ENTER);
		assert.deepEqual(attached, ["approve"]);
	});
});
