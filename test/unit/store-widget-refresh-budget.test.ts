import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	installStoreWidget,
	WIDGET_REFRESH_BUDGET_MS,
	WIDGET_REFRESH_BURST,
	WIDGET_REFRESH_WINDOW_MS,
} from "../../packages/workflows/src/tui/store-widget-installer.js";

interface Timer {
	readonly handler: () => void;
	readonly delayMs: number;
	cleared: boolean;
}

function run(id: string): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 1 };
}

/** Each widget refresh reads the store's runs once; this one makes every read cost `costMs` of `clock`. */
function costlyStore(costMs: number) {
	const store = createStore();
	let now = 1_000;
	let refreshes = 0;
	const runs = store.runs.bind(store);
	store.runs = () => {
		refreshes++;
		now += costMs;
		return runs();
	};
	return {
		store,
		clock: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		refreshes: () => refreshes,
	};
}

interface TimerHandle {
	unref(): void;
}

function fakeTimers() {
	const scheduled: Timer[] = [];
	const timers = new Map<TimerHandle, Timer>();
	return {
		scheduled,
		api: {
			setTimeout(handler: () => void, delayMs: number): TimerHandle {
				const timer: Timer = { handler, delayMs, cleared: false };
				const handle: TimerHandle = { unref() {} };
				scheduled.push(timer);
				timers.set(handle, timer);
				return handle;
			},
			clearTimeout(handle: TimerHandle): void {
				const timer = timers.get(handle);
				if (timer) timer.cleared = true;
			},
		},
	};
}

test("a burst of store changes refreshes the widget within its budget, then once at the window's end (#4009)", () => {
	const costMs = 3;
	const { store, clock, advance, refreshes } = costlyStore(costMs);
	const timers = fakeTimers();
	const dispose = installStoreWidget(
		{ ui: { setWidget: () => {}, requestRender: () => {} } },
		store,
		timers.api,
		clock,
	);
	try {
		store.recordRunStart(run("root"));
		// The installation's initial refresh is not a store change and counts against no window.
		const before = refreshes();
		for (let index = 0; index < 100; index++) store.recordRunExecutionState("root", { lastProgressAt: index });

		const immediate = refreshes() - before;
		assert.ok(
			immediate <= Math.max(WIDGET_REFRESH_BURST, Math.ceil(WIDGET_REFRESH_BUDGET_MS / costMs) + 1),
			`${immediate} immediate refreshes`,
		);
		const deferred = timers.scheduled.filter((timer) => !timer.cleared && timer.delayMs <= WIDGET_REFRESH_WINDOW_MS);
		assert.equal(deferred.length, 1, "the remaining changes fold into one deferred refresh");

		advance(WIDGET_REFRESH_WINDOW_MS);
		deferred[0]!.handler();
		assert.equal(refreshes() - before, immediate + 1);

		// After a quiet window, a single change refreshes at once again.
		advance(WIDGET_REFRESH_WINDOW_MS);
		store.recordRunExecutionState("root", { lastProgressAt: 1_000 });
		assert.equal(refreshes() - before, immediate + 2);
	} finally {
		dispose();
	}
});

test("cheap widget refreshes still follow every store change at once (#4009)", () => {
	const { store, clock, refreshes } = costlyStore(0);
	const timers = fakeTimers();
	const dispose = installStoreWidget(
		{ ui: { setWidget: () => {}, requestRender: () => {} } },
		store,
		timers.api,
		clock,
	);
	try {
		store.recordRunStart(run("root"));
		const before = refreshes();
		for (let index = 0; index < 100; index++) store.recordRunExecutionState("root", { lastProgressAt: index });
		assert.equal(refreshes() - before, 100);
	} finally {
		dispose();
	}
});

test("a deferred widget refresh contains a host mount failure like an immediate one does", () => {
	const { store, clock, advance } = costlyStore(3);
	const timers = fakeTimers();
	const notices: string[] = [];
	// Plain RPC hosts refuse component-factory widgets on every mount attempt.
	const setWidget = (_key: string, content: unknown) => {
		if (typeof content === "function") throw new Error("Component-factory widgets are unavailable in this RPC host.");
	};
	const dispose = installStoreWidget(
		{ ui: { setWidget, requestRender: () => {}, notify: (message: string) => notices.push(message) } },
		store,
		timers.api,
		clock,
	);
	try {
		store.recordRunStart(run("root"));
		for (let index = 0; index < 100; index++) store.recordRunExecutionState("root", { lastProgressAt: index });
		const deferred = timers.scheduled.filter((timer) => !timer.cleared && timer.delayMs <= WIDGET_REFRESH_WINDOW_MS);
		assert.equal(deferred.length, 1);
		advance(WIDGET_REFRESH_WINDOW_MS);
		assert.doesNotThrow(() => deferred[0]!.handler());
		assert.equal(notices.length, 1, notices.join("\n"));
	} finally {
		dispose();
	}
});
