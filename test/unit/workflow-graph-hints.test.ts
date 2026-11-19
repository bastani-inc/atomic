import assert from "node:assert/strict";
import type { NavKey } from "@bastani/atomic";
import { describe, it, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import type { GraphKeyTier } from "../../packages/workflows/src/tui/graph-view-render-helpers.js";
import type { GraphViewOpts } from "../../packages/workflows/src/tui/graph-view-types.js";
import { stripVTControlCharacters as stripAnsi } from "../helpers/visible-text.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import * as h from "./overlay-graph-helpers.js";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";
const ENTER = "\r";

function stage(
	id: string,
	status: StageSnapshot["status"],
	extra: Partial<StageSnapshot> = {},
	parents: string[] = [],
): StageSnapshot {
	return { ...h.makeStage(id, parents), status, startedAt: 1_000, endedAt: 2_000, ...extra };
}

function view(
	stages: StageSnapshot[],
	runExtra: Partial<RunSnapshot> = {},
	opts: Partial<GraphViewOpts> = {},
): GraphView {
	const run: RunSnapshot = { ...h.makeSnap(stages).runs[0]!, ...runExtra };
	return new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: run.id,
		store: h.makeStore({ runs: [run], notices: [], version: 1 }),
		graphTheme: h.defaultTheme,
		piTui: h.makeTestTui(18),
		...opts,
	});
}

function plainLines(graph: GraphView, width = 160): string[] {
	return graph.render(width).map((line) => stripAnsi(line));
}

function hintLine(graph: GraphView, width = 160): string {
	const lines = plainLines(graph, width);
	const index = lines.findIndex((line) => line.includes("│ GRAPH │"));
	return index < 0
		? (lines.find((line) => /\besc back\b/.test(line))?.trim() ?? "")
		: lines[index]!.slice(lines[index]!.indexOf("│ GRAPH │") + 9).trim();
}

function toastLine(graph: GraphView, width = 160): string {
	const lines = plainLines(graph, width);
	const index = lines.findIndex((line) => line.includes("│ GRAPH │"));
	return index <= 0 ? "" : lines[index - 1]!.trim();
}

function bodyText(graph: GraphView, width = 120): string {
	return plainLines(graph, width).slice(3, -3).join("\n");
}

function overlayText(graph: GraphView, width = 120): string {
	graph.handleInput("?");
	const text = plainLines(graph, width).join("\n");
	graph.handleInput("?");
	return text;
}

class GraphViewWithoutRunDetailsKey extends GraphView {
	protected override _graphKeys(
		compact: boolean | GraphKeyTier = "full",
		frameContext?: { readonly run: RunSnapshot | null; readonly focused: StageSnapshot | undefined },
	): NavKey[] {
		return super._graphKeys(compact, frameContext).filter((entry) => entry.keys !== "o");
	}
}

describe("workflow graph, run-details, and stage-detail hints (#5224)", () => {
	it("preserves base graph hint labels and keys across widths 40..200 and adds o run details only where it fits (#5224)", () => {
		const stop = async () => ({ ok: true, message: "stopped" });
		const retry = async () => ({ ok: true, message: "retried" });

		const failed = view(
			[stage("A", "failed", { error: "boom" }), stage("B", "pending", {}, ["A"])],
			{},
			{
				stageActions: { stop, retry },
				onHide: () => {},
				onStageAttach: () => {},
			},
		);
		const running = view(
			[stage("A", "running"), stage("B", "pending", {}, ["A"]), stage("C", "pending", {}, ["A"])],
			{ status: "running" },
			{
				stageActions: { stop, retry },
				onHide: () => {},
				onStageAttach: () => {},
			},
		);
		const filtered = view(
			[stage("A", "running"), stage("B", "pending", {}, ["A"])],
			{ status: "running" },
			{
				stageActions: { stop },
				onHide: () => {},
				onStageAttach: () => {},
			},
		);
		filtered.handleInput("f");

		try {
			assert.match(hintLine(failed, 80), /↵/);
			assert.match(hintLine(failed, 200), /↵ open failure detail/);
			for (const width of [110, 120]) {
				assert.match(hintLine(failed, width), /\bh\b/, `failed stage at width ${width}`);
			}
			assert.match(hintLine(running, 90), /↵/);
			assert.match(hintLine(running, 90), /\bx\b/);
			assert.match(hintLine(running, 200), /↵ open stage chat/);
			assert.match(hintLine(running, 200), /x stop stage/);
			for (const width of [125, 140]) {
				assert.match(hintLine(running, width), /\bh\b/, `running stage at width ${width}`);
			}
			assert.match(hintLine(running, 200), /h hide {2}· {2}o run details$/);
			for (const width of [110, 120]) {
				assert.match(hintLine(filtered, width), /↵/, `filtered stage at width ${width}`);
				assert.match(hintLine(filtered, width), /\bx\b/, `filtered stage at width ${width}`);
			}
		} finally {
			failed.dispose();
			running.dispose();
			filtered.dispose();
		}

		const makePair = (stages: StageSnapshot[]) => {
			const run: RunSnapshot = { ...h.makeSnap(stages).runs[0]!, status: "running" };
			const sharedOpts: GraphViewOpts = {
				piKeybindings: makeFakeKeybindings(),
				mode: "overlay",
				runId: run.id,
				store: h.makeStore({ runs: [run], notices: [], version: 1 }),
				graphTheme: h.defaultTheme,
				piTui: h.makeTestTui(30),
				stageActions: { stop },
				onHide: () => {},
				onStageAttach: () => {},
			};
			return {
				withO: new GraphView(sharedOpts),
				withoutO: new GraphViewWithoutRunDetailsKey(sharedOpts),
			};
		};

		for (const stages of [
			[stage("A", "running"), stage("B", "pending", {}, ["A"])],
			[stage("A", "failed", { error: "boom" }), stage("B", "pending", {}, ["A"])],
			[stage("A", "running")],
		]) {
			const { withO, withoutO } = makePair(stages);
			try {
				for (let width = 40; width <= 200; width++) {
					const headEntries = hintLine(withO, width).split(/\s+·\s+/);
					const baseEntries = hintLine(withoutO, width).split(/\s+·\s+/);
					const missing = baseEntries.filter((entry) => !headEntries.includes(entry));
					assert.deepEqual(missing, [], `width ${width}: ${headEntries.join(" · ")}`);
					assert.equal(
						headEntries.some((entry) => /^\?(?: keys)?$/.test(entry)),
						baseEntries.some((entry) => /^\?(?: keys)?$/.test(entry)),
						`width ${width} preserves base help visibility`,
					);
				}
			} finally {
				withO.dispose();
				withoutO.dispose();
			}
		}
	});

	it("omits unavailable graph keys from the empty-graph hint while keeping ? help visible and live when no run is in the store (#5224)", () => {
		const store = createStore();
		let detached = 0;
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: h.defaultTheme,
			piTui: h.makeTestTui(24),
			onDetach: () => {
				detached += 1;
			},
		});
		try {
			const hint = hintLine(graph, 160);
			assert.equal(hint, "esc back  ·  ? keys");
			assert.equal(graph.handleInput("o"), false);
			assert.equal(graph.handleInput("/"), false);
			assert.equal(graph.handleInput("f"), false);
			assert.equal(graph._switcherOpen, false);
			assert.equal(graph.handleInput("?"), true);
			assert.match(plainLines(graph, 120).join("\n"), /keys · workflow graph/);
			assert.equal(graph.handleInput(ESC), true);
			assert.equal(detached, 0);
			assert.doesNotMatch(plainLines(graph, 120).join("\n"), /keys · workflow graph/);
			assert.equal(graph.handleInput(ESC), true);
			assert.equal(detached, 1);
		} finally {
			graph.dispose();
		}
	});

	it("keeps complete run-detail hints and labeled exits at 40 through 80 columns with two blockers (#5255)", () => {
		const graph = view(
			[stage("bad0", "failed", { error: "first failure" }), stage("bad1", "failed", { error: "second failure" })],
			{ status: "failed" },
		);
		try {
			graph.handleInput("o");
			const complete = new Set([
				"esc back",
				"esc back to graph",
				"↑↓",
				"↑↓ select",
				"→/↵",
				"→/↵ open",
				"l",
				"l logs",
				"pgup/pgdn",
				"pgup/pgdn scroll",
				"? keys",
			]);
			for (let width = 40; width <= 80; width++) {
				const shown = hintLine(graph, width);
				assert.match(shown, /esc back/, `width ${width}: ${shown}`);
				assert.match(shown, /\? keys/, `width ${width}: ${shown}`);
				for (const token of shown.split(/\s+·\s+/)) assert.ok(complete.has(token), `incomplete hint: ${token}`);
			}
		} finally {
			graph.dispose();
		}
	});

	it("advertises an Up help binding only as help rather than blocker selection (#5255)", () => {
		const keybindings = {
			...makeFakeKeybindings({ "app.keys.help": [UP] }),
			getKeys: (action: string) => (action === "app.keys.help" ? ["up"] : []),
		};
		const graph = view(
			[stage("bad0", "failed", { error: "first failure" }), stage("bad1", "failed", { error: "second failure" })],
			{ status: "failed" },
			{ piKeybindings: keybindings },
		);
		try {
			graph.handleInput("o");
			const shown = hintLine(graph, 160);
			assert.equal(shown.match(/↑/g)?.length, 1, shown);
			assert.match(shown, /↓ select/);
			assert.match(shown, /↑ keys/);
			graph.handleInput(DOWN);
			assert.match(bodyText(graph), /❯ ✗ bad1/);
			graph.handleInput(UP);
			const help = plainLines(graph, 140).join("\n");
			assert.match(help, /keys · run details/);
			assert.match(help, /│\s+↓\s+select/);
			assert.match(help, /│\s+esc\/↑\s+close this help/);
			graph.handleInput(ESC);
			assert.match(bodyText(graph), /❯ ✗ bad1/);
		} finally {
			graph.dispose();
		}
	});

	it("omits shadowed keys when help is remapped to l or o (#5224)", () => {
		const run: RunSnapshot = {
			...h.makeSnap([
				stage("bad0", "failed", { error: "bad0 broke" }),
				stage("bad1", "failed", { error: "bad1 broke" }),
			]).runs[0]!,
			status: "failed",
			error: "bad0 broke",
		};
		const helpOnL = {
			...makeFakeKeybindings({ "app.keys.help": ["l"] }),
			getKeys: (action: string) => (action === "app.keys.help" ? ["l"] : []),
		};
		const graphL = new GraphView({
			piKeybindings: helpOnL,
			mode: "overlay",
			runId: run.id,
			store: h.makeStore({ runs: [run], notices: [], version: 1 }),
			graphTheme: h.defaultTheme,
			piTui: h.makeTestTui(20),
		});
		try {
			graphL.handleInput("o");
			const shownHint = hintLine(graphL, 160);
			assert.doesNotMatch(shownHint, /l logs/);
			assert.match(shownHint, /l keys$/);
			graphL.handleInput("l");
			assert.match(plainLines(graphL, 120).join("\n"), /keys · run details/);
		} finally {
			graphL.dispose();
		}

		const helpOnO = {
			...makeFakeKeybindings({ "app.keys.help": ["o"] }),
			getKeys: (action: string) => (action === "app.keys.help" ? ["o"] : []),
		};
		const graphO = new GraphView({
			piKeybindings: helpOnO,
			mode: "overlay",
			runId: run.id,
			store: h.makeStore({ runs: [run], notices: [], version: 1 }),
			graphTheme: h.defaultTheme,
			piTui: h.makeTestTui(20),
		});
		try {
			const shownHint = hintLine(graphO, 160);
			assert.doesNotMatch(shownHint, /o run details/);
			assert.match(shownHint, /o keys$/);
			graphO.handleInput("o");
			assert.match(plainLines(graphO, 120).join("\n"), /keys · workflow graph/);
		} finally {
			graphO.dispose();
		}
	});

	it("matches run-details hint and ? overlay keys to live keys across 0, 1, and 2 blockers and log mode (#5224)", () => {
		const completedStages = Array.from({ length: 12 }, (_, i) =>
			stage(`s${i}`, "completed", { startedAt: 1_000 + i * 100, endedAt: 1_050 + i * 100 }),
		);
		const outputs = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`out_${i}`, `val_${i}`]));
		const longError = ["bad0 broke", ...Array.from({ length: 30 }, (_, i) => `    at frame_${i} (f.ts:${i}:1)`)].join(
			"\n",
		);

		const zeroBlockers = view(completedStages, {
			status: "completed",
			startedAt: 1_000,
			endedAt: 5_000,
			result: outputs,
		});
		try {
			zeroBlockers.handleInput("o");
			const hint = hintLine(zeroBlockers, 140);
			const hint80 = hintLine(zeroBlockers, 80);
			const help = overlayText(zeroBlockers, 140);
			assert.match(hint, /esc back to graph {2}· {2}l logs {2}· {2}↑↓ pgup\/pgdn scroll {2}· {2}\? keys/);
			assert.equal(hint80, "esc back to graph  ·  l logs  ·  ↑↓ pgup/pgdn scroll  ·  ? keys");
			assert.doesNotMatch(hint, /select|open/);
			assert.match(help, /↑↓ pgup\/pgdn\s+scroll/);
			assert.doesNotMatch(help, /\bopen\b|\bselect\b/);
			const before = bodyText(zeroBlockers);
			zeroBlockers.handleInput(DOWN);
			assert.notEqual(bodyText(zeroBlockers), before);
			zeroBlockers.handleInput(UP);
			assert.equal(bodyText(zeroBlockers), before);
		} finally {
			zeroBlockers.dispose();
		}

		const oneBlocker = view([...completedStages, stage("bad0", "failed", { error: longError })], {
			status: "failed",
			error: longError,
			failedStageId: "bad0",
			result: outputs,
		});
		try {
			oneBlocker.handleInput("o");
			const hint = hintLine(oneBlocker, 140);
			const hint80 = hintLine(oneBlocker, 80);
			const help = overlayText(oneBlocker, 140);
			assert.match(
				hint,
				/esc back to graph {2}· {2}→\/↵ open {2}· {2}l logs {2}· {2}↑↓ pgup\/pgdn scroll {2}· {2}\? keys/,
			);
			assert.equal(hint80, "esc back to graph · →/↵ open · l logs · ↑↓ pgup/pgdn scroll · ? keys");
			assert.doesNotMatch(hint, /↑↓ select/);
			assert.match(help, /→\/↵\s+open/);
			assert.match(help, /↑↓ pgup\/pgdn\s+scroll/);
			const before = bodyText(oneBlocker);
			oneBlocker.handleInput(LEFT);
			assert.equal(bodyText(oneBlocker), before, "← is inert in run details");
			oneBlocker.handleInput(DOWN);
			assert.notEqual(bodyText(oneBlocker), before, "↓ scrolls when there is only one blocker");
			oneBlocker.handleInput(UP);
			assert.equal(bodyText(oneBlocker), before, "↑ scrolls back when there is only one blocker");
			oneBlocker.handleInput(RIGHT);
			assert.match(bodyText(oneBlocker), /✗ bad0 · failed/, "→ opens the blocker detail");
		} finally {
			oneBlocker.dispose();
		}

		const twoBlockers = view(
			[
				...completedStages,
				stage("bad0", "failed", { error: longError }),
				stage("bad1", "failed", { error: "bad1 broke" }),
			],
			{ status: "failed", error: longError, failedStageId: "bad0", result: outputs },
		);
		try {
			twoBlockers.handleInput("o");
			const hint = hintLine(twoBlockers, 140);
			const hint80 = hintLine(twoBlockers, 80);
			const help = overlayText(twoBlockers, 140);
			assert.match(
				hint,
				/esc back to graph {2}· {2}↑↓ select {2}· {2}→\/↵ open {2}· {2}l logs {2}· {2}pgup\/pgdn scroll {2}· {2}\? keys/,
			);
			assert.equal(hint80, "esc back · ↑↓ select · →/↵ open · l logs · pgup/pgdn scroll · ? keys");
			assert.match(help, /↑↓\s+select/);
			assert.match(help, /→\/↵\s+open/);
			assert.match(help, /pgup\/pgdn\s+scroll/);

			twoBlockers.handleInput("l");
			const logHint = hintLine(twoBlockers, 140);
			const logHint80 = hintLine(twoBlockers, 80);
			const logHelp = overlayText(twoBlockers, 140);
			assert.match(logHint, /esc back to graph {2}· {2}l summary {2}· {2}↑↓ pgup\/pgdn scroll {2}· {2}\? keys/);
			assert.equal(logHint80, "esc back to graph  ·  l summary  ·  ↑↓ pgup/pgdn scroll  ·  ? keys");
			assert.doesNotMatch(logHint, /select|open/);
			assert.match(logHelp, /↑↓ pgup\/pgdn\s+scroll/);
			const logBefore = bodyText(twoBlockers);
			twoBlockers.handleInput(DOWN);
			assert.notEqual(bodyText(twoBlockers), logBefore, "↓ scrolls the log view");
		} finally {
			twoBlockers.dispose();
		}
	});

	it("renders failed-stage detail actions in order with every live key (#5224)", async () => {
		const failedStage = stage("verify", "failed", {
			error: ["gate failed", ...Array.from({ length: 30 }, (_, i) => `    at step_${i} (gate.ts:${i}:1)`)].join(
				"\n",
			),
		});
		const retry = vi.fn(async () => ({ ok: true, message: "Retried" }));
		const fork = vi.fn(async () => ({ ok: true, message: "Forked" }));
		const forkTarget = vi.fn(async () => ({
			ok: true as const,
			stagePath: "verify",
			rerunToolSteps: 0,
			live: false,
		}));
		const onStageAttach = vi.fn();

		const full = view(
			[failedStage],
			{ status: "failed" },
			{
				onStageAttach,
				stageActions: { retry, fork, forkTarget },
			},
		);
		try {
			full.handleInput(ENTER);
			assert.equal(
				hintLine(full, 160),
				"r retry from stage  ·  f fork from stage  ·  t transcript  ·  l logs  ·  esc back  ·  ? keys",
			);
			assert.equal(
				hintLine(full, 104),
				"r retry from stage  ·  f fork from stage  ·  t transcript  ·  l logs  ·  esc back  ·  ? keys",
			);
			assert.equal(hintLine(full, 80), "r retry · f fork · t transcript · l logs · esc back · ? keys");
			const help = overlayText(full, 120);
			assert.match(help, /keys · stage detail/);
			const helpRows = help
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => /^│\s+(r|f|t|l|esc)\s+/.test(line));
			assert.equal(helpRows.length, 5);
			assert.match(helpRows[0]!, /^│\s+r\s+retry from stage\s+│$/);
			assert.match(helpRows[1]!, /^│\s+f\s+fork from stage\s+│$/);
			assert.match(helpRows[2]!, /^│\s+t\s+transcript\s+│$/);
			assert.match(helpRows[3]!, /^│\s+l\s+logs\s+│$/);
			assert.match(helpRows[4]!, /^│\s+esc\s+back\s+│$/);

			full.handleInput("l");
			assert.equal(
				hintLine(full, 160),
				"r retry from stage  ·  f fork from stage  ·  t transcript  ·  l summary  ·  esc back  ·  ↑↓ pgup/pgdn scroll  ·  ? keys",
			);
			assert.equal(hintLine(full, 80), "r retry · f fork · t chat · l summary · esc back · ↑↓ · ? keys");
			const logBefore = bodyText(full);
			full.handleInput(DOWN);
			assert.notEqual(bodyText(full), logBefore);
			full.handleInput(PGDN);
			const afterPgdn = bodyText(full);
			assert.notEqual(afterPgdn, logBefore);
			full.handleInput(PGUP);
			full.handleInput(UP);
			assert.equal(bodyText(full), logBefore);
		} finally {
			full.dispose();
		}

		for (const hasRetry of [false, true]) {
			for (const hasFork of [false, true]) {
				for (const hasTranscript of [false, true]) {
					let retried = 0;
					let forked = 0;
					let attached = 0;
					const graph = view(
						[failedStage],
						{ status: "failed" },
						{
							...(hasTranscript
								? {
										onStageAttach: () => {
											attached += 1;
										},
									}
								: {}),
							stageActions: {
								...(hasRetry
									? {
											retry: async () => {
												retried += 1;
												return { ok: true, message: "ok" };
											},
										}
									: {}),
								...(hasFork
									? {
											fork: async () => ({ ok: true, message: "ok" }),
											forkTarget: async () => {
												forked += 1;
												return { ok: true as const, stagePath: "verify", rerunToolSteps: 0, live: false };
											},
										}
									: {}),
							},
						},
					);
					try {
						graph.handleInput(ENTER);
						const shown = hintLine(graph, 160);
						assert.equal(/\br retry from stage\b/.test(shown), hasRetry);
						assert.equal(/\bf fork from stage\b/.test(shown), hasFork);
						assert.equal(/\bt transcript\b/.test(shown), hasTranscript);
						assert.match(shown, /\bl logs\b/);
						assert.match(shown, /\besc back\b/);
						assert.match(shown, /\? keys$/);

						graph.handleInput("r");
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
						assert.equal(retried, hasRetry ? 1 : 0);
						graph.handleInput("f");
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
						assert.equal(forked, hasFork ? 1 : 0);
						if (hasFork) graph.handleInput(ESC);
						graph.handleInput("t");
						assert.equal(attached, hasTranscript ? 1 : 0);
					} finally {
						graph.dispose();
					}
				}
			}
		}
	});

	it("shows ANSI escape sequences and bidi controls as printable data before truncating notices (#5224)", async () => {
		const shortGraph = view(
			[stage("A", "running")],
			{ status: "running" },
			{
				stageActions: {
					stop: async () => ({ ok: true, message: "\x1b[31mboom\x1b[39m\t\u202e!" }),
				},
			},
		);
		const longGraph = view(
			[stage("A", "running")],
			{ status: "running" },
			{
				stageActions: {
					stop: async () => ({ ok: true, message: `prefix-${"x".repeat(120)}` }),
				},
			},
		);
		try {
			shortGraph.handleInput("x");
			shortGraph.handleInput("x");
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const shortToast = toastLine(shortGraph, 80);
			assert.match(shortToast, /\\x1b\[31mboom\\x1b\[39m\s+<U\+202E>!/);
			assert.doesNotMatch(shortToast, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
			assert.doesNotMatch(shortToast, /…$/);

			longGraph.handleInput("x");
			longGraph.handleInput("x");
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const longToast = toastLine(longGraph, 80);
			assert.match(longToast, /prefix-x+…$/);
		} finally {
			shortGraph.dispose();
			longGraph.dispose();
		}
	});
});
