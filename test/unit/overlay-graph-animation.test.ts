import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { ANIMATION_TICK_MS } from "../../packages/workflows/src/tui/graph-view-constants.js";
import * as h from "./overlay-graph-helpers.js";

const {
	makeAwaitingInputStage,
	makePendingPrompt,
	makeRunPromptSnap,
	makeStage,
	makeSnap,
	makeStore,
	defaultTheme,
	waitForRenderCount,
} = h;

class AnimationGateGraphView extends GraphView {
	layoutForTest() {
		return this.cachedLayout;
	}
}

describe("GraphView animation timer", () => {
	it("fires requestRender on a steady cadence while stages are animating", async () => {
		const stages = [{ ...makeStage("A"), status: "running" as const, startedAt: Date.now() }];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const requestRender = vi.fn(() => {});
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			requestRender,
		});
		// Tick is 100ms, but Windows CI can starve the event loop long enough
		// that one wall-clock sleep observes only one interval turn. Poll across
		// scheduler turns instead of assuming 250ms means two ticks.
		try {
			await waitForRenderCount(() => requestRender.mock.calls.length, 2);
			assert.ok(requestRender.mock.calls.length >= 2, `expected ≥ 2 ticks, got ${requestRender.mock.calls.length}`);
		} finally {
			view.dispose();
		}
	});

	it("skips animation ticks when no stage needs wall-clock paint", async () => {
		const stages = [makeStage("A")];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const requestRender = vi.fn(() => {});
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			requestRender,
		});
		try {
			await new Promise((r) => setTimeout(r, 250));
			assert.equal(requestRender.mock.calls.length, 0, "pending-only graphs must not burn animation frames");
		} finally {
			view.dispose();
		}
	});

	it("stops timer-driven render requests after a real-store running stage completes", () => {
		vi.useFakeTimers();
		const store = createStore();
		store.recordRunStart({
			id: "run-1",
			name: "animation transition",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart("run-1", { ...makeStage("A"), status: "running", startedAt: 1 });
		const requestRender = vi.fn(() => {});
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			requestRender,
		});
		try {
			vi.advanceTimersByTime(300);
			assert.equal(requestRender.mock.calls.length, 3);
			store.recordStageEnd("run-1", {
				...makeStage("A"),
				status: "completed",
				startedAt: 1,
				endedAt: 2,
				durationMs: 1,
			});
			requestRender.mockClear();
			vi.advanceTimersByTime(500);
			assert.equal(requestRender.mock.calls.length, 0);
		} finally {
			view.dispose();
			vi.useRealTimers();
		}
	});

	it("ticks for a prompt and a rebuilt awaiting-input stage independently", () => {
		vi.useFakeTimers();
		const views: AnimationGateGraphView[] = [];
		try {
			const cases = [
				{
					name: "prompt",
					store: makeStore(makeRunPromptSnap([makeStage("A")], makePendingPrompt())),
					setup: (_view: AnimationGateGraphView) => {},
				},
				{
					name: "awaiting_input",
					store: makeStore(makeSnap([makeAwaitingInputStage("A")])),
					setup: (_view: AnimationGateGraphView) => {},
				},
			];

			for (const item of cases) {
				const requestRender = vi.fn(() => {});
				const view = new AnimationGateGraphView({
					mode: "overlay",
					runId: "run-1",
					store: item.store,
					graphTheme: defaultTheme,
					requestRender,
				});
				views.push(view);
				item.setup(view);
				requestRender.mockClear();
				vi.advanceTimersByTime(ANIMATION_TICK_MS);
				assert.equal(requestRender.mock.calls.length, 1, `${item.name} did not keep the animation tick running`);
				view.dispose();
			}
		} finally {
			for (const view of views) view.dispose();
			vi.useRealTimers();
		}
	});

	it("keeps ticking when a retained running stage becomes awaiting input", () => {
		vi.useFakeTimers();
		const store = createStore();
		store.recordRunStart({
			id: "run-1",
			name: "retained awaiting input",
			inputs: {},
			status: "running",
			stages: [{ ...makeStage("A"), status: "running", startedAt: 1 }],
			startedAt: 1,
		});
		const requestRender = vi.fn(() => {});
		const view = new AnimationGateGraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			requestRender,
		});
		try {
			const retainedLayout = view.layoutForTest();
			assert.equal(store.recordStageAwaitingInput("run-1", "A", true, 2), true);
			assert.strictEqual(view.layoutForTest(), retainedLayout);
			requestRender.mockClear();
			vi.advanceTimersByTime(ANIMATION_TICK_MS);
			assert.equal(requestRender.mock.calls.length, 1);
		} finally {
			view.dispose();
			vi.useRealTimers();
		}
	});

	it("does not start the timer in widget mode", async () => {
		const stages = [{ ...makeStage("A"), status: "running" as const, startedAt: Date.now() }];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const requestRender = vi.fn(() => {});
		const view = new GraphView({
			mode: "widget",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			requestRender,
		});
		await new Promise((r) => setTimeout(r, 250));
		view.dispose();
		assert.equal(requestRender.mock.calls.length, 0);
	});

	it("does not crash when requestRender is omitted in overlay mode", async () => {
		const stages = [makeStage("A")];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
		});
		// No requestRender wired — the constructor must skip setInterval
		// entirely so callers that drive the view manually (legacy unit
		// tests, snapshot tooling) don't leak a dangling interval.
		await new Promise((r) => setTimeout(r, 150));
		view.dispose();
	});

	it("stops firing renders after dispose", async () => {
		const stages = [{ ...makeStage("A"), status: "running" as const, startedAt: Date.now() }];
		const snap = makeSnap(stages);
		const store = makeStore(snap);
		const requestRender = vi.fn(() => {});
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: defaultTheme,
			requestRender,
		});
		await new Promise((r) => setTimeout(r, 150));
		const beforeDispose = requestRender.mock.calls.length;
		view.dispose();
		await new Promise((r) => setTimeout(r, 250));
		assert.equal(requestRender.mock.calls.length, beforeDispose, "render must not be requested after dispose");
	});

	it("running-stage border pulse advances with wall-clock time", () => {
		// The pulse phase is computed from `Date.now()` at render time, so
		// two renders at different timestamps must produce visibly
		// different ANSI for an unfocused running stage. The focused node
		// locks at the peak colour by design (see `pickBorder`), so we
		// need at least two nodes — focus stays on the first and the
		// second carries the animation we observe.
		const originalNow = Date.now;
		let view: GraphView | undefined;
		try {
			Date.now = () => 4_000;
			const startedAt = 0;
			const stages: StageSnapshot[] = [
				{ ...makeStage("A"), status: "running" as const, startedAt },
				{ ...makeStage("B", ["A"]), status: "running" as const, startedAt },
			];
			const snap = makeSnap(stages);
			const store = makeStore(snap);
			view = new GraphView({
				mode: "overlay",
				runId: "run-1",
				store,
				graphTheme: defaultTheme,
			});
			const frameA = view.render(96).join("\n");
			// Advance to a deterministic point in the 2s pulse cycle (~25%
			// of period) without crossing a duration-formatting boundary,
			// so the frame delta specifically covers the border pulse.
			Date.now = () => 4_500;
			const frameB = view.render(96).join("\n");
			assert.notEqual(frameA, frameB, "pulse phase must change between renders");
		} finally {
			view?.dispose();
			Date.now = originalNow;
		}
	});
});
