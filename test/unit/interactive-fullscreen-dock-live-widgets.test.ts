import type { Component } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.ts";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type ProductionFullscreenContext,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import type { AsyncJobState } from "../../packages/subagents/src/shared/types.js";
import { renderWidget, stopWidgetAnimation } from "../../packages/subagents/src/tui/render-widget.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { installStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.js";

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

function makeJob(tool: string, updatedAt: number): AsyncJobState {
	return {
		asyncId: "subagent-live",
		asyncDir: "/tmp/subagent-live",
		status: "running",
		mode: "single",
		agents: ["subagent-live"],
		currentTool: tool,
		currentToolStartedAt: BASE_NOW,
		startedAt: BASE_NOW,
		updatedAt,
		turnCount: 1,
		toolCount: 1,
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

test("keeps workflow and subagent live widgets rendered in the production sticky dock", async () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(BASE_NOW);
	const timers = makeTimers();
	activeContext = createProductionFullscreenContext();
	const { context, terminal, tui } = activeContext;
	const hostUi = makeHostUi(context);
	const workflowStore = createStore();
	const disposeWorkflowWidget = installStoreWidget({ ui: hostUi }, workflowStore, timers);
	const subagentOwner = {};
	const subagentContext = {
		hasUI: true,
		cwd: "/tmp/subagent-live",
		ui: hostUi,
		sessionManager: { getSessionId: () => "fullscreen-live-widgets" },
	} as unknown as ExtensionContext;

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

		renderWidget(subagentContext, [makeJob("read", BASE_NOW)], subagentOwner);
		tui.renderNow();
		const subagentComponent = context.extensionWidgetsBelow.get("subagent-async");
		if (!subagentComponent) throw new Error("subagent widget did not mount in the dock");
		const withBothWidgets = getLayoutFrame(tui);
		const bothDock = withBothWidgets.root.children[1]!;
		const bothDockLines = withBothWidgets.lines.slice(bothDock.rect.y, bothDock.rect.y + bothDock.rect.height);
		expect(bothDockLines.some((line) => line.includes("subagent-live"))).toBe(true);
		expect(context.widgetContainerBelow.children).toContain(subagentComponent);
		expect(context.widgetContainerBelow.children.indexOf(subagentComponent)).toBeGreaterThan(
			context.widgetContainerBelow.children.indexOf(initialWorkflowComponent),
		);

		renderWidget(subagentContext, [makeJob("write", BASE_NOW + 2_000)], subagentOwner);
		tui.renderNow();
		expect(context.extensionWidgetsBelow.get("subagent-async")).toBe(subagentComponent);
		const afterSubagent = getLayoutFrame(tui);
		const afterDock = afterSubagent.root.children[1]!;
		const afterDockLines = afterSubagent.lines.slice(afterDock.rect.y, afterDock.rect.y + afterDock.rect.height);
		expect(afterDockLines.some((line) => line.includes("write"))).toBe(true);
	} finally {
		disposeWorkflowWidget();
		stopWidgetAnimation(undefined, subagentOwner);
		now.mockRestore();
	}
});
