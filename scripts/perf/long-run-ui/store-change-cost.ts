#!/usr/bin/env bun
/**
 * Store-change cost of the long-run UI benchmark (#4642): the CPU time one workflow store change costs the engine's
 * workflow surfaces, with a run that finished few stages and with one that finished many.
 *
 * It mounts what `engine.ts` mounts on a store, without sessions, journal or model: the progress widget, the graph
 * overlay (open, as the benchmark keeps it), and the workflow activity bridge publishing into a `WorkflowActivityHub`
 * whose frames `forwardWorkflowActivity` serializes for the host. The store holds `runs` runs of `lanes` sequential
 * lanes each, with the finished stages spread over them and one running stage per lane. Every store change ends or
 * restarts one of those running stages, as a lane does, through the store methods the executor calls.
 *
 * A store change costs: the store method, which runs every invalidation listener (the widget refresh, the overlay's
 * graph snapshot, the bridge's scheduling); the activity publication the bridge coalesces to the end of the turn
 * (projection, comparison, hub publication); and the hub's delivery to the forwarding observer. The sizes alternate
 * window by window after warm-up changes, so the i-th windows of two sizes ran back to back and their ratio does not
 * follow the host's load; each window's mean per change is reported, with the median over windows.
 * Sessions, the journal and the host are not part of it, so it shows how the per-change work grows with finished
 * stages apart from the stage-start cost that dominates a churn window's key latency.
 *
 *   bun scripts/perf/long-run-ui/store-change-cost.ts '{"runs":2,"lanes":3,"finished":[10,600]}'
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../packages/coding-agent/src/core/agent-session.js";
import { WorkflowActivityHub } from "../../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.js";
import { initTheme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import { forwardWorkflowActivity } from "../../../packages/coding-agent/src/modes/interactive-engine/engine-workflow-activity.js";
import {
	createWorkflowObservation,
	flushWorkflowActivityPublications,
} from "../../../packages/workflows/src/extension/workflow-observation.js";
import { createStageControlRegistry } from "../../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../../packages/workflows/src/shared/store.js";
import type { Store } from "../../../packages/workflows/src/shared/store-public-types.js";
import type { StageSnapshot } from "../../../packages/workflows/src/shared/store-types.js";
import { buildGraphOverlayAdapter } from "../../../packages/workflows/src/tui/overlay-adapter.js";
import { installStoreWidget } from "../../../packages/workflows/src/tui/store-widget-installer.js";

export interface StoreChangeCostOptions {
	readonly runs: number;
	readonly lanes: number;
	/** Finished-stage counts to measure, each in a store of its own. */
	readonly finished: readonly number[];
	/** Measured windows per count; the reported cost is their median. */
	readonly windows?: number;
	/** Store changes per window. */
	readonly changes?: number;
	/** Store changes made before the first window of each count, discarded. */
	readonly warmup?: number;
	/** Characters of each finished stage's result. */
	readonly resultBytes?: number;
}

export interface StoreChangeCost {
	readonly finished: number;
	/** Median over windows of the mean CPU time per store change, in microseconds. */
	readonly usPerChange: number;
	/** The part spent building graph snapshots, median over windows, in microseconds per change. */
	readonly graphSnapshotUs: number;
	/** The part spent publishing root activity and delivering it, median over windows, in microseconds per change. */
	readonly activityUs: number;
	/** The mean per change of every window, in microseconds. */
	readonly windows: readonly number[];
}

/** Ends or restarts the running stages of a store, one per call, as the lanes of its runs do. */
interface Fixture {
	readonly store: Store;
	change(): void;
	dispose(): void;
}

const ENGINE_DIR = mkdtempSync(join(tmpdir(), "atomic-long-run-ui-store-change-"));
initTheme("dark");
const keybindings = KeybindingsManager.create(ENGINE_DIR);
setKeybindings(keybindings);

function stageOf(lane: number, step: number, status: StageSnapshot["status"], result: string): StageSnapshot {
	return {
		id: `lane-${lane}-step-${step}`,
		name: `lane-${lane}-step-${step}`,
		status,
		parentIds: step === 0 ? [] : [`lane-${lane}-step-${step - 1}`],
		toolEvents: [],
		startedAt: step,
		...(status === "completed" ? { endedAt: step + 1, result } : {}),
	};
}

function mount(options: Required<StoreChangeCostOptions>, finished: number): Fixture {
	const store = createStore();
	const result = "r".repeat(options.resultBytes);
	const live: { readonly runId: string; readonly stage: StageSnapshot }[] = [];
	for (let run = 0; run < options.runs; run++) {
		const runId = `run-${run}`;
		const share = Math.floor(finished / options.runs) + (run < finished % options.runs ? 1 : 0);
		const stages: StageSnapshot[] = [];
		for (let index = 0; index < share + options.lanes; index++) {
			const lane = index % options.lanes;
			const stage = stageOf(
				lane,
				Math.floor(index / options.lanes),
				index < share ? "completed" : "running",
				result,
			);
			stage.executionOrder = index + 1;
			stages.push(stage);
			if (index >= share) live.push({ runId, stage });
		}
		store.recordRunStart({
			id: runId,
			name: `long run ${run}`,
			inputs: {},
			status: "running",
			stages,
			toolNodes: [],
			startedAt: 0,
		});
	}
	const customUi = new EngineCustomUiService(() => {}, keybindings);
	const removeWidget = installStoreWidget(
		{
			ui: {
				setWidget: (key, factory, widgetOptions) =>
					customUi.setWidget(
						key,
						factory === undefined
							? undefined
							: (tui, theme) => {
									const component = factory(tui, theme);
									return Object.assign(component, { invalidate: component.invalidate ?? (() => {}) });
								},
						widgetOptions?.placement,
						widgetOptions?.scroll,
					),
				requestRender: () => customUi.requestRender(),
				onWidgetRelease: (key, listener) => customUi.onWidgetRelease(key, listener),
			},
		},
		store,
	);
	const hub = new WorkflowActivityHub();
	hub.bindDispatcher(async () => {});
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "store-change-owner");
	const stopForwarding = forwardWorkflowActivity(
		{ workflows: { observe: (observer) => hub.observeWorkflowActivity(observer) } } as AgentSession,
		() => {},
	);
	const overlayUi = {
		custom: customUi.custom.bind(customUi),
		getHostCustomUiState: () => customUi.getHostCustomUiState(),
		onHostCustomUiStateChange: (listener: Parameters<typeof customUi.onHostCustomUiStateChange>[0]) =>
			customUi.onHostCustomUiStateChange(listener),
		focusHostInlineCustomUi: () => customUi.focusHostInlineCustomUi(),
	};
	const overlay = buildGraphOverlayAdapter({ ui: overlayUi as never }, store, {
		stageControlRegistry: createStageControlRegistry(),
		terminalOutput: { platform: process.platform, isTTY: false, write: () => {} },
	});
	overlay.open("run-0", { ui: overlayUi as never });
	let cursor = 0;
	return {
		store,
		change() {
			const target = live[cursor++ % live.length]!;
			if (target.stage.status === "running") {
				store.recordStageEnd(target.runId, { ...target.stage, status: "completed", endedAt: cursor, result });
			} else {
				target.stage.status = "running";
				target.stage.endedAt = undefined;
				store.recordStageStart(target.runId, target.stage);
			}
		},
		dispose() {
			stopForwarding();
			observation.dispose();
			removeWidget();
			customUi.dispose();
		},
	};
}

/** Lets the hub deliver what a publication queued; its delivery runs in microtasks. */
async function drainMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Long enough between changes that the widget's refresh budget never defers a refresh to a timer. */
const PAUSE_BETWEEN_CHANGES_MS = 4;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, PAUSE_BETWEEN_CHANGES_MS));

export async function measureStoreChangeCost(input: StoreChangeCostOptions): Promise<StoreChangeCost[]> {
	const options: Required<StoreChangeCostOptions> = {
		windows: 11,
		changes: 300,
		warmup: 400,
		resultBytes: 1_100,
		...input,
	};
	const fixtures = options.finished.map((finished) => ({ finished, fixture: mount(options, finished) }));
	const totals = fixtures.map(() => ({ windows: [] as number[], graph: [] as number[], activity: [] as number[] }));
	let graphMs = 0;
	for (const { fixture } of fixtures) {
		const graphSnapshot = fixture.store.graphSnapshot.bind(fixture.store);
		fixture.store.graphSnapshot = () => {
			const began = performance.now();
			try {
				return graphSnapshot();
			} finally {
				graphMs += performance.now() - began;
			}
		};
	}
	const run = async (
		fixture: Fixture,
		changes: number,
	): Promise<{ total: number; graph: number; activity: number }> => {
		let total = 0;
		let activity = 0;
		graphMs = 0;
		for (let change = 0; change < changes; change++) {
			const began = performance.now();
			fixture.change();
			const changed = performance.now();
			flushWorkflowActivityPublications();
			await drainMicrotasks();
			const ended = performance.now();
			total += ended - began;
			activity += ended - changed;
			// The widget refreshes on every change while its refresh budget lasts; a pause per change keeps it there.
			await settle();
		}
		return { total, graph: graphMs, activity };
	};
	for (const { fixture } of fixtures) await run(fixture, options.warmup);
	for (let window = 0; window < options.windows; window++) {
		for (const [index, { fixture }] of fixtures.entries()) {
			collect();
			const measured = await run(fixture, options.changes);
			const perChange = (ms: number) => (ms / options.changes) * 1000;
			totals[index]!.windows.push(perChange(measured.total));
			totals[index]!.graph.push(perChange(measured.graph));
			totals[index]!.activity.push(perChange(measured.activity));
		}
	}
	for (const { fixture } of fixtures) fixture.dispose();
	const round = (value: number) => Number(value.toFixed(2));
	return fixtures.map(({ finished }, index) => ({
		finished,
		usPerChange: round(median(totals[index]!.windows)),
		graphSnapshotUs: round(median(totals[index]!.graph)),
		activityUs: round(median(totals[index]!.activity)),
		windows: totals[index]!.windows.map(round),
	}));
}

function collect(): void {
	const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
	bun?.gc(true);
	(globalThis as { gc?: () => void }).gc?.();
}

if (import.meta.main) {
	const options = JSON.parse(process.argv[2] ?? "{}") as StoreChangeCostOptions;
	try {
		process.stdout.write(`${JSON.stringify(await measureStoreChangeCost(options))}\n`);
	} finally {
		rmSync(ENGINE_DIR, { recursive: true, force: true });
	}
}
