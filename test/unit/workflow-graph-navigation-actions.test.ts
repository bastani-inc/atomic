// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, it, vi } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const { makeStage, makeSnap, makeStore, defaultTheme } = h;

const ESC = "\x1b";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const ENTER = "\r";

function stage(id, status, extra = {}, parents = []) {
	return { ...makeStage(id, parents), status, ...extra };
}

function view(stages, opts = {}) {
	return new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: "run-1",
		store: makeStore(makeSnap(stages)),
		graphTheme: defaultTheme,
		...opts,
	});
}

/** The hint row: the line holding the GRAPH pill's middle. */
function hint(graph, width = 160) {
	const lines = graph.render(width).map((line) => stripAnsi(line));
	return lines.find((line) => line.includes("│ GRAPH │")) ?? "";
}

function settle() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("workflow graph navigation and stage actions (#5224)", () => {
	it("f cycles a status filter shown on the hint line, dimming nodes without moving them", () => {
		const graph = view([stage("A", "completed"), stage("B", "running", {}, ["A"])]);
		const before = graph.render(160).map((line) => stripAnsi(line));
		assert.match(hint(graph), /f filter: all/);
		const labels = ["running", "completed", "failed", "all"];
		for (const label of labels) {
			assert.equal(graph.handleInput("f"), true);
			assert.match(hint(graph), new RegExp(`f filter: ${label}`));
		}
		graph.handleInput("f");
		const after = graph.render(160).map((line) => stripAnsi(line));
		assert.deepEqual(
			after.slice(0, -3),
			before.slice(0, -3),
			"the filter changes colour only: every card keeps its place and text",
		);
		graph.dispose();
	});

	it("x x stops the focused running stage; the first press only arms it and says so", async () => {
		const stop = vi.fn(async () => ({ ok: true, message: "Stopped B" }));
		const graph = view([stage("B", "running")], { stageActions: { stop } });
		assert.match(hint(graph), /x stop stage/);
		graph.handleInput("x");
		assert.equal(stop.mock.calls.length, 0);
		assert.match(hint(graph), /Press x again within 3s to stop B/);
		graph.handleInput("x");
		assert.deepEqual(stop.mock.calls[0], ["run-1", "B"]);
		await settle();
		assert.match(hint(graph), /Stopped B/);
		graph.dispose();
	});

	it("moving between presses disarms x", () => {
		const stop = vi.fn(async () => ({ ok: true, message: "stopped" }));
		const graph = view([stage("A", "running"), stage("B", "running", {}, ["A"])], { stageActions: { stop } });
		graph.handleInput("x");
		graph.handleInput(DOWN);
		graph.handleInput("x");
		assert.equal(stop.mock.calls.length, 0, "the second x armed the newly focused stage instead");
		graph.dispose();
	});

	it("a stage that is not working offers no stop and x does nothing", () => {
		const stop = vi.fn(async () => ({ ok: true, message: "stopped" }));
		const graph = view([stage("A", "completed")], { stageActions: { stop } });
		assert.doesNotMatch(hint(graph), /stop stage/);
		graph.handleInput("x");
		graph.handleInput("x");
		assert.equal(stop.mock.calls.length, 0);
		graph.dispose();
	});

	it("Enter on a failed stage opens its failure detail with the reason and its actions, never a stack trace", () => {
		const failed = stage("verify", "failed", {
			error: "gate failed: unit-tests (windows-x64, 2/5)\n    at runGate (gate.ts:12:3)",
		});
		const graph = view([failed], {
			piTui: { terminal: { rows: 40 } },
			onStageAttach: () => {},
			stageActions: {
				retry: async () => ({ ok: true, message: "" }),
				fork: async () => ({ ok: true, message: "" }),
			},
		});
		assert.match(hint(graph), /↵ open failure detail/);
		graph.handleInput(ENTER);
		const text = graph
			.render(160)
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(text, /✗ verify · failed/);
		assert.match(text, /Reason\s+gate failed: unit-tests \(windows-x64, 2\/5\)/);
		assert.doesNotMatch(text, /at runGate/, "the summary keeps the stack under logs");
		const detailHint = hint(graph);
		for (const key of [/esc\/← back to graph/, /r retry stage/, /f fork run/, /t transcript/, /l logs/]) {
			assert.match(detailHint, key);
		}
		graph.handleInput("l");
		assert.match(
			graph
				.render(160)
				.map((line) => stripAnsi(line))
				.join("\n"),
			/at runGate/,
			"l shows the full log",
		);
		assert.match(hint(graph), /l summary/);
		graph.dispose();
	});

	it("r and f run the host's retry and fork on the failed stage, and t opens its transcript", async () => {
		const retry = vi.fn(async () => ({ ok: false, message: "insufficient_state: nothing to retry" }));
		const fork = vi.fn(async () => ({ ok: false, message: "cannot fork" }));
		const onStageAttach = vi.fn();
		const graph = view([stage("verify", "failed", { error: "boom" })], {
			onStageAttach,
			stageActions: { retry, fork },
		});
		graph.handleInput(ENTER);
		graph.handleInput("r");
		assert.deepEqual(retry.mock.calls[0], ["run-1", "verify"]);
		await settle();
		assert.match(hint(graph), /insufficient_state: nothing to retry/);
		graph.handleInput("f");
		assert.deepEqual(fork.mock.calls[0], ["run-1", "verify"]);
		graph.handleInput("t");
		assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "verify"]);
		graph.dispose();
	});

	it("Esc and ← pop the failure detail back to the graph, then the graph back to its opener", () => {
		const onDetach = vi.fn();
		const graph = view([stage("verify", "failed", { error: "boom" })], { onDetach, onStageAttach: () => {} });
		graph.handleInput(ENTER);
		graph.handleInput(ESC);
		assert.equal(onDetach.mock.calls.length, 0, "Esc first closes the detail");
		assert.match(hint(graph), /f filter/);
		graph.handleInput(ENTER);
		graph.handleInput(LEFT);
		assert.equal(onDetach.mock.calls.length, 0, "← closes the detail too");
		graph.handleInput(ESC);
		assert.equal(onDetach.mock.calls.length, 1, "Esc at the graph's top leaves it");
		graph.dispose();
	});

	it("? opens the key overlay listing the graph's keys, and Esc closes it without leaving", () => {
		const onDetach = vi.fn();
		const graph = view([stage("A", "running")], {
			onDetach,
			piTui: { terminal: { rows: 40 } },
			stageActions: { stop: async () => ({ ok: true, message: "" }) },
		});
		assert.match(hint(graph), /\? keys/);
		graph.handleInput("?");
		const text = graph
			.render(160)
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(text, /keys · workflow graph/);
		assert.match(text, /x\s+stop stage/);
		assert.match(text, /f\s+filter: all/);
		assert.match(text, /esc\/\?\s+close this help/);
		graph.handleInput("x");
		graph.handleInput("x");
		graph.handleInput(ESC);
		assert.equal(onDetach.mock.calls.length, 0, "Esc closed the overlay, not the graph");
		assert.doesNotMatch(
			graph
				.render(160)
				.map((line) => stripAnsi(line))
				.join("\n"),
			/keys · workflow graph/,
		);
		graph.dispose();
	});

	it("the hint line lists only keys that act: no stop without a host stop action, no open on a node with nothing to open", () => {
		const graph = view([stage("A", "running")]);
		const line = hint(graph);
		assert.doesNotMatch(line, /stop stage/);
		assert.doesNotMatch(line, /↵ open/);
		assert.match(line, /esc\/← back/);
		graph.dispose();
	});

	it("stopped and failed never look alike (#5224)", () => {
		assert.equal(statusIcon("failed"), "✗");
		assert.equal(statusIcon("killed"), "◼");
		assert.equal(statusIcon("cancelled"), "◼");
	});
});
