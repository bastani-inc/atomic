// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, it } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const { makeStage, makeStore, defaultTheme } = h;

const ESC = "\x1b";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const ENTER = "\r";
const STACK = "Error: verify gate failed: 2 jobs\n    at verifyStage (/repo/ralph.ts:41:11)";

function stage(id, status, extra = {}, parents = []) {
	return { ...makeStage(id, parents), status, ...extra };
}

function view(stages, runExtra = {}, opts = {}) {
	const run = { ...h.makeSnap(stages).runs[0], ...runExtra };
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

function screen(graph, width = 160) {
	return graph
		.render(width)
		.map((line) => stripAnsi(line))
		.join("\n");
}

function hint(graph, width = 160) {
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
		assert.match(hint(graph), /esc\/← back to graph/);
		assert.equal(graph.handleInput(ESC), true);
		assert.doesNotMatch(screen(graph), /summary\s+Shipped it/);
		assert.match(hint(graph), /o run details/);
	});

	it("shows every declared output, not just the graph snapshot's compact result", () => {
		const compact = {
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
		assert.match(hint(graph), /o run details/, "← goes back to the graph too");
	});

	it("enter on a failed blocker opens that stage's failure detail; esc from there returns to the graph", () => {
		const graph = view(
			[stage("plan", "completed"), stage("verify", "failed", { error: STACK }, ["plan"])],
			{ status: "failed", error: STACK },
			{ stageActions: { retry: async () => ({ ok: true, message: "ok" }) } },
		);
		graph.handleInput("o");
		assert.equal(graph.handleInput(ENTER), true);
		const shown = screen(graph);
		assert.match(shown, /✗ verify · failed/);
		assert.match(hint(graph), /r retry stage/);
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
		graph.handleInput(ENTER);
		assert.match(screen(graph), /✗ verify · failed/);
		graph.handleInput(ESC);
		assert.match(hint(graph), /esc\/← back to graph/);
		assert.match(screen(graph), /Blockers · 1/, "back at the run details");
		graph.handleInput(ESC);
		assert.match(hint(graph), /o run details/, "then the graph");
	});

	it("↑↓ move between blockers, and enter on a waiting stage attaches its chat", () => {
		const attached = [];
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

	it("the run details fit 80 and 160 columns, and ? lists exactly the keys the hint offers", () => {
		const graph = view([stage("verify", "failed", { error: "x".repeat(300) })], {
			status: "failed",
			error: "x".repeat(300),
			result: { long: "y".repeat(400) },
		});
		graph.handleInput("o");
		for (const width of [80, 160])
			for (const line of graph.render(width)) assert.ok(visibleWidth(line) <= width, stripAnsi(line));
		graph.handleInput("?");
		const help = screen(graph);
		assert.match(help, /keys · run details/);
		for (const label of ["back to graph", "open", "logs", "scroll"]) assert.match(help, new RegExp(label));
	});
});
