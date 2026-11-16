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

/** The statusline: the notice row above the GRAPH pill's middle, then the hint row. */
function hint(graph, width = 160) {
	const lines = graph.render(width).map((line) => stripAnsi(line));
	const index = lines.findIndex((line) => line.includes("│ GRAPH │"));
	return index < 0 ? "" : `${lines[index - 1]}\n${lines[index]}`;
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

	it("the hint line lists only keys that act: no stop without a host stop action", () => {
		const graph = view([stage("A", "running")]);
		const line = hint(graph);
		assert.doesNotMatch(line, /stop stage/);
		assert.match(line, /esc\/← back/);
		graph.dispose();
	});

	it("a notice gets its own row above the hint line and never splices into it, at 80 and 160 columns", () => {
		const statuses = new Map([["stop-all", "Press ctrl+x ctrl+k again within 3s to stop all background work"]]);
		const graph = view([stage("A", "running"), stage("B", "pending", {}, ["A"])], {
			onStageAttach: () => {},
			footerData: { getExtensionStatuses: () => statuses },
		});
		for (const width of [80, 160]) {
			const lines = graph.render(width).map((line) => stripAnsi(line));
			const hintIndex = lines.findIndex((line) => line.includes("│ GRAPH │"));
			const hintRow = lines[hintIndex];
			const toastRow = lines[hintIndex - 1];
			assert.match(
				toastRow,
				/Press ctrl\+x ctrl\+k again/,
				`the notice sits on the row above the hints at ${width}`,
			);
			assert.doesNotMatch(hintRow, /Press ctrl\+x/, `the hint row carries no notice at ${width}`);
			assert.match(hintRow, /esc\/← back {2}· {2}↵ open stage chat/, `the hints start intact at ${width}`);
			assert.match(hintRow, /\? keys/, `\`? keys\` survives width pressure at ${width}`);
			if (width === 160) assert.match(hintRow, /\/ stages/, "the wide hint keeps `/ stages`");
		}
		statuses.clear();
		const quiet = graph.render(160).map((line) => stripAnsi(line));
		const quietHint = quiet.findIndex((line) => line.includes("│ GRAPH │"));
		assert.equal(quiet[quietHint - 1].replace(/[│╭╮─\s]|GRAPH/g, ""), "", "no notice leaves the row empty");
		graph.dispose();
	});

	it("the first x press shows its prompt above the hint line, which stays intact", () => {
		const graph = view([stage("A", "running")], { stageActions: { stop: async () => ({ ok: true, message: "" }) } });
		graph.handleInput("x");
		const lines = graph.render(80).map((line) => stripAnsi(line));
		const hintIndex = lines.findIndex((line) => line.includes("│ GRAPH │"));
		assert.match(lines[hintIndex - 1], /Press x again within 3s to stop A/);
		assert.doesNotMatch(lines[hintIndex], /Press x again/);
		assert.match(lines[hintIndex], /\? keys/);
		graph.dispose();
	});

	it("stopped and failed never look alike (#5224)", () => {
		assert.equal(statusIcon("failed"), "✗");
		assert.equal(statusIcon("killed"), "◼");
		assert.equal(statusIcon("cancelled"), "◼");
	});
});
