import { describe, test, vi } from "vitest";
import type { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createStageScheduler } from "../../packages/workflows/src/runs/foreground/executor-scheduler.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { findSnapshotRun, findSnapshotStage } from "../../packages/workflows/src/shared/workflow-run-ownership.js";
import { GraphViewLayout } from "../../packages/workflows/src/tui/graph-view-layout.js";
import { installStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { assert } from "./executor-shared.js";

const widgetFrames = vi.hoisted(() => [] as StoreSnapshot[]);

vi.mock("../../packages/workflows/src/tui/widget.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/tui/widget.js")>();
	return {
		...actual,
		buildThemedWidgetLines: (...args: Parameters<typeof actual.buildThemedWidgetLines>) => {
			if (args[1] !== undefined) widgetFrames.push(args[0]);
			return actual.buildThemedWidgetLines(...args);
		},
	};
});

/** Stages of one lane: each one's parent is the one before it. */
function chain(count: number, status: StageSnapshot["status"] = "completed"): StageSnapshot[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `stage-${index}`,
		name: `stage-${index}`,
		status,
		parentIds: index === 0 ? [] : [`stage-${index - 1}`],
		toolEvents: [],
	}));
}

function runOf(stages: StageSnapshot[]): RunSnapshot {
	return { id: "run-4642", name: "long run", inputs: {}, status: "running", stages, toolNodes: [], startedAt: 1 };
}

describe("frame and event work does not grow with the stages a run finished", () => {
	test("a lookup into a frozen snapshot array asks whether it is frozen once, not once per lookup (#4642)", () => {
		const stages = Object.freeze(chain(300).map((stage) => Object.freeze(stage)));
		const runs = Object.freeze([Object.freeze(runOf([...stages]))]);
		const isFrozen = vi.spyOn(Object, "isFrozen");
		try {
			for (let lookup = 0; lookup < 100; lookup++) {
				assert.equal(findSnapshotStage(stages, `stage-${lookup}`)?.id, `stage-${lookup}`);
				assert.equal(findSnapshotRun(runs, "run-4642"), runs[0]);
			}
			assert.equal(findSnapshotStage(stages, "missing"), undefined);
			assert.equal(isFrozen.mock.calls.filter(([value]) => value === stages).length, 1);
			assert.equal(isFrozen.mock.calls.filter(([value]) => value === runs).length, 1);
		} finally {
			isFrozen.mockRestore();
		}
	});

	test("a lookup into a frozen snapshot array reads its elements once, to build the index (#4642)", () => {
		let reads = 0;
		const counted = <T extends object>(items: readonly T[]): readonly T[] =>
			new Proxy(Object.freeze([...items]), {
				get(target, property, receiver) {
					if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
					return Reflect.get(target, property, receiver);
				},
			});
		const stages = counted(chain(50).map((stage) => Object.freeze(stage)));
		const runs = counted([Object.freeze(runOf([])), Object.freeze({ ...runOf([]), id: "run-other" })]);
		assert.equal(findSnapshotStage(stages, "stage-0")?.id, "stage-0");
		assert.equal(findSnapshotRun(runs, "run-other")?.id, "run-other");
		const built = reads;
		for (let lookup = 0; lookup < 50; lookup++) {
			assert.equal(findSnapshotStage(stages, `stage-${lookup}`)?.id, `stage-${lookup}`);
			assert.equal(findSnapshotRun(runs, "run-4642")?.id, "run-4642");
		}
		assert.equal(reads, built, "every later lookup used the index");
	});

	test("a lookup into a mutable array sees the array as it is now (#4642)", () => {
		const stages = chain(3);
		assert.equal(findSnapshotStage(stages, "stage-3"), undefined);
		const added: StageSnapshot = { ...stages[0]!, id: "stage-3" };
		stages.push(added);
		assert.equal(findSnapshotStage(stages, "stage-3"), added);
		const runs = [runOf([])];
		assert.equal(findSnapshotRun(runs, "run-later"), undefined);
		const later = { ...runOf([]), id: "run-later" };
		runs.push(later);
		assert.equal(findSnapshotRun(runs, "run-later"), later);
	});

	test("admitting a stage walks no ancestors while no stage is paused or blocked (#4642)", () => {
		const stages = chain(300);
		const parentsOf = new Map(stages.map((stage) => [stage.id, stage.parentIds]));
		let parentReads = 0;
		const tracker = {
			getParents(stageId: string): string[] {
				parentReads += 1;
				return [...(parentsOf.get(stageId) ?? [])];
			},
		} as GraphFrontierTracker;
		const scheduler = createStageScheduler({
			runId: "run-4642",
			runSnapshot: runOf(stages),
			activeStore: createStore(),
			tracker,
			stageRegistry: () => createStageControlRegistry(),
		});
		const admitted: StageSnapshot = { ...chain(1)[0]!, id: "stage-300", parentIds: ["stage-299"], status: "pending" };

		assert.equal(scheduler.blockingAncestorFor(admitted), undefined);
		assert.equal(parentReads, 0);

		stages[150]!.status = "paused";
		assert.equal(scheduler.blockingAncestorFor(admitted), "stage-150");
		assert.equal(parentReads, 149, "the walk stops at the paused ancestor, reading each ancestor's parents once");

		stages[150]!.status = "completed";
		stages[0]!.status = "blocked";
		assert.equal(scheduler.blockingAncestorFor(admitted), "stage-0");

		stages[0]!.status = "completed";
		const unrelated: StageSnapshot = { ...chain(1)[0]!, id: "elsewhere", status: "paused" };
		stages.push(unrelated);
		parentReads = 0;
		assert.equal(
			scheduler.blockingAncestorFor(admitted),
			undefined,
			"a paused stage that is no ancestor blocks nothing",
		);
		assert.equal(parentReads, 300, "each of the 300 ancestors' parents read once");
	});

	test("ancestors shared by several paths are walked once (#4642)", () => {
		const parentsOf = new Map<string, string[]>([
			["left", ["root"]],
			["right", ["root"]],
			["root", []],
		]);
		let parentReads = 0;
		const stages: StageSnapshot[] = ["root", "left", "right", "elsewhere"].map((id) => ({
			id,
			name: id,
			status: id === "elsewhere" ? "paused" : "completed",
			parentIds: parentsOf.get(id) ?? [],
			toolEvents: [],
		}));
		const scheduler = createStageScheduler({
			runId: "run-4642",
			runSnapshot: runOf(stages),
			activeStore: createStore(),
			tracker: {
				getParents(stageId: string): string[] {
					parentReads += 1;
					return [...(parentsOf.get(stageId) ?? [])];
				},
			} as GraphFrontierTracker,
			stageRegistry: () => createStageControlRegistry(),
		});
		const joined: StageSnapshot = { ...stages[0]!, id: "join", parentIds: ["left", "right"], status: "pending" };

		assert.equal(scheduler.blockingAncestorFor(joined), undefined);
		assert.equal(parentReads, 3, "left, right and root once each");
	});

	test("every widget frame between store changes renders the store's frozen snapshot of that version (#4642)", () => {
		const store = createStore();
		store.recordRunStart(runOf([...chain(200), ...chain(1, "running").map((stage) => ({ ...stage, id: "live" }))]));
		let factory: ((tui: object, theme: object) => { render(width: number): string[] }) | undefined;
		const dispose = installStoreWidget(
			{
				ui: {
					setWidget: (_key, next) => {
						factory = next as typeof factory;
					},
					requestRender: () => {},
				},
			},
			store,
		);
		try {
			assert.ok(factory, "the widget mounted");
			const component = factory({ terminal: { rows: 40 }, requestRender: () => {} }, {});
			widgetFrames.length = 0;
			for (let frame = 0; frame < 5; frame++) component.render(120);
			const version = store.graphSnapshot();
			assert.equal(widgetFrames.length, 5);
			assert.ok(widgetFrames.every((snapshot) => snapshot === version));
			assert.ok(Object.isFrozen(version));

			store.recordStageStart("run-4642", { ...chain(1, "running")[0]!, id: "next", name: "next" });
			component.render(120);
			assert.equal(widgetFrames.at(-1), store.graphSnapshot(), "the next frame reads the store as it is now");
			assert.notEqual(widgetFrames.at(-1), version);
		} finally {
			dispose();
		}
	});

	test("a scrolled body draws its thumb where the scroll position puts it (#4642)", () => {
		let line = "x".repeat(59);
		const layout = new GraphViewLayout({
			renderHeader: () => ["", "", ""],
			renderBody: (_width, _top, rows) => Array.from({ length: rows }, () => line),
			renderFooter: () => ["", "", ""],
			bodyContentHeight: () => 40,
		});
		try {
			const first = layout.render(60, 18);
			assert.ok(first.scrollbar);
			assert.equal(first.scrollbar.trackHeight, 10);
			layout.scrollView.scrollTo(15);
			line = "";
			const frame = layout.render(60, 18);
			const geometry = frame.scrollbar;
			assert.ok(geometry);
			assert.deepEqual(
				{ ...geometry },
				{
					column: 59,
					trackTop: first.scrollbar.trackTop,
					trackHeight: 10,
					thumbTop: first.scrollbar.trackTop + 4,
					thumbHeight: 3,
					maxScrollTop: 30,
				},
			);
			const body = frame.frame.lines.slice(geometry.trackTop, geometry.trackTop + geometry.trackHeight);
			assert.ok(
				body.every((row) => visibleWidth(row) === 60),
				"short rows are padded to the scrollbar column",
			);
			const cells = body.map((row) => row.replace(/\x1b\[[0-9;]*m/g, "").at(-1));
			assert.deepEqual(cells, ["│", "│", "│", "│", "┃", "┃", "┃", "│", "│", "│"]);

			layout.scrollView.setScrollbarActive(true);
			const active = layout
				.render(60, 18)
				.frame.lines.slice(geometry.trackTop, geometry.trackTop + geometry.trackHeight);
			assert.equal(active.filter((row) => row.includes("█")).length, 3, "a dragged thumb is drawn solid");
		} finally {
			layout.dispose();
		}
	});

	test("a body that fits, or has no rows, draws no scrollbar (#4642)", () => {
		let content = 5;
		const layout = new GraphViewLayout({
			renderHeader: () => ["", "", ""],
			renderBody: (width, _top, rows) => Array.from({ length: rows }, () => "y".repeat(width)),
			renderFooter: () => ["", "", ""],
			bodyContentHeight: () => content,
		});
		try {
			const fitted = layout.render(60, 18);
			assert.equal(fitted.scrollbar, undefined);
			assert.ok(fitted.frame.lines.every((row) => !row.includes("│") && !row.includes("┃")));
			assert.ok(fitted.frame.lines.every((row) => visibleWidth(row) <= 60));

			content = 3;
			assert.equal(layout.render(60, 6).scrollbar, undefined, "a frame with no body rows has no scrollbar");
		} finally {
			layout.dispose();
		}
	});

	test("the graph body draws its own scrollbar, so pi-tui never splices one into each row (#4642)", () => {
		const layout = new GraphViewLayout({
			renderHeader: () => ["", "", ""],
			renderBody: (width, _top, rows) => Array.from({ length: rows }, () => "x".repeat(width)),
			renderFooter: () => ["", "", ""],
			bodyContentHeight: (_width, rows) => rows * 4,
		});
		try {
			const frame = layout.render(60, 20);
			const geometry = frame.scrollbar;
			assert.ok(geometry, "an overflowing body has a scrollbar");
			assert.equal(frame.bodyBox?.scrollView?.isScrollbarVisible, false);
			const body = frame.frame.lines.slice(geometry.trackTop, geometry.trackTop + geometry.trackHeight);
			assert.ok(body.every((line) => visibleWidth(line) === 60));
			const cells = body.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").at(-1));
			assert.equal(cells.filter((cell) => cell === "┃").length, geometry.thumbHeight);
			assert.equal(cells.filter((cell) => cell === "│").length, geometry.trackHeight - geometry.thumbHeight);
			assert.equal(cells.indexOf("┃"), geometry.thumbTop - geometry.trackTop);
		} finally {
			layout.dispose();
		}
	});
});
