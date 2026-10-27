import assert from "node:assert/strict";
import { test, vi } from "vitest";
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
	// The widget's elapsed-clock tick takes its delay from the wall clock through the same timers. Pin the wall
	// clock at a whole second of the run's elapsed time so that tick is a full second out, never mistaken for
	// the budget's deferred refresh.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(run("root").startedAt + 1_000_000);
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
		vi.useRealTimers();
	}
});

test("a deferred widget refresh that fails stays inside its timer instead of crashing the host (#4009)", () => {
	// As in an RPC host: every widget mount throws. A refresh run by a store change is contained by the store's
	// publish; the budget's deferred refresh runs from a timer, where an escaping error would end the process.
	const { store, clock, refreshes } = costlyStore(3);
	const timers = fakeTimers();
	const dispose = installStoreWidget(
		{
			ui: {
				setWidget: (_key, factory) => {
					if (factory) throw new Error("Component-factory widgets are unavailable in this RPC host.");
				},
				notify: () => {},
			},
		},
		store,
		timers.api,
		clock,
	);
	try {
		store.recordRunStart(run("root"));
		for (let index = 0; index < 100; index++) store.recordRunExecutionState("root", { lastProgressAt: index });
		const deferred = timers.scheduled.filter((timer) => !timer.cleared);
		assert.equal(deferred.length, 1, "the over-budget changes fold into one deferred refresh");

		const before = refreshes();
		assert.doesNotThrow(() => deferred[0]!.handler());
		assert.equal(refreshes(), before + 1, "the deferred refresh still ran");
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
