import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { defaultTheme, makeRun, makeStage, makeStore, makeTestTui } from "./overlay-graph-helpers.js";

const renderWidths = vi.hoisted(() => [] as number[]);

vi.mock("../../packages/workflows/src/tui/run-outcome.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../packages/workflows/src/tui/run-outcome.js")>();
	return {
		...original,
		renderRunOutcome: (...args: Parameters<typeof original.renderRunOutcome>) => {
			renderWidths.push(args[1].width);
			return original.renderRunOutcome(...args);
		},
	};
});

const DOWN = "\x1b[B";
const UP = "\x1b[A";

function waitingStages(count: number): StageSnapshot[] {
	return Array.from({ length: count }, (_, index) => ({
		...makeStage(`q${String(index).padStart(2, "0")}`),
		status: "awaiting_input",
		pendingPrompt: { id: `p${index}`, kind: "confirm", message: `question ${index}?`, createdAt: 1 },
	}));
}

function view(run: RunSnapshot, rows: number): GraphView {
	return new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode: "overlay",
		runId: run.id,
		store: makeStore({ runs: [run], notices: [], version: 1 }),
		graphTheme: defaultTheme,
		piTui: makeTestTui(rows),
	});
}

function lines(graph: GraphView, width: number): string[] {
	return graph.render(width).map(stripTerminalSequences);
}

describe("workflow run-details rendering (#5224)", () => {
	beforeEach(() => vi.useFakeTimers({ now: 10_000 }));
	afterEach(() => vi.useRealTimers());

	it("keeps the selected blocker and its action visible while moving down and up (#5224)", () => {
		const graph = view(makeRun(waitingStages(30)), 20);
		try {
			graph.handleInput("o");
			lines(graph, 120);
			for (const direction of [DOWN, UP]) {
				for (let step = 1; step <= 29; step++) {
					graph.handleInput(direction);
					const frame = lines(graph, 120);
					const expected = direction === DOWN ? step : 29 - step;
					const selected = frame.findIndex((line) => line.includes(`❯ ◆ q${String(expected).padStart(2, "0")}`));
					assert.ok(selected >= 0, `blocker ${expected} is visible after ${direction === DOWN ? "down" : "up"}`);
					assert.match(frame[selected + 1] ?? "", /enter answer in the stage chat/);
				}
			}
		} finally {
			graph.dispose();
		}
	});

	it("keeps the selected blocker visible when only one detail row fits (#5224)", () => {
		for (const rows of [7, 9, 11]) {
			const graph = view(makeRun(waitingStages(3)), rows);
			try {
				graph.handleInput("o");
				lines(graph, 120);
				for (const [direction, expected] of [
					[DOWN, "q01"],
					[DOWN, "q02"],
					[UP, "q01"],
					[UP, "q00"],
				] as const) {
					graph.handleInput(direction);
					assert.ok(
						lines(graph, 120).some((line) => line.includes(`❯ ◆ ${expected}`)),
						`selection ${expected} is visible in a ${rows}-row terminal`,
					);
				}
			} finally {
				graph.dispose();
			}
		}
	});

	it("refreshes a nested question when only the child workflow changes (#5224)", () => {
		const store = createStore();
		store.recordRunStart({
			...makeRun([
				{
					...makeStage("boundary"),
					status: "running",
					workflowChildRun: { alias: "child", workflow: "child", runId: "child" },
				},
			]),
		});
		store.recordRunStart({
			...makeRun([
				{
					...makeStage("approve"),
					status: "awaiting_input",
					pendingPrompt: { id: "approval", kind: "confirm", message: "Approve the plan?", createdAt: 1 },
				},
			]),
			id: "child",
			parentRunId: "run-1",
			parentStageId: "boundary",
			rootRunId: "run-1",
		});
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(40),
		});
		try {
			graph.handleInput("o");
			assert.match(lines(graph, 120).join("\n"), /Approve the plan\?/);
			store.batch(() => {
				assert.equal(store.resolveStagePendingPrompt("child", "approve", "approval", true), true);
				assert.equal(
					store.recordStagePendingPrompt("child", "approve", {
						id: "revised-approval",
						kind: "confirm",
						message: "Approve the revised plan?",
						createdAt: 2,
					}),
					true,
				);
			});
			const frame = lines(graph, 120).join("\n");
			assert.match(frame, /Approve the revised plan\?/);
			assert.doesNotMatch(frame, /Approve the plan\?/);
		} finally {
			graph.dispose();
		}
	});

	it("lays out tall run details once per selection change at the painted width (#5224)", () => {
		const graph = view(makeRun(waitingStages(30)), 20);
		try {
			graph.handleInput("o");
			lines(graph, 120);
			for (const direction of [DOWN, DOWN, DOWN, UP, UP, UP]) {
				renderWidths.length = 0;
				graph.handleInput(direction);
				const frame = lines(graph, 120);
				assert.ok(frame.some((line) => /❯ ◆ q\d{2}/.test(line)));
				assert.deepEqual(renderWidths, [119], "measurement, reveal and paint share the same layout");
			}
			renderWidths.length = 0;
			lines(graph, 120);
			assert.deepEqual(renderWidths, [], "an unchanged frame reuses the detail layout");
			vi.setSystemTime(10_400);
			lines(graph, 120);
			assert.deepEqual(renderWidths, [], "sub-second ticks within the same elapsed second reuse the detail layout");
			vi.setSystemTime(11_000);
			lines(graph, 120);
			assert.deepEqual(
				renderWidths,
				[119],
				"crossing into the next elapsed second re-renders the detail layout once",
			);
		} finally {
			graph.dispose();
		}
	});

	it("reuses run-detail layout within an elapsed second and refreshes at the next second (#5224)", () => {
		const graph = view({ ...makeRun([]), status: "running", startedAt: 1_000, endedAt: undefined }, 20);
		try {
			graph.handleInput("o");
			lines(graph, 120);
			renderWidths.length = 0;
			for (const offset of [1, 200, 499, 999]) {
				vi.setSystemTime(10_000 + offset);
				lines(graph, 120);
			}
			assert.deepEqual(renderWidths, []);
			vi.setSystemTime(11_000);
			assert.match(lines(graph, 120).join("\n"), /running · 10s/);
			assert.deepEqual(renderWidths, [120]);
		} finally {
			graph.dispose();
		}
	});

	it("renders failed-stage token usage from the full store run when graphSnapshot compacts modelAttempts, including when usage arrives after initial render (#5224)", () => {
		const compactStage: StageSnapshot = {
			...makeStage("verify"),
			status: "failed",
			startedAt: 1_000,
			endedAt: 5_000,
			error: "verify gate failed",
		};
		const compactRun: RunSnapshot = {
			...makeRun([compactStage]),
			status: "failed",
			error: "verify gate failed",
		};
		let fullStage: StageSnapshot = compactStage;
		const baseStore = makeStore({ runs: [compactRun], notices: [], version: 1 });
		const store = {
			...baseStore,
			run: (id: string) => (id === compactRun.id ? { ...compactRun, stages: [fullStage] } : undefined),
		};
		const graph = new GraphView({
			piKeybindings: makeFakeKeybindings(),
			mode: "overlay",
			runId: compactRun.id,
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(24),
		});
		try {
			graph.handleInput("o");
			lines(graph, 120);
			graph.handleInput("\r");
			for (const width of [40, 80, 160]) {
				const frame = lines(graph, width).join("\n");
				assert.match(frame, /verify · failed/);
			}
			assert.doesNotMatch(lines(graph, 120).join("\n"), /18\.4k tokens/);
			fullStage = {
				...compactStage,
				modelAttempts: [
					{
						model: "fixture/verify",
						success: false,
						usage: { input: 12_000, output: 6_400, cacheRead: 0, cacheWrite: 0, cost: 0 },
					},
				],
			};
			assert.match(lines(graph, 120).join("\n"), /18\.4k tokens/);
		} finally {
			graph.dispose();
		}
	});
});
