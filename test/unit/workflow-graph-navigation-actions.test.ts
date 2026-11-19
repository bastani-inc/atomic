// @ts-nocheck

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type {
	GraphForkTargetResult,
	GraphStageActionResult,
} from "../../packages/workflows/src/tui/graph-view-types.js";
import { APP_ACTION } from "../../packages/workflows/src/tui/keybindings-adapter.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import { stripVTControlCharacters as stripAnsi } from "../helpers/visible-text.ts";
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

	it.each([{ bindings: ["z"] }, { bindings: ["escape", "z"] }])(
		"stop confirmation names the pressed binding from $bindings (#5234)",
		async ({ bindings }) => {
			const stop = vi.fn(async () => ({ ok: true, message: "stopped" }));
			const graph = view([stage("A", "running")], {
				stageActions: { stop },
				piKeybindings: {
					matches: (data, action) => data === "z" && action === APP_ACTION.listStop,
					getKeys: (action) => (action === APP_ACTION.listStop ? bindings : []),
				},
			});
			try {
				graph.handleInput("z");
				assert.match(hint(graph), /Press z again within 3s to stop A/);
				assert.doesNotMatch(
					hint(graph).split("\n")[1],
					/esc\/z stop/,
					"Esc is never advertised as a stage stop key",
				);
				assert.equal(stop.mock.calls.length, 0);
				graph.handleInput("z");
				await settle();
				assert.equal(stop.mock.calls.length, 1);
			} finally {
				graph.dispose();
			}
		},
	);

	it.each(["running", "completed"])(
		"h hide is not advertised when the stop binding consumes h on a %s stage (#5234)",
		(status) => {
			const onHide = vi.fn();
			const graph = view([stage("A", status)], {
				onHide,
				stageActions: { stop: async () => ({ ok: true, message: "stopped" }) },
				piKeybindings: {
					matches: (data, action) => data === "h" && action === APP_ACTION.listStop,
					getKeys: (action) => (action === APP_ACTION.listStop ? ["h"] : []),
				},
			});
			try {
				assert.doesNotMatch(hint(graph), /h hide/);
				graph.handleInput("h");
				assert.equal(onHide.mock.calls.length, 0);
			} finally {
				graph.dispose();
			}
		},
	);

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

	it("Enter on a failed stage opens its failure detail with the reason, tokens and actions, never a stack trace", () => {
		const failed = stage("verify", "failed", {
			startedAt: 1_000,
			endedAt: 241_000,
			modelAttempts: [{ model: "mock", status: "failed", usage: { input: 10_000, output: 2_400 } }],
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
		assert.match(hint(graph), /d details/);
		graph.handleInput(ENTER);
		const text = graph
			.render(160)
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(text, /✗ verify · failed after 4m · 12\.4k tokens/);
		assert.match(text, /Reason\s+gate failed: unit-tests \(windows-x64, 2\/5\)/);
		assert.doesNotMatch(text, /at runGate/, "the summary keeps the stack under logs");
		const detailHint = hint(graph);
		for (const key of [/r retry from stage/, /f fork from stage/, /t transcript/, /l logs/, /esc back/]) {
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

	it("d on a completed stage opens its detail with completed header, fork/transcript/logs/back and no retry, while Enter opens its chat (#5224)", async () => {
		const doneStage = stage("plan", "completed", {
			startedAt: 1_000,
			endedAt: 61_000,
			result: "Plan approved\nsecond line",
			modelAttempts: [{ model: "mock", status: "completed", usage: { input: 3_000, output: 1_200 } }],
		});
		const retry = vi.fn(async () => ({ ok: true, message: "retried" }));
		const fork = vi.fn(async () => ({ ok: true, message: "Forked run-1 into run-2", runId: "run-2" }));
		const forkTarget = vi.fn(async () => ({ ok: true, stagePath: "plan", rerunToolSteps: 0, live: false }));
		const onStageAttach = vi.fn();
		const onShowRun = vi.fn();
		const graph = view([doneStage], {
			piTui: { terminal: { rows: 40 } },
			onStageAttach,
			onShowRun,
			stageActions: { retry, fork, forkTarget },
		});
		assert.match(hint(graph), /↵ open stage chat {2}· {2}d details/);
		graph.handleInput(ENTER);
		assert.deepEqual(onStageAttach.mock.calls[0], ["run-1", "plan"]);

		graph.handleInput("d");
		const text = graph
			.render(160)
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(text, /✓ plan · completed in 1m · 4\.2k tokens/);
		const detailHint = hint(graph).split("\n")[1];
		assert.match(detailHint, /f fork from stage {2}· {2}t transcript {2}· {2}l logs {2}· {2}esc back/);
		assert.doesNotMatch(detailHint, /retry/);

		graph.handleInput("r");
		assert.equal(retry.mock.calls.length, 0);

		graph.handleInput("f");
		await settle();
		assert.match(hint(graph), /New run from plan\?/);
		assert.match(hint(graph), /enter confirm {2}· {2}esc cancel/);
		graph.handleInput(ENTER);
		await settle();
		assert.equal(fork.mock.calls.length, 1);
		assert.equal(onShowRun.mock.calls[0]?.[0], "run-2");
		graph.dispose();
	});

	it("p pauses a running run, r resumes a paused or blocked run, and q quits after a second press within 3s (#5224)", async () => {
		const snap = makeSnap([stage("A", "running"), stage("B", "pending", {}, ["A"])]);
		let notify = () => {};
		const store = {
			...makeStore(snap),
			subscribeInvalidation: (listener: () => void) => {
				notify = listener;
				return () => {};
			},
		};
		const pauseRun = vi.fn(async () => ({ ok: true, message: "Paused run-1" }));
		const resumeRun = vi.fn(async () => ({ ok: true, message: "Resumed run-1" }));
		const quitRun = vi.fn(async () => ({ ok: true, message: "Quit run-1" }));
		const stop = vi.fn(async () => ({ ok: true, message: "Stopped A" }));
		const graph = view([], {
			store,
			stageActions: { stop, pauseRun, resumeRun, quitRun },
		});

		const runningHint = hint(graph, 160).split("\n")[1];
		assert.match(
			runningHint,
			/esc back {2}· {2}↵ open stage chat {2}· {2}↓ move {2}· {2}x stop stage {2}· {2}p pause run {2}· {2}q quit run/,
		);
		assert.doesNotMatch(runningHint, /r resume run|d details/);

		graph.handleInput("r");
		assert.equal(resumeRun.mock.calls.length, 0);

		graph.handleInput("p");
		assert.deepEqual(pauseRun.mock.calls[0], ["run-1"]);
		await settle();
		assert.match(hint(graph), /Paused run-1/);

		snap.runs[0].status = "paused";
		snap.runs[0].stages[0] = stage("A", "paused");
		snap.version += 1;
		notify();

		const pausedHint = hint(graph, 160).split("\n")[1];
		assert.match(pausedHint, /r resume run {2}· {2}q quit run/);
		assert.doesNotMatch(pausedHint, /p pause run|x stop stage/);

		graph.handleInput("p");
		assert.equal(pauseRun.mock.calls.length, 1);

		graph.handleInput("r");
		assert.deepEqual(resumeRun.mock.calls[0], ["run-1"]);
		await settle();

		graph.handleInput("q");
		assert.equal(quitRun.mock.calls.length, 0);
		assert.match(hint(graph, 160).split("\n")[1], /q again to quit Test Run/);

		snap.runs[0].status = "blocked";
		snap.version += 1;
		notify();
		assert.doesNotMatch(
			hint(graph, 160).split("\n")[1],
			/q again to quit/,
			"a run state change disarms the pending quit confirmation",
		);
		graph.handleInput("q");
		assert.equal(quitRun.mock.calls.length, 0, "first press in the new state re-arms instead of quitting");
		assert.match(hint(graph, 160).split("\n")[1], /q again to quit Test Run/);
		graph.handleInput("q");
		assert.deepEqual(quitRun.mock.calls[0], ["run-1"]);
		await settle();
		assert.match(hint(graph), /Quit run-1/);

		for (const width of [80, 160]) {
			const row = hint(graph, width).split("\n")[1];
			assert.match(row, /\? keys/);
			if (width === 80) {
				assert.match(row, /r resume\b/);
				assert.match(row, /q quit\b/);
			} else {
				assert.match(row, /r resume run/);
				assert.match(row, /q quit run/);
			}
		}
		graph.dispose();
	});

	it("renders all live keys in exact §4.3 order at 80 and 160 columns across running, paused, blocked, failed, completed and q-armed states (#5224)", () => {
		const fullActions = {
			stop: async () => ({ ok: true, message: "" }),
			pauseRun: async () => ({ ok: true, message: "" }),
			resumeRun: async () => ({ ok: true, message: "" }),
			quitRun: async () => ({ ok: true, message: "" }),
			retry: async () => ({ ok: true, message: "" }),
			fork: async () => ({ ok: true, message: "" }),
			forkTarget: async () => ({ ok: true as const, stagePath: "A", rerunToolSteps: 0, live: true }),
		};

		const scenarios = [
			{
				label: "running",
				runStatus: "running",
				stageStatus: "running",
				expected160: [
					"esc back",
					"↵ open stage chat",
					"↓ move",
					"x stop stage",
					"p pause run",
					"q quit run",
					"/ stages",
					"f filter: all",
					"? keys",
					"h hide",
				],
				expected80Keys: ["esc", "↵", "↓", "x", "p", "q", "/", "f", "? keys", "h"],
			},
			{
				label: "paused",
				runStatus: "paused",
				stageStatus: "paused",
				expected160: [
					"esc back",
					"↵ open stage chat",
					"↓ move",
					"r resume run",
					"q quit run",
					"/ stages",
					"f filter: all",
					"? keys",
					"h hide",
				],
				expected80Keys: ["esc", "↵", "↓", "r", "q", "/", "f", "? keys", "h"],
			},
			{
				label: "blocked",
				runStatus: "blocked",
				stageStatus: "failed",
				expected160: [
					"esc back",
					"↵ open failure detail",
					"d details",
					"↓ move",
					"r resume run",
					"q quit run",
					"/ stages",
					"f filter: all",
					"? keys",
					"h hide",
				],
				expected80Keys: ["esc", "↵", "d", "↓", "r", "q", "/", "f", "? keys", "h"],
			},
			{
				label: "completed",
				runStatus: "completed",
				stageStatus: "completed",
				endedAt: 2_000,
				expected160: [
					"esc back",
					"↵ open stage chat",
					"d details",
					"↓ move",
					"/ stages",
					"f filter: all",
					"? keys",
					"h hide",
				],
				expected80Keys: ["esc", "↵", "d", "↓", "/", "f", "? keys", "h"],
			},
		];

		for (const scenario of scenarios) {
			const snap = makeSnap([stage("A", scenario.stageStatus), stage("B", "pending", {}, ["A"])]);
			snap.runs[0].name = "ralph";
			snap.runs[0].status = scenario.runStatus;
			if (scenario.endedAt !== undefined) snap.runs[0].endedAt = scenario.endedAt;
			const graph = view([], {
				store: makeStore(snap),
				onHide: () => {},
				onStageAttach: () => {},
				stageActions: fullActions,
			});
			try {
				const row160 = hint(graph, 160).split("\n")[1];
				let cursor160 = -1;
				for (const token of scenario.expected160) {
					const next = row160.indexOf(token, cursor160 + 1);
					assert.ok(next > cursor160, `${scenario.label} 160 missing or out of order ${token} in: ${row160}`);
					cursor160 = next;
				}
				const row80 = hint(graph, 80).split("\n")[1];
				const parts80 = row80
					.replace(/^.*│ GRAPH │\s*/, "")
					.trim()
					.split(/\s*·\s*/);
				assert.equal(
					parts80.length,
					scenario.expected80Keys.length,
					`${scenario.label} 80 segment count in: ${row80}`,
				);
				for (let index = 0; index < scenario.expected80Keys.length; index++) {
					assert.ok(
						parts80[index].startsWith(scenario.expected80Keys[index]),
						`${scenario.label} 80 segment ${index} expected prefix ${scenario.expected80Keys[index]}, got ${parts80[index]}`,
					);
				}
			} finally {
				graph.dispose();
			}
		}

		const armedSnap = makeSnap([stage("A", "running"), stage("B", "pending", {}, ["A"])]);
		armedSnap.runs[0].name = "ralph";
		const armedGraph = view([], {
			store: makeStore(armedSnap),
			onHide: () => {},
			onStageAttach: () => {},
			stageActions: fullActions,
		});
		try {
			armedGraph.handleInput("q");
			const row160 = hint(armedGraph, 160).split("\n")[1];
			for (const token of [
				"esc back",
				"↵ open stage chat",
				"↓ move",
				"x stop stage",
				"p pause run",
				"q again to quit ralph",
				"/ stages",
				"f filter: all",
				"? keys",
				"h hide",
			]) {
				assert.ok(row160.includes(token), `q-armed 160 missing ${token} in: ${row160}`);
			}
			assert.ok(row160.indexOf("? keys") < row160.indexOf("h hide"), `? keys precedes h hide in: ${row160}`);

			armedSnap.runs[0].name = "ralph-very-long-workflow-name";
			const row80 = hint(armedGraph, 80).split("\n")[1];
			assert.match(row80, /q again to quit ralph/);
			assert.match(row80, /│ GRAPH │\s*esc back · /);
			assert.match(row80, /· \? keys\b/);
		} finally {
			armedGraph.dispose();
		}
	});

	it("tool detail lists home/end scrolling in its hint and key overlay and ignores unlisted h hide (#5224)", () => {
		const onHide = vi.fn();
		const snap = makeSnap([]);
		snap.runs[0].toolNodes = [
			{
				kind: "tool",
				id: "tool-1",
				name: "bash",
				status: "completed",
				parentIds: [],
				args: { cmd: "echo ok" },
				result: "ok",
				startedAt: 1,
				endedAt: 2,
			},
		];
		const graph = view([], {
			store: makeStore(snap),
			onHide,
			piTui: { terminal: { rows: 40 } },
		});
		try {
			graph.handleInput(ENTER);
			const detailHint = hint(graph, 160).split("\n")[1];
			assert.match(detailHint, /esc back to graph/);
			assert.match(detailHint, /↑↓ pgup\/pgdn scroll/);
			assert.match(detailHint, /home\/end/);
			assert.doesNotMatch(detailHint, /h hide/);
			graph.handleInput("h");
			assert.equal(onHide.mock.calls.length, 0, "unlisted h does not hide from inside tool detail");
			graph.handleInput("?");
			const helpText = stripAnsi(graph.render(160).join("\n"));
			assert.match(helpText, /home\/end/);
		} finally {
			graph.dispose();
		}
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
			/New run from verify\? Reruns it and 2 completed tool steps in a new run\. Stops this run first, resumably\./,
		);
		assert.match(asking, /enter confirm {2}· {2}esc cancel/);
		assert.equal(fork.mock.calls.length, 0, "nothing forks before Enter");
		graph.handleInput(LEFT);
		assert.match(hint(graph), /enter confirm/, "Left does not cancel the confirmation (#5234)");
		graph.handleInput(ESC);
		assert.doesNotMatch(hint(graph), /New run from verify/, "Esc cancels the confirmation");
		assert.match(hint(graph), /f fork from stage/, "and stays in the detail");
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
		assert.match(hint(graph), /enter confirm/);
		snap.runs[0].stages[0] = stage("verify", "running");
		snap.version += 1;
		notify();
		assert.doesNotMatch(hint(graph), /New run from verify|enter confirm/);
		snap.runs[0].stages[0] = stage("verify", "failed", { error: "failed again" });
		snap.version += 1;
		notify();
		graph.handleInput(ENTER);
		assert.doesNotMatch(hint(graph), /enter confirm/);
		graph.handleInput(ENTER);
		assert.equal(fork.mock.calls.length, 0);
		graph.dispose();
	});

	it("recovering a scrolled failure reveals its focused node before and after resize (#5234)", () => {
		const stages = Array.from({ length: 30 }, (_, index) =>
			stage(
				`stage-${index}`,
				index === 29 ? "failed" : "completed",
				index === 29
					? {
							name: "selected-29",
							error: Array.from({ length: 400 }, (_, line) => `log-entry-${line}`).join("\n"),
						}
					: {},
				index === 0 ? [] : [`stage-${index - 1}`],
			),
		);
		const snap = makeSnap(stages);
		let notify = () => {};
		const store = {
			...makeStore(snap),
			subscribeInvalidation: (listener) => {
				notify = listener;
				return () => {};
			},
		};
		const terminal = { rows: 14 };
		const graph = view([], { store, piTui: { terminal }, initialFocusedStageId: "stage-29" });
		try {
			graph.render(80);
			graph.handleInput(ENTER);
			graph.handleInput("l");
			graph.render(80);
			for (let page = 0; page < 20; page++) graph.handleInput("\x1b[6~");
			graph.render(80);
			assert.ok(graph._graphScrollOffset > 0);
			snap.runs[0].stages[29] = { ...stages[29], status: "running", error: undefined };
			snap.version++;
			notify();
			const recovered = stripAnsi(graph.render(80).join("\n"));
			assert.match(recovered, /selected-29/);
			assert.doesNotMatch(recovered, /log-entry-/);
			terminal.rows = 22;
			assert.match(stripAnsi(graph.render(160).join("\n")), /selected-29/);
		} finally {
			graph.dispose();
		}
	});

	it("removing the selected run cancels its failure detail and armed fork (#5234)", async () => {
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
		try {
			graph.handleInput(ENTER);
			graph.handleInput("f");
			await settle();
			assert.match(hint(graph), /enter confirm/);
			snap.runs = [];
			snap.version++;
			notify();
			graph.render(160);
			graph.handleInput(ENTER);
			assert.equal(fork.mock.calls.length, 0);
			assert.doesNotMatch(hint(graph), /enter confirm|retry from stage/);
		} finally {
			graph.dispose();
		}
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
		assert.doesNotMatch(hint(graph), /New run from verify|enter confirm|Checking where/);
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

	it("a fork keeps a nested failed stage focused when its child run gets a new identity (#5234)", async () => {
		const snap = makeSnap([]);
		snap.runs = ["1", "2"].flatMap((suffix) => {
			const runId = `run-${suffix}`;
			const childId = `child-${suffix}`;
			return [
				{
					...h.makeRun([
						stage("pre", "completed"),
						stage(
							"boundary",
							"completed",
							{ workflowChildRun: { alias: "child", workflow: "child", runId: childId } },
							["pre"],
						),
					]),
					id: runId,
				},
				{
					...h.makeRun([stage("verify", "failed", { error: "boom" })]),
					id: childId,
					name: "child",
					parentRunId: runId,
					parentStageId: "boundary",
					rootRunId: runId,
					status: "completed",
				},
			];
		});
		const pane = new WorkflowAttachPane({
			store: makeStore(snap),
			runId: "run-1",
			graphTheme: defaultTheme,
			piKeybindings: makeFakeKeybindings(),
			onClose: () => {},
			stageActions: {
				forkTarget: async () => ({ ok: true, stagePath: "child.verify", rerunToolSteps: 0, live: false }),
				fork: async () => ({ ok: true, message: "forked", runId: "run-2" }),
			},
		});
		try {
			pane.handleInput(DOWN);
			pane.handleInput(ENTER);
			assert.match(stripAnsi(pane.render(160).join("\n")), /Reason\s+boom/);
			pane.handleInput("f");
			await settle();
			pane.handleInput(ENTER);
			await settle();
			assert.equal(pane._runId, "run-2");
			assert.match(stripAnsi(pane.render(160).join("\n")), /open failure detail/);
		} finally {
			pane.dispose();
		}
	});

	it("a retained graph can show a newly forked run after being hidden and shown (#5234)", async () => {
		const snap = makeSnap([stage("verify", "failed")]);
		snap.runs.push({ ...snap.runs[0], id: "run-2" });
		const pane = new WorkflowAttachPane({
			store: makeStore(snap),
			runId: "run-1",
			graphTheme: defaultTheme,
			piKeybindings: makeFakeKeybindings(),
			onClose: () => {},
			stageActions: {
				forkTarget: async () => ({ ok: true, stagePath: "verify", rerunToolSteps: 0, live: false }),
				fork: async () => ({ ok: true, message: "forked", runId: "run-2" }),
			},
		});
		try {
			pane.setVisible(false);
			pane.setVisible(true);
			pane.handleInput(ENTER);
			pane.handleInput("f");
			await settle();
			pane.handleInput(ENTER);
			await settle();
			assert.equal(pane._runId, "run-2");
		} finally {
			pane.dispose();
		}
	});

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
		assert.doesNotMatch(hint(graph), /enter confirm/);
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

	it.each(["x", "h"])("a remapped %s stop stays visible under narrow-width pressure (#5234)", (stopKey) => {
		const defaults = makeFakeKeybindings();
		const graph = view(
			[stage("A", "completed"), stage("B", "running", {}, ["A"]), stage("C", "running", {}, ["A"])],
			{
				onHide: () => {},
				stageActions: { stop: async () => ({ ok: true, message: "" }) },
				piKeybindings: {
					matches: (data, action) =>
						action === APP_ACTION.listStop
							? data === stopKey
							: action === APP_ACTION.keysHelp
								? data === "?"
								: defaults.matches(data, action),
					getKeys: (action) =>
						action === APP_ACTION.listStop ? [stopKey] : action === APP_ACTION.keysHelp ? ["?"] : [],
				},
			},
		);
		try {
			graph.handleInput(DOWN);
			assert.match(hint(graph, 80), new RegExp(`${stopKey} stop\\b`));
			assert.match(hint(graph, 80), /\? keys/);
		} finally {
			graph.dispose();
		}
	});

	it("at 40 columns the hint keeps esc back and the keys help as complete entries, including armed quit and remapped keys (#5224)", () => {
		const actions = {
			stop: async () => ({ ok: true, message: "" }),
			pauseRun: async () => ({ ok: true, message: "" }),
			resumeRun: async () => ({ ok: true, message: "" }),
			quitRun: async () => ({ ok: true, message: "" }),
		};
		const defaults = makeFakeKeybindings();
		const remapped = {
			matches: (data, action) =>
				action === APP_ACTION.listStop
					? data === "s"
					: action === APP_ACTION.keysHelp
						? data === "\x1bOP"
						: defaults.matches(data, action),
			getKeys: (action) => (action === APP_ACTION.listStop ? ["s"] : action === APP_ACTION.keysHelp ? ["f1"] : []),
		};
		for (const scenario of [
			{ label: "default", piKeybindings: defaults, help: "? keys", stop: "x", armed: false },
			{ label: "armed quit", piKeybindings: defaults, help: "? keys", stop: "x", armed: true },
			{ label: "remapped", piKeybindings: remapped, help: "f1 keys", stop: "s", armed: false },
			{ label: "remapped armed quit", piKeybindings: remapped, help: "f1 keys", stop: "s", armed: true },
		]) {
			const snap = makeSnap([stage("A", "running"), stage("B", "pending", {}, ["A"])]);
			snap.runs[0].name = "ralph";
			const graph = view([], {
				store: makeStore(snap),
				piKeybindings: scenario.piKeybindings,
				onHide: () => {},
				onStageAttach: () => {},
				stageActions: actions,
			});
			try {
				if (scenario.armed) graph.handleInput("q");
				const row = hint(graph, 40).split("\n")[1];
				const segments = row
					.replace(/^.*│ GRAPH │\s*/, "")
					.trim()
					.split(/\s+·\s+/);
				assert.equal(segments[0], "esc back", `${scenario.label}: ${row}`);
				assert.ok(segments.includes(scenario.help), `${scenario.label} keeps ${scenario.help}: ${row}`);
				const complete = new Set(["esc back", "↵", "↓", scenario.stop, "p", "q", "/", "f", scenario.help, "h"]);
				for (const segment of segments) {
					assert.ok(
						complete.has(segment) || (scenario.armed && /^q again\b/.test(segment)),
						`${scenario.label} shows only complete entries, got "${segment}" in: ${row}`,
					);
				}
				if (scenario.armed) {
					assert.ok(
						segments.some((segment) => /^q again\b/.test(segment)),
						`${scenario.label} keeps the armed quit: ${row}`,
					);
				}
			} finally {
				graph.dispose();
			}
		}
		const completedSnap = makeSnap([stage("A", "completed")]);
		completedSnap.runs[0].name = "ralph";
		completedSnap.runs[0].status = "completed";
		completedSnap.runs[0].endedAt = 2_000;
		const completedGraph = view([], {
			store: makeStore(completedSnap),
			piKeybindings: new KeybindingsManager({ "app.list.stop": "h" }),
			onHide: () => {},
			onStageAttach: () => {},
			stageActions: actions,
		});
		try {
			const row = hint(completedGraph, 40).split("\n")[1];
			const segments = row
				.replace(/^.*│ GRAPH │\s*/, "")
				.trim()
				.split(/\s+·\s+/);
			assert.equal(segments[0], "esc back", `completed run with stop on h: ${row}`);
			assert.ok(segments.includes("? keys"), `completed run with stop on h keeps ? keys: ${row}`);
		} finally {
			completedGraph.dispose();
		}
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
		assert.match(narrow, /\/.*·.*f filter: running.*·.*\? keys.*·.*h/, "all live keys stay on the narrow hint line");
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
