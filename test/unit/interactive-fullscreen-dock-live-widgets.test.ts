import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type ProductionFullscreenContext,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { installStoreWidget, scrollStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.js";

const BASE_NOW = 1_700_000_000_000;

type WidgetFactory = (
	tui: unknown,
	theme: unknown,
) => {
	render(width: number): string[];
	invalidate?: () => void;
	dispose?: () => void;
};

type HostUi = {
	setWidget: (key: string, factory: WidgetFactory | undefined, options?: { placement?: string }) => void;
	requestRender: () => void;
};

type ScheduledTimer = {
	handle: { unref(): void };
	handler: () => void;
	delayMs: number;
	cleared: boolean;
};

function makeTimers(): {
	setTimeout: (handler: () => void, delayMs: number) => ScheduledTimer["handle"];
	clearTimeout: (handle: ScheduledTimer["handle"]) => void;
	scheduled: ScheduledTimer[];
} {
	const scheduled: ScheduledTimer[] = [];
	return {
		scheduled,
		setTimeout(handler, delayMs) {
			const entry: ScheduledTimer = {
				handle: { unref() {} },
				handler,
				delayMs,
				cleared: false,
			};
			scheduled.push(entry);
			return entry.handle;
		},
		clearTimeout(handle) {
			const entry = scheduled.find((candidate) => candidate.handle === handle);
			if (entry) entry.cleared = true;
		},
	};
}

function makeRun(id: string, name: string, startedAt: number): RunSnapshot {
	return {
		id,
		name,
		inputs: {},
		status: "running",
		stages: [],
		startedAt,
	};
}

function makeHostUi(context: ProductionFullscreenContext["context"]): HostUi {
	return context.createExtensionUIContext() as unknown as HostUi;
}

let activeContext: ProductionFullscreenContext | undefined;
afterEach(async () => {
	if (!activeContext) return;
	activeContext.resolveTheme();
	await activeContext.initPromise;
	activeContext.tui.stop();
	activeContext.restoreOffline();
	activeContext = undefined;
});

test("keeps the workflow live widget rendered in the production sticky dock", async () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(BASE_NOW);
	const timers = makeTimers();
	activeContext = createProductionFullscreenContext();
	const { context, terminal, tui } = activeContext;
	const hostUi = makeHostUi(context);
	const workflowStore = createStore();
	const disposeWorkflowWidget = installStoreWidget({ ui: hostUi }, workflowStore, timers);

	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		tui.renderNow();

		workflowStore.recordRunStart(makeRun("workflow-live", "workflow-live", BASE_NOW));
		await Promise.resolve();
		tui.renderNow();
		const workflowComponent = context.extensionWidgetsBelow.get("workflow.run");
		if (!workflowComponent) throw new Error("workflow widget did not mount in the dock");
		const initial = getLayoutFrame(tui);
		const initialTranscript = initial.root.children[0];
		const initialDock = initial.root.children[1];
		if (!initialTranscript || !initialDock) throw new Error("fullscreen dock did not render");
		const layoutRoot = context.fullscreenLayoutRoot as { children?: Component[] } | undefined;
		expect(initialDock.component).toBe(layoutRoot?.children?.[1]);
		expect(initialDock.rect.y + initialDock.rect.height).toBe(terminal.rows);
		const initialDockLines = initial.lines.slice(initialDock.rect.y, initialDock.rect.y + initialDock.rect.height);
		expect(initialDockLines.some((line) => line.includes("workflow-live"))).toBe(true);
		expect(context.widgetContainerBelow.children).toContain(workflowComponent);
		const footerIndex = initialDockLines.findIndex((line) => line.includes("footer"));
		const workflowIndex = initialDockLines.findIndex((line) => line.includes("workflow-live"));
		expect(footerIndex).toBeGreaterThanOrEqual(0);
		expect(workflowIndex).toBeGreaterThan(footerIndex);
		const initialWorkflowComponent = workflowComponent;

		for (const elapsedMs of [1_000, 2_000]) {
			const timer = timers.scheduled.findLast((entry) => !entry.cleared);
			if (!timer) throw new Error("workflow widget did not schedule a live clock tick");
			now.mockReturnValue(BASE_NOW + elapsedMs);
			timer.handler();
			await Promise.resolve();
			tui.renderNow();
			const ticked = getLayoutFrame(tui);
			expect(ticked.root.children[0]?.rect).toEqual(initialTranscript.rect);
			expect(ticked.root.children[1]?.rect).toEqual(initialDock.rect);
			expect(ticked.root.children[1]!.rect.y + ticked.root.children[1]!.rect.height).toBe(terminal.rows);
			expect(context.extensionWidgetsBelow.get("workflow.run")).toBe(initialWorkflowComponent);
			const tickedDockLines = ticked.lines.slice(
				ticked.root.children[1]!.rect.y,
				ticked.root.children[1]!.rect.y + ticked.root.children[1]!.rect.height,
			);
			expect(tickedDockLines.some((line) => line.includes(`${elapsedMs / 1_000}s`))).toBe(true);
		}
	} finally {
		disposeWorkflowWidget();
		now.mockRestore();
	}
});

// #3015: exercise the real fullscreen dock's measurement, not just renderer rows.
test("many workflow runs leave the editor usable through narrow and short resizes", async () => {
	activeContext = createProductionFullscreenContext();
	const { context, terminal, tui } = activeContext;
	const store = createStore();
	const dispose = installStoreWidget({ ui: makeHostUi(context) }, store, makeTimers());
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		for (let i = 0; i < 15; i++) store.recordRunStart(makeRun(`dock-${i}`, `dummy-${i}`, BASE_NOW + i));
		await Promise.resolve();
		tui.renderNow();
		const mounted = context.extensionWidgetsBelow.get("workflow.run");
		context.editor.setText("editor input retained");
		for (const [width, rows] of [
			[120, 40],
			[27, 12],
			[80, 12],
			[79, 16],
			[81, 24],
			[27, 8],
			[120, 40],
		]) {
			terminal.resize(width!, rows!);
			tui.renderNow();
			const frame = getLayoutFrame(tui);
			expect(frame.lines.length).toBeLessThanOrEqual(rows!);
			expect(frame.lines.every((line) => visibleWidth(line) <= width!)).toBe(true);
			expect(frame.lines.some((line) => line.includes("editor input retained"))).toBe(true);
			expect(context.extensionWidgetsBelow.get("workflow.run")).toBe(mounted);
			scrollStoreWidget(store, 1);
			tui.renderNow();
			expect(getLayoutFrame(tui).lines.some((line) => line.includes("editor input retained"))).toBe(true);
		}
	} finally {
		dispose();
	}
});
