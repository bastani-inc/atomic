import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	StageSnapshot,
	StoreSnapshot,
	ToolNodeSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import { GraphCanvas } from "../../packages/workflows/src/tui/graph-canvas.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { graphLayoutBodyRows } from "../../packages/workflows/src/tui/graph-view-layout.js";
import { NODE_H } from "../../packages/workflows/src/tui/layout.js";
import { defaultTheme, makeSnap, makeStage, makeStore, makeTestTui, visibleText } from "./overlay-graph-helpers.js";

class CountingCanvas extends GraphCanvas {
	mergedCells = 0;

	override mergeCell(...args: Parameters<GraphCanvas["mergeCell"]>): void {
		this.mergedCells++;
		super.mergeCell(...args);
	}
}

interface ArrayReadCounts {
	length: number;
	numeric: number;
}

interface RenderReadCounts {
	layout: ArrayReadCounts;
	bands: ArrayReadCounts;
	displayStages: ArrayReadCounts;
	edges: ArrayReadCounts;
}

function newArrayReadCounts(): ArrayReadCounts {
	return { length: 0, numeric: 0 };
}

function countArrayReads<T>(values: T[], counts: ArrayReadCounts): T[] {
	return new Proxy(values, {
		get(target, property, receiver) {
			if (property === "length") counts.length++;
			else if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) counts.numeric++;
			return Reflect.get(target, property, receiver);
		},
	});
}

function totalArrayReads(counts: ArrayReadCounts): number {
	return counts.length + counts.numeric;
}

class InstrumentedGraphView extends GraphView {
	composeCalls = 0;
	edgeCalls = 0;
	paintedCards = 0;
	private readonly layoutReads = newArrayReadCounts();
	private readonly bandReads = newArrayReadCounts();
	private readonly displayStageReads = newArrayReadCounts();
	private readonly edgeReads = newArrayReadCounts();

	protected override _composeRow(
		edgeRow: string,
		cards: Array<{ startCol: number; width: number; line: string }>,
		edgeColor: string,
	): string {
		this.composeCalls++;
		return super._composeRow(edgeRow, cards, edgeColor);
	}

	protected override _plotEdge(
		canvas: GraphCanvas,
		px: number,
		py: number,
		cx: number,
		cy: number,
		color: string,
	): void {
		this.edgeCalls++;
		super._plotEdge(canvas, px, py, cx, cy, color);
	}

	protected override _stageQueuedMessageCount(stage: StageSnapshot | undefined): number {
		this.paintedCards++;
		return super._stageQueuedMessageCount(stage);
	}

	animationEligible(): boolean {
		return this._needsAnimationTick();
	}

	layoutForTest() {
		return this.cachedLayout;
	}

	expandedTargetsForTest() {
		return this.expandedGraph.targets;
	}

	expandedGraphForTest() {
		return this.expandedGraph;
	}

	renderGeometryForTest() {
		return this.cachedRenderGeometry;
	}

	focusedIndexForTest(): number {
		return this.focusedIndex;
	}

	rebuildFromSnapshotForTest(snapshot: StoreSnapshot): void {
		this.currentSnapshot = snapshot;
		this._rebuildLayout();
	}

	bodyRowsForTest(): number {
		return graphLayoutBodyRows(this._overlayFrameHeight());
	}

	graphScrollOffsetForTest(): number {
		return this._graphScrollTop();
	}

	countRenderReadsForTest(): void {
		this.cachedLayout = countArrayReads(this.cachedLayout, this.layoutReads);
		this.cachedDisplayStages = countArrayReads(this.cachedDisplayStages, this.displayStageReads);
		this.cachedRenderGeometry = {
			...this.cachedRenderGeometry,
			bands: countArrayReads(this.cachedRenderGeometry.bands, this.bandReads),
			edges: countArrayReads(this.cachedRenderGeometry.edges, this.edgeReads),
		};
	}

	renderReadCountsForTest(): RenderReadCounts {
		return {
			layout: { ...this.layoutReads },
			bands: { ...this.bandReads },
			displayStages: { ...this.displayStageReads },
			edges: { ...this.edgeReads },
		};
	}

	countAnimationReadsForTest(): void {
		this.cachedLayout = countArrayReads(this.cachedLayout, this.layoutReads);
		this.cachedDisplayStages = countArrayReads(this.cachedDisplayStages, this.displayStageReads);
		this.cachedRenderGeometry = {
			...this.cachedRenderGeometry,
			edges: countArrayReads(this.cachedRenderGeometry.edges, this.edgeReads),
		};
	}

	animationReadCountForTest(): number {
		return (
			totalArrayReads(this.layoutReads) + totalArrayReads(this.displayStageReads) + totalArrayReads(this.edgeReads)
		);
	}
}

function chainStages(count: number): StageSnapshot[] {
	return Array.from({ length: count }, (_, index) => ({
		...makeStage(`s${index}`, index === 0 ? [] : [`s${index - 1}`]),
		status: index === count - 1 ? ("running" as const) : ("completed" as const),
		startedAt: 1,
		...(index < count - 1 ? { endedAt: 2, durationMs: 1 } : {}),
	}));
}

function parallelPairs(count: number): StageSnapshot[] {
	const roots = Array.from({ length: count }, (_, index) => makeStage(`root-${index}`));
	const children = Array.from({ length: count }, (_, index) => makeStage(`child-${index}`, [`root-${index}`]));
	return [...roots, ...children];
}

function createGraphStore(stages: StageSnapshot[]) {
	const store = createStore();
	store.recordRunStart({
		id: "run-1",
		name: "large",
		inputs: {},
		status: "running",
		stages,
		startedAt: 1,
	});
	return store;
}

function renderPairGraph(count: number): { composed: number; edges: number; cards: number; text: string } {
	const store = createGraphStore(parallelPairs(count));
	const view = new InstrumentedGraphView({
		mode: "overlay",
		runId: "run-1",
		store,
		graphTheme: defaultTheme,
		piTui: makeTestTui(24),
		initialFocusedStageId: "root-0",
	});
	try {
		const text = visibleText(view.render(96));
		return { composed: view.composeCalls, edges: view.edgeCalls, cards: view.paintedCards, text };
	} finally {
		view.dispose();
	}
}

/**
 * Per-frame read budgets, in two kinds — the distinction matters.
 *
 * `viewportScoped` entries are this change's actual claim: they stay flat as the
 * graph grows, because the band walk and card placement stop at the viewport.
 * A 400-stage chain and a 100,000-stage chain both paint the same few cards.
 *
 * `graphScoped` entries deliberately scale with the graph and are NOT viewport
 * bounds. The render examines every edge for a cheap four-comparison bounds test
 * before plotting only the visible ones, and the header counts every stage once.
 * These budgets pin the *shape* of that work — no duplicate walk, no per-card
 * clone or slice — not its magnitude. A green run here is not evidence that a
 * frame is viewport-bounded; only the `viewportScoped` entries say that.
 */
function perFrameReadBudgets(view: InstrumentedGraphView): {
	viewportScoped: { bands: number; layout: number; paintedCards: number };
	graphScoped: { displayStages: number; edges: number };
} {
	const geometry = view.renderGeometryForTest();
	assert.ok(geometry.bands.length > 1, "fixture must contain more than one layout band");
	const bandStride = geometry.bands[1]!.top - geometry.bands[0]!.top;
	const rowGap = bandStride - NODE_H;
	assert.ok(rowGap >= 0, "fixture must use non-overlapping layout bands");

	const viewportTop = view.graphScrollOffsetForTest();
	const viewportBottom = Math.min(geometry.totalRows, viewportTop + view.bodyRowsForTest());
	const visibleBands = geometry.bands.filter((band) => band.bottom > viewportTop && band.top < viewportBottom);
	const paintedCards = visibleBands.reduce((count, band) => count + band.nodeIndices.length, 0);

	let low = 0;
	let high = geometry.bands.length;
	let binarySearchReads = 0;
	while (low < high) {
		binarySearchReads++;
		const middle = Math.floor((low + high) / 2);
		if (geometry.bands[middle]!.bottom <= viewportTop) low = middle + 1;
		else high = middle;
	}
	let walkedBandReads = 0;
	for (let index = low; index < geometry.bands.length; index++) {
		walkedBandReads++;
		if (geometry.bands[index]!.top >= viewportBottom) break;
	}

	return {
		viewportScoped: {
			// Rendering and hit-target recording each perform the same binary search and band walk.
			bands: 2 * (binarySearchReads + walkedBandReads),
			// One empty-layout length check, two reads per painted card, and two focused-stage hint reads.
			layout: 2 * paintedCards + 3,
			paintedCards,
		},
		graphScoped: {
			// Display selection checks length once, then the header counts every stage once.
			// Cards share the same collection and must not clone or scan it.
			displayStages: 2 * view.layoutForTest().length + 2,
			// One full O(E) walk is intentional: each edge gets a cheap bounds test before plotting.
			edges: 2 * geometry.edges.length + 1,
		},
	};
}

describe("GraphView many-stage performance (#2100)", () => {
	it("composes and paints only the visible rows and cards in a tall graph", () => {
		const store = createGraphStore(chainStages(400));
		const view = new InstrumentedGraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(24),
			initialFocusedStageId: "s399",
		});
		try {
			const lines = view.render(96);
			const text = visibleText(lines);
			assert.equal(lines.length, 24);
			assert.match(text, /s399/);
			assert.match(text, /running/);
			assert.doesNotMatch(text, /s0\b/);
			assert.ok(
				view.composeCalls <= view.bodyRowsForTest(),
				`composed ${view.composeCalls} rows for a ${view.bodyRowsForTest()}-row body`,
			);
			const {
				viewportScoped: { paintedCards },
			} = perFrameReadBudgets(view);
			assert.equal(
				view.paintedCards,
				paintedCards,
				`painted ${view.paintedCards} cards instead of the ${paintedCards} intersecting the viewport`,
			);
		} finally {
			view.dispose();
		}
	});

	it("stops visiting layout bands below a top-anchored viewport", () => {
		const store = createGraphStore(chainStages(400));
		const view = new InstrumentedGraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(24),
			initialFocusedStageId: "s0",
		});
		try {
			const { viewportScoped } = perFrameReadBudgets(view);
			view.countRenderReadsForTest();
			const text = visibleText(view.render(96));
			const reads = view.renderReadCountsForTest();
			assert.match(text, /s0\b/);
			assert.ok(reads.bands.numeric <= viewportScoped.bands, `visited ${reads.bands.numeric} layout bands`);
			assert.equal(
				view.paintedCards,
				viewportScoped.paintedCards,
				`painted ${view.paintedCards} cards below the viewport`,
			);
		} finally {
			view.dispose();
		}
	});
	it("clips off-screen fan-out edges and keeps expensive work viewport bounded", () => {
		const small = renderPairGraph(100);
		const large = renderPairGraph(1_000);
		for (const result of [small, large]) {
			assert.equal(result.composed, 13);
			assert.ok(result.cards <= 8, `painted ${result.cards} cards`);
			assert.ok(result.edges <= 4, `plotted ${result.edges} off-screen edges`);
			assert.doesNotMatch(result.text, /root-50|child-50/);
		}
		assert.ok(large.cards <= small.cards + 2);
		assert.ok(large.edges <= small.edges + 2);
	});

	it("counts tool cards at the paint seam", () => {
		const stages = [makeStage("root")];
		const tools: ToolNodeSnapshot[] = [
			{
				kind: "tool",
				id: "tool:lookup",
				name: "lookup-tool-card",
				argsHash: "lookup",
				ordinal: 0,
				parentIds: ["root"],
				status: "completed",
				resultSummary: "found",
				attachable: false,
			},
		];
		const base = makeSnap(stages);
		const snap = { ...base, runs: [{ ...base.runs[0]!, toolNodes: tools }] };
		const view = new InstrumentedGraphView({
			mode: "overlay",
			runId: "run-1",
			store: makeStore(snap),
			graphTheme: defaultTheme,
			piTui: makeTestTui(24),
		});
		try {
			const text = visibleText(view.render(96));
			assert.match(text, /lookup-tool-card/);
			assert.equal(view.paintedCards, stages.length + tools.length);
		} finally {
			view.dispose();
		}
	});

	it("bounds long edge segments to the viewport width and height", () => {
		const horizontal = new CountingCanvas({ top: 10, bottom: 20, left: 1_000, right: 1_080 });
		horizontal.hline(15, 0, 100_000, "#ffffff");
		assert.equal(horizontal.mergedCells, 80);
		assert.equal(horizontal.toLines().length, 10);

		const vertical = new CountingCanvas({ top: 500, bottom: 516, left: 20, right: 40 });
		vertical.vline(30, 0, 100_000, "#ffffff");
		assert.equal(vertical.mergedCells, 16);
		assert.equal(vertical.toLines().length, 16);
	});

	it("materializes horizontally scrolled canvas cells from the left bound", () => {
		const bounds = { top: 0, bottom: 1, left: 100, right: 110 };
		const canvas = new GraphCanvas(bounds);
		canvas.setCell(bounds.top, bounds.left, "L", null);
		canvas.setCell(bounds.top, bounds.right - 1, "R", null);
		assert.deepEqual(canvas.toLines(), [`L${" ".repeat(bounds.right - bounds.left - 2)}R`]);
	});

	it("drops cells on the half-open bottom and right bounds", () => {
		const bounds = { top: 0, bottom: 1, left: 100, right: 110 };
		const canvas = new GraphCanvas(bounds);
		canvas.setCell(bounds.bottom, bounds.left, "B", null);
		canvas.setCell(bounds.top, bounds.right, "R", null);
		assert.equal(canvas.getCell(bounds.bottom, bounds.left), null);
		assert.equal(canvas.getCell(bounds.top, bounds.right), null);
		assert.deepEqual(canvas.toLines(), [""]);
	});

	it("retains layout and expanded target identity across status-only store updates", () => {
		const store = createGraphStore([{ ...makeStage("A"), status: "running", startedAt: 1 }]);
		const view = new InstrumentedGraphView({ mode: "overlay", runId: "run-1", store, graphTheme: defaultTheme });
		try {
			view.render(80);
			const beforeLayout = view.layoutForTest();
			const beforeNode = beforeLayout[0];
			const beforeGraph = view.expandedGraphForTest();
			const beforeGeometry = view.renderGeometryForTest();
			const beforeTargets = view.expandedTargetsForTest();
			const beforeFocusedIndex = view.focusedIndexForTest();

			store.recordStageEnd("run-1", {
				...makeStage("A"),
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				durationMs: 1,
			});
			view.invalidate();

			assert.strictEqual(view.layoutForTest(), beforeLayout);
			assert.strictEqual(view.layoutForTest()[0], beforeNode);
			assert.notStrictEqual(view.expandedGraphForTest(), beforeGraph);
			assert.strictEqual(view.renderGeometryForTest(), beforeGeometry);
			assert.strictEqual(view.expandedTargetsForTest(), beforeTargets);
			assert.equal(view.layoutForTest()[0]?.stage.status, "completed");
			assert.equal(view.focusedIndexForTest(), beforeFocusedIndex);
			assert.match(visibleText(view.render(80)), /✓ complete/);
		} finally {
			view.dispose();
		}
	});

	it("rebuilds card and edge geometry when a stage is reparented", () => {
		const initialStages = [makeStage("A"), makeStage("B", ["A"]), makeStage("C", ["A"])];
		const initial = makeSnap(initialStages);
		const view = new InstrumentedGraphView({
			mode: "overlay",
			runId: "run-1",
			store: makeStore(initial),
			graphTheme: defaultTheme,
		});
		try {
			const beforeGeometry = view.renderGeometryForTest();
			const nextStages = [makeStage("A"), makeStage("B", ["A"]), makeStage("C", ["B"])];
			const next = makeSnap(nextStages);
			view.rebuildFromSnapshotForTest({ ...next, version: initial.version + 1 });

			const layoutById = new Map(view.layoutForTest().map((node) => [node.stage.id, node]));
			const parent = layoutById.get("B");
			const child = layoutById.get("C");
			assert.ok(parent && child);
			const geometry = view.renderGeometryForTest();
			assert.notStrictEqual(geometry, beforeGeometry);
			assert.ok(
				geometry.edges.some(
					(edge) =>
						edge.parentX === parent.x &&
						edge.parentY === parent.y &&
						edge.childX === child.x &&
						edge.childY === child.y,
				),
				"reparented edge did not follow the new parent and child card coordinates",
			);
		} finally {
			view.dispose();
		}
	});
	it("retains expanded topology for plain failed and skipped real-store updates", () => {
		for (const status of ["failed", "skipped"] as const) {
			const store = createGraphStore([{ ...makeStage("A"), status: "running", startedAt: 1 }]);
			const view = new InstrumentedGraphView({ mode: "overlay", runId: "run-1", store, graphTheme: defaultTheme });
			try {
				view.render(80);
				const beforeLayout = view.layoutForTest();
				const beforeNode = beforeLayout[0];
				const beforeGraph = view.expandedGraphForTest();
				const beforeGeometry = view.renderGeometryForTest();
				const beforeTargets = view.expandedTargetsForTest();
				const beforeFocusedIndex = view.focusedIndexForTest();

				store.recordStageEnd("run-1", {
					...makeStage("A"),
					status,
					startedAt: 1,
					endedAt: 2,
					durationMs: 1,
				});
				view.invalidate();

				assert.strictEqual(view.layoutForTest(), beforeLayout, `${status} replaced layout`);
				assert.strictEqual(view.layoutForTest()[0], beforeNode, `${status} replaced layout node`);
				assert.notStrictEqual(view.expandedGraphForTest(), beforeGraph, `${status} reused expanded graph`);
				assert.strictEqual(view.renderGeometryForTest(), beforeGeometry, `${status} replaced render geometry`);
				assert.strictEqual(view.expandedTargetsForTest(), beforeTargets, `${status} replaced targets`);
				assert.equal(view.layoutForTest()[0]?.stage.status, status);
				assert.equal(view.focusedIndexForTest(), beforeFocusedIndex);
				const text = visibleText(view.render(80));
				assert.match(text, status === "failed" ? /✗ failed/ : /⊘ skipped/);
			} finally {
				view.dispose();
			}
		}
	});

	it("renders and records hit targets within a viewport-derived read budget", () => {
		const store = createGraphStore(chainStages(1_000));
		const view = new InstrumentedGraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			piTui: makeTestTui(24),
			initialFocusedStageId: "s999",
		});
		try {
			view.render(96);
			const { viewportScoped, graphScoped } = perFrameReadBudgets(view);
			view.countRenderReadsForTest();
			view.render(96);
			const reads = view.renderReadCountsForTest();
			// Viewport-scoped: flat as the graph grows.
			assert.ok(
				totalArrayReads(reads.layout) <= viewportScoped.layout,
				`read layout ${totalArrayReads(reads.layout)} times`,
			);
			assert.ok(reads.bands.numeric <= viewportScoped.bands, `visited ${reads.bands.numeric} layout bands`);
			// Graph-scoped: one pass each, so a duplicate walk or a per-card clone fails.
			assert.ok(
				totalArrayReads(reads.displayStages) <= graphScoped.displayStages,
				`read display stages ${totalArrayReads(reads.displayStages)} times`,
			);
			assert.ok(
				totalArrayReads(reads.edges) <= graphScoped.edges,
				`read edges ${totalArrayReads(reads.edges)} times`,
			);
		} finally {
			view.dispose();
		}
	});

	it("answers idle animation eligibility from precomputed scalars", () => {
		const store = createGraphStore(Array.from({ length: 1_000 }, (_, index) => makeStage(`idle-${index}`)));
		const view = new InstrumentedGraphView({ mode: "overlay", runId: "run-1", store, graphTheme: defaultTheme });
		try {
			view.countAnimationReadsForTest();
			assert.equal(view.animationEligible(), false);
			assert.equal(view.animationReadCountForTest(), 0, "animation eligibility read per-node cached state");
		} finally {
			view.dispose();
		}
	});
});

/**
 * The read budgets above bound how much work a frame does; they say nothing about
 * what it paints. Both regressions below leave every budget satisfied and the whole
 * overlay-graph suite green, so the painted output needs its own assertions.
 */
describe("overlay graph paints what the budgets do not constrain", () => {
	/** One completed root and one running child, so the header counts are 1 and 1. */
	function twoStageStore() {
		return createGraphStore([
			{ ...makeStage("a"), status: "completed" as const, startedAt: 1, endedAt: 2, durationMs: 1 },
			{ ...makeStage("b", ["a"]), status: "running" as const, startedAt: 1 },
		]);
	}

	it("paints the edge run connecting a parent card to its child", () => {
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store: twoStageStore(),
			graphTheme: defaultTheme,
			piTui: makeTestTui(24),
		});
		try {
			const lines = visibleText(view.render(60)).split("\n");
			// Anchor on the card boxes themselves. A card's own side borders are also
			// "│", so only the rows strictly between the parent's closing border and
			// the child's opening border are edge; with plotting removed they are blank.
			const parentBody = lines.findIndex((line) => line.includes("✓ complete"));
			assert.ok(parentBody !== -1, "fixture must paint the completed parent card");
			const parentCardEnd = lines.findIndex((line, index) => index > parentBody && line.includes("╰"));
			const childCardStart = lines.findIndex((line, index) => index > parentCardEnd && line.includes("╭"));
			assert.ok(
				parentCardEnd !== -1 && childCardStart > parentCardEnd + 1,
				"fixture must leave a gap between cards",
			);

			const between = lines.slice(parentCardEnd + 1, childCardStart);
			const edgeRows = between.filter((line) => line.includes("│"));
			assert.equal(
				edgeRows.length,
				between.length,
				`every row between the cards must carry the edge, got:\n${between.join("\n")}`,
			);
		} finally {
			view.dispose();
		}
	});

	it("paints stage counts in the header", () => {
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store: twoStageStore(),
			graphTheme: defaultTheme,
			piTui: makeTestTui(24),
		});
		try {
			const header = visibleText(view.render(60))
				.split("\n")
				.find((line) => line.includes("ORCHESTRATOR"));
			assert.ok(header !== undefined, "overlay must paint a header row");
			// One completed stage and one running stage, straight off the fixture.
			assert.match(header, /✓ 1/);
			assert.match(header, /● 1/);
		} finally {
			view.dispose();
		}
	});
});
