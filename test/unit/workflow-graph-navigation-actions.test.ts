// @ts-nocheck

import assert from "node:assert/strict";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { describe, it, vi } from "vitest";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type {
	GraphForkTargetResult,
	GraphStageActionResult,
} from "../../packages/workflows/src/tui/graph-view-types.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
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
		const labels = ["running", "stopped", "completed", "failed", "all"];
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

	it.each(["awaiting_input", "blocked", "suspended"])(
		"a %s stage does not offer a stop the pause path cannot perform (#5234)",
		(status) => {
			const stop = vi.fn(async () => ({ ok: true, message: "stopped" }));
			const graph = view([stage("verify", status)], { stageActions: { stop } });
			try {
				assert.doesNotMatch(hint(graph), /x stop/);
				graph.handleInput("x");
				graph.handleInput("x");
				assert.equal(stop.mock.calls.length, 0);
			} finally {
				graph.dispose();
			}
		},
	);

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
				forkTarget: async () => ({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false }),
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
		for (const key of [
			/esc back to graph/,
			/r retry in place/,
			/f fork from this stage \(reruns it\)/,
			/t transcript/,
			/l logs/,
		]) {
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

	it("r runs the host's retry on the failed stage, and t opens its transcript", async () => {
		const retry = vi.fn(async () => ({ ok: false, message: "insufficient_state: nothing to retry" }));
		const onStageAttach = vi.fn();
		const graph = view([stage("verify", "failed", { error: "boom" })], { onStageAttach, stageActions: { retry } });
		graph.handleInput(ENTER);
		graph.handleInput("r");
		assert.deepEqual(retry.mock.calls[0], ["run-1", "verify"]);
		await settle();
		assert.match(hint(graph), /insufficient_state: nothing to retry/);
		graph.handleInput("t");
		assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "verify"]);
		graph.dispose();
	});

	it("f asks on one line before forking from the failed stage, naming the tool steps that run again; Esc cancels", async () => {
		const forkTarget = vi.fn(async () => ({ ok: true, stagePath: "verify", rerunToolSteps: 2, live: true }));
		const fork = vi.fn(async () => ({ ok: true, message: "Forked run-1 into run-2", runId: "run-2" }));
		const onShowRun = vi.fn();
		const graph = view([stage("verify", "failed", { error: "boom" })], {
			onShowRun,
			stageActions: { fork, forkTarget },
		});
		graph.handleInput(ENTER);
		graph.handleInput("f");
		assert.deepEqual(forkTarget.mock.calls[0], ["run-1", "verify"], "the root run and the stage's graph id");
		await settle();
		const asking = hint(graph);
		assert.match(
			asking,
			/Fork from verify: reruns it and 2 completed tool steps in a new run\. Stops this run first, resumably\./,
		);
		assert.match(asking, /enter fork {2}· {2}esc cancel/);
		assert.equal(fork.mock.calls.length, 0, "nothing forks before Enter");
		graph.handleInput(LEFT);
		assert.match(hint(graph), /enter fork/, "Left does not cancel the confirmation (#5234)");
		graph.handleInput(ESC);
		assert.doesNotMatch(hint(graph), /Fork from verify/, "Esc cancels the confirmation");
		assert.match(hint(graph), /f fork from this stage/, "and stays in the detail");
		graph.handleInput("f");
		await settle();
		graph.handleInput(ENTER);
		assert.deepEqual(fork.mock.calls[0], ["run-1", "verify"], "the fork starts from the stage's path");
		await settle();
		assert.equal(onShowRun.mock.calls[0][0], "run-2");
		assert.deepEqual(onShowRun.mock.calls[0][1], {
			notice: { text: "Forked run-1 into run-2", tone: "info" },
			focusStageId: "verify",
		});
		graph.dispose();
	});

	it("a fork confirmation is cancelled when its failed stage recovers (#5234)", async () => {
		const snap = makeSnap([stage("verify", "failed", { error: "boom" })]);
		let notify = () => {};
		const store = {
			...makeStore(snap),
			subscribeInvalidation: (listener) => {
				notify = listener;
				return () => {};
			},
		};
		const fork = vi.fn(async () => ({ ok: true, message: "forked" }));
		const graph = view([], {
			store,
			stageActions: {
				fork,
				forkTarget: async () => ({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false }),
			},
		});
		graph.handleInput(ENTER);
		graph.handleInput("f");
		await settle();
		assert.match(hint(graph), /enter fork/);
		snap.runs[0].stages[0] = stage("verify", "running");
		snap.version += 1;
		notify();
		assert.doesNotMatch(hint(graph), /Fork from verify|enter fork/);
		snap.runs[0].stages[0] = stage("verify", "failed", { error: "failed again" });
		snap.version += 1;
		notify();
		graph.handleInput(ENTER);
		assert.doesNotMatch(hint(graph), /enter fork/);
		graph.handleInput(ENTER);
		assert.equal(fork.mock.calls.length, 0);
		graph.dispose();
	});

	it("a late fork lookup cannot confirm after closing and reopening the same stage (#5234)", async () => {
		const target = Promise.withResolvers<GraphForkTargetResult>();
		const fork = vi.fn(async () => ({ ok: true, message: "forked" }));
		const graph = view([stage("verify", "failed", { error: "boom" })], {
			stageActions: {
				fork,
				forkTarget: () => target.promise,
			},
		});
		graph.handleInput(ENTER);
		graph.handleInput("f");
		graph.handleInput(ESC);
		graph.handleInput(ENTER);
		target.resolve({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false });
		await settle();
		assert.doesNotMatch(hint(graph), /Fork from verify|enter fork|Checking where/);
		graph.handleInput(ENTER);
		assert.equal(fork.mock.calls.length, 0);
		graph.dispose();
	});

	it.each(["retarget", "dispose", "queued dispose"])(
		"a late fork cannot navigate after %s (#5234)",
		async (transition) => {
			const snap = makeSnap([stage("verify", "failed")]);
			snap.runs.push({ ...snap.runs[0], id: "run-2" }, { ...snap.runs[0], id: "run-3" });
			const listeners = new Set<() => void>();
			const forked = Promise.withResolvers<GraphStageActionResult>();
			const pane = new WorkflowAttachPane({
				store: {
					...makeStore(snap),
					subscribeInvalidation: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
				graphTheme: defaultTheme,
				runId: "run-1",
				piKeybindings: makeFakeKeybindings(),
				onClose: () => {},
				stageActions: {
					forkTarget: async () => ({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false }),
					fork: () => forked.promise,
				},
			});
			try {
				pane.handleInput(ENTER);
				pane.handleInput("f");
				await settle();
				pane.handleInput(ENTER);
				if (transition === "retarget") pane.retarget("run-3");
				else if (transition === "dispose") pane.dispose();
				forked.resolve({ ok: true, message: "forked", runId: "run-2" });
				if (transition === "queued dispose") queueMicrotask(() => pane.dispose());
				await settle();
				assert.equal(pane._runId, transition === "retarget" ? "run-3" : "run-1");
				assert.equal(listeners.size, transition === "retarget" ? 2 : 0);
			} finally {
				pane.dispose();
			}
		},
	);

	it("stopping another stage cannot overlap an unfinished retry (#5234)", async () => {
		const retried = Promise.withResolvers<GraphStageActionResult>();
		const retry = vi.fn(() => retried.promise);
		const stop = vi.fn(async () => ({ ok: true, message: "stopped" }));
		const graph = view([stage("verify", "failed"), stage("worker", "running", {}, ["verify"])], {
			stageActions: { retry, stop },
		});
		try {
			graph.handleInput(ENTER);
			graph.handleInput("r");
			graph.handleInput(ESC);
			graph.handleInput(DOWN);
			graph.handleInput("x");
			graph.handleInput("x");
			assert.equal(stop.mock.calls.length, 0);
			graph.handleInput("\x1b[A");
			graph.handleInput(ENTER);
			graph.handleInput("r");
			assert.equal(retry.mock.calls.length, 1);
			retried.resolve({ ok: false, message: "retry refused" });
			await settle();
		} finally {
			graph.dispose();
		}
	});

	it("f on a stage no fork can start at says why and asks nothing", async () => {
		const graph = view([stage("verify", "failed", { error: "boom" })], {
			stageActions: {
				fork: vi.fn(),
				forkTarget: async () => ({
					ok: false,
					message: "A fork can't start at this stage: it is still running or never ran.",
				}),
			},
		});
		graph.handleInput(ENTER);
		graph.handleInput("f");
		await settle();
		assert.match(hint(graph), /A fork can't start at this stage/);
		assert.doesNotMatch(hint(graph), /enter fork/);
		graph.dispose();
	});

	it("r on the same run says it is retrying at once, keeps the retried stage focused, and says when it fails again", async () => {
		const stages = [stage("plan", "completed"), stage("verify", "failed", { error: "boom", endedAt: 10 }, ["plan"])];
		const snap = makeSnap(stages);
		const listeners = [];
		const store = {
			...makeStore(snap),
			subscribe: (listener) => {
				listeners.push(listener);
				return () => {};
			},
			subscribeInvalidation: (listener) => {
				listeners.push(listener);
				return () => {};
			},
		};
		const changed = () => {
			snap.version += 1;
			for (const listener of listeners) listener();
		};
		const retried = Promise.withResolvers<GraphStageActionResult>();
		const retry = vi.fn(() => retried.promise);
		const onShowRun = vi.fn();
		let renders = 0;
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: { terminal: { rows: 40 } },
			requestRender: () => {
				renders += 1;
			},
			onShowRun,
			stageActions: { retry },
		});
		graph.handleInput(DOWN);
		graph.handleInput(ENTER);
		const before = renders;
		graph.handleInput("r");
		assert.ok(renders > before, "the Retrying notice is drawn at once");
		assert.match(hint(graph), /Retrying verify…/);
		graph.handleInput("r");
		assert.equal(retry.mock.calls.length, 1, "a second r while the first is in flight makes no second attempt");
		retried.resolve({ ok: true, message: "Resumed run-1 from verify", runId: "run-1" });
		await settle();
		assert.equal(onShowRun.mock.calls.length, 0, "the same run is not shown again, so focus and the notice stay");
		assert.match(hint(graph), /Resumed run-1 from verify/);
		snap.runs[0].stages[1] = { ...snap.runs[0].stages[1], status: "running", error: undefined, endedAt: undefined };
		changed();
		graph.render(160);
		snap.runs[0].stages[1] = { ...snap.runs[0].stages[1], status: "failed", error: "still broken", endedAt: 20 };
		changed();
		assert.match(hint(graph), /retry failed again: still broken/);
		assert.equal(graph._focusedIndex, 1, "focus stays on the retried stage");
		graph.dispose();
	});

	it("only Esc pops the failure detail and graph, while ← in failure detail does nothing (#5234)", () => {
		const onDetach = vi.fn();
		const graph = view([stage("verify", "failed", { error: "boom" })], { onDetach, onStageAttach: () => {} });
		graph.handleInput(ENTER);
		graph.handleInput(ESC);
		assert.equal(onDetach.mock.calls.length, 0, "Esc first closes the detail");
		assert.match(hint(graph), /f filter/);
		graph.handleInput(ENTER);
		const failureDetail = hint(graph);
		graph.handleInput(LEFT);
		assert.equal(hint(graph), failureDetail, "← keeps the failure detail open");
		assert.equal(onDetach.mock.calls.length, 0);
		graph.handleInput(ESC);
		assert.match(hint(graph), /f filter/);
		assert.equal(onDetach.mock.calls.length, 0);
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
		graph.handleInput(LEFT);
		assert.match(
			graph
				.render(160)
				.map((line) => stripAnsi(line))
				.join("\n"),
			/keys · workflow graph/,
		);
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
		assert.match(line, /esc back/);
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
			assert.match(hintRow, /esc back {2}· {2}↵ open/, `the hints start intact at ${width}`);
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

	it("the x prompt goes away as soon as focus moves off its stage", () => {
		const graph = view([stage("A", "running"), stage("B", "running", {}, ["A"])], {
			stageActions: { stop: async () => ({ ok: true, message: "" }) },
		});
		graph.handleInput("x");
		assert.match(hint(graph), /Press x again within 3s to stop A/);
		graph.handleInput(DOWN);
		assert.doesNotMatch(hint(graph), /Press x again/);
		graph.dispose();
	});

	it("a stopped stage matches the stopped filter, and no other filter but all", () => {
		const graph = view([stage("A", "paused"), stage("B", "running", {}, ["A"])]);
		graph.handleInput(DOWN);
		const dimmed = (filter) => {
			while (!hint(graph).includes(`f filter: ${filter}`)) graph.handleInput("f");
			return graph.render(160).find((line) => stripAnsi(line).includes("─ A ─"));
		};
		const plain = dimmed("all");
		assert.equal(dimmed("stopped"), plain, "stopped matches the paused stage, so it is drawn as usual");
		for (const filter of ["running", "completed", "failed"]) assert.notEqual(dimmed(filter), plain, filter);
		graph.dispose();
	});

	it("at 80 columns the hint keeps the keys that act on this stage ahead of / stages and h hide, and lists each arrow once", () => {
		const graph = view(
			[stage("A", "completed"), stage("B", "running", {}, ["A"]), stage("C", "running", {}, ["A"])],
			{
				onHide: () => {},
				stageActions: { stop: async () => ({ ok: true, message: "" }) },
			},
		);
		graph.handleInput(DOWN);
		graph.handleInput("f");
		const narrow = hint(graph, 80).split("\n")[1];
		assert.match(narrow, /x stop\b/, "a stoppable stage keeps x");
		assert.match(narrow, /f filter: running/, "a filter other than all stays visible");
		assert.doesNotMatch(narrow, /\/ stages|h hide/, "the always-available keys drop first");
		assert.match(narrow, /\? keys/);
		assert.equal(narrow.split("←").length - 1, 0, "← does nothing on the first sibling");
		assert.match(narrow, /esc back/, "only Esc leaves the graph");
		assert.match(hint(graph, 160), /↑→ move/, "only the arrows that move: up to A, right to C");
		graph.handleInput("\x1b[C");
		const second = hint(graph, 160).split("\n")[1];
		assert.match(second, /esc back/, "with a sibling to the left, ← moves");
		assert.match(second, /↑← move/);
		assert.equal(second.split("←").length - 1, 1);
		graph.dispose();
	});

	it("stopped and failed never look alike (#5224)", () => {
		assert.equal(statusIcon("failed"), "✗");
		assert.equal(statusIcon("killed"), "◼");
		assert.equal(statusIcon("cancelled"), "◼");
	});
});
