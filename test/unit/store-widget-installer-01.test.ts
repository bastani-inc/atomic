// @ts-nocheck
/**
 * Unit tests for store-widget-installer.
 * Tests: installStoreWidget (setWidget calls), installToolExecutionHooks (event subscriptions).
 * cross-ref: spec §5.4.4, §5.4.6, §5.5, §8.1 Phase E
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WidgetRenderState } from "../../packages/workflows/src/tui/store-widget-installer.js";
import { decideWidgetAction } from "../../packages/workflows/src/tui/store-widget-installer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _makeRun(id: string, name: string): RunSnapshot {
	return {
		id,
		name,
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now(),
	};
}

function _makeStage(id: string, name: string): StageSnapshot {
	return {
		id,
		name,
		status: "running",
		parentIds: [],
		toolEvents: [],
	};
}

// ---------------------------------------------------------------------------
// Mock pi API
// ---------------------------------------------------------------------------

interface SetWidgetCall {
	key: string;
	factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
	opts: { placement?: string } | undefined;
}

interface FakeTimerHandle {
	id: number;
	unrefCalls: number;
	unref(): void;
}

function _makeFakeTimers(): {
	setTimeout: (handler: () => void, delayMs: number) => FakeTimerHandle;
	clearTimeout: (handle: FakeTimerHandle) => void;
	scheduled: Array<{ handle: FakeTimerHandle; handler: () => void; delayMs: number; cleared: boolean }>;
} {
	let nextId = 1;
	const scheduled: Array<{ handle: FakeTimerHandle; handler: () => void; delayMs: number; cleared: boolean }> = [];
	return {
		scheduled,
		setTimeout(handler: () => void, delayMs: number): FakeTimerHandle {
			const handle: FakeTimerHandle = {
				id: nextId++,
				unrefCalls: 0,
				unref() {
					this.unrefCalls += 1;
				},
			};
			scheduled.push({ handle, handler, delayMs, cleared: false });
			return handle;
		},
		clearTimeout(handle: FakeTimerHandle): void {
			const timer = scheduled.find((entry) => entry.handle === handle);
			if (timer) timer.cleared = true;
		},
	};
}

function _makeMockPi(): {
	pi: {
		ui: {
			setWidget: (
				key: string,
				factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined,
				opts?: { placement?: string },
			) => void;
			requestRender: () => void;
		};
		on: (event: string, handler: (payload: unknown) => void) => void;
		events: {
			on: (event: string, handler: (payload: unknown) => void) => void;
		};
	};
	widgetCalls: SetWidgetCall[];
	eventHandlers: Map<string, (payload: unknown) => void>;
	extensionHandlers: Map<string, (payload: unknown) => void>;
	renderRequests: { count: number };
} {
	const widgetCalls: SetWidgetCall[] = [];
	const eventHandlers: Map<string, (payload: unknown) => void> = new Map();
	const extensionHandlers: Map<string, (payload: unknown) => void> = new Map();
	const renderRequests = { count: 0 };

	const pi = {
		ui: {
			setWidget(
				key: string,
				factory: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined,
				opts?: { placement?: string },
			): void {
				widgetCalls.push({ key, factory, opts });
			},
			requestRender(): void {
				renderRequests.count++;
			},
		},
		on(event: string, handler: (payload: unknown) => void): void {
			extensionHandlers.set(event, handler);
		},
		events: {
			on(event: string, handler: (payload: unknown) => void): void {
				eventHandlers.set(event, handler);
			},
		},
	};

	return { pi, widgetCalls, eventHandlers, extensionHandlers, renderRequests };
}

// ---------------------------------------------------------------------------
// decideWidgetAction (pure)
// ---------------------------------------------------------------------------

describe("decideWidgetAction", () => {
	const hidden: WidgetRenderState = { mounted: false, lines: [] };

	test("hidden + empty next lines → none", () => {
		assert.equal(decideWidgetAction(hidden, []), "none");
	});

	test("hidden + non-empty next lines → mount", () => {
		assert.equal(decideWidgetAction(hidden, ["● 80c5fe tournament · single · 0/1 · 3m 23s"]), "mount");
	});

	test("mounted + empty next lines → unmount", () => {
		const mounted: WidgetRenderState = { mounted: true, lines: ["● 80c5fe tournament · single · 0/1 · 3m 23s"] };
		assert.equal(decideWidgetAction(mounted, []), "unmount");
	});

	test("mounted + changed lines (elapsed advanced) → update", () => {
		const mounted: WidgetRenderState = { mounted: true, lines: ["● 80c5fe tournament · single · 0/1 · 3m 23s"] };
		assert.equal(decideWidgetAction(mounted, ["● 80c5fe tournament · single · 0/1 · 3m 29s"]), "update");
	});

	test("mounted + identical lines → none", () => {
		const lines = ["● 80c5fe tournament · single · 0/1 · 3m 23s", "     single · 3m 23s"];
		const mounted: WidgetRenderState = { mounted: true, lines };
		assert.equal(decideWidgetAction(mounted, [...lines]), "none");
	});
});
