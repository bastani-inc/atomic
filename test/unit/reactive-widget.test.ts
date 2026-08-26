import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	decideReactiveWidgetAction,
	installReactiveWidget,
	type ReactiveWidgetFactory,
	type ReactiveWidgetMountError,
	type ReactiveWidgetTimerHandle,
	type ReactiveWidgetUi,
} from "../../packages/coding-agent/src/core/extensions/reactive-widget.js";
import type { ExtensionWidgetOptions } from "../../packages/coding-agent/src/core/extensions/ui-types.js";

interface FakeTimerHandle extends ReactiveWidgetTimerHandle {
	id: number;
	unrefCalls: number;
}

function makeScheduler(): { queueMicrotask: (handler: () => void) => void; flush: () => void; queued: () => number } {
	const queue: Array<() => void> = [];
	return {
		queueMicrotask(handler: () => void): void {
			queue.push(handler);
		},
		flush(): void {
			while (queue.length > 0) queue.shift()!();
		},
		queued(): number {
			return queue.length;
		},
	};
}

function makeTimers(): {
	setTimeout: (handler: () => void, delayMs: number) => FakeTimerHandle;
	clearTimeout: (handle: ReactiveWidgetTimerHandle) => void;
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
					this.unrefCalls++;
				},
			};
			scheduled.push({ handle, handler, delayMs, cleared: false });
			return handle;
		},
		clearTimeout(handle: ReactiveWidgetTimerHandle): void {
			const timer = scheduled.find((entry) => entry.handle === handle);
			if (timer) timer.cleared = true;
		},
	};
}

function makeUi() {
	const widgetCalls: Array<{ key: string; factory: unknown; options: unknown }> = [];
	let renderRequests = 0;
	return {
		ui: {
			setWidget(key: string, factory: unknown, options?: unknown): void {
				widgetCalls.push({ key, factory, options });
			},
			requestRender(): void {
				renderRequests++;
			},
		},
		widgetCalls,
		renderRequests: () => renderRequests,
	};
}

describe("decideReactiveWidgetAction", () => {
	test("maps visibility transitions to mount/update/unmount/none", () => {
		assert.equal(decideReactiveWidgetAction({ mounted: false, lines: [] }, []), "none");
		assert.equal(decideReactiveWidgetAction({ mounted: false, lines: [] }, ["run"]), "mount");
		assert.equal(decideReactiveWidgetAction({ mounted: true, lines: ["run"] }, []), "unmount");
		assert.equal(decideReactiveWidgetAction({ mounted: true, lines: ["run"] }, ["run 2"]), "update");
		assert.equal(decideReactiveWidgetAction({ mounted: true, lines: ["run"] }, ["run"]), "none");
	});
});

describe("installReactiveWidget", () => {
	test("mounts once, updates in place, and unmounts once", () => {
		const scheduler = makeScheduler();
		const { ui, widgetCalls, renderRequests } = makeUi();
		let now = 1_000;
		let snapshot = { visible: false, label: "" };

		const controller = installReactiveWidget({
			ui,
			key: "test.widget",
			placement: "belowEditor",
			scheduler,
			now: () => now,
			getSnapshot: () => snapshot,
			getPreviewLines: (snap) => (snap.visible ? [snap.label] : []),
			render: (snap, context) => [`${context.now}:${snap.label}:${context.width}`],
		});

		assert.equal(widgetCalls.length, 0, "initial hidden state should not mount");

		snapshot = { visible: true, label: "run" };
		controller.refresh("state");
		assert.equal(widgetCalls.length, 1, "visible state should mount once");
		assert.deepEqual(widgetCalls[0]?.options, { placement: "belowEditor" });
		scheduler.flush();
		assert.equal(renderRequests(), 1);

		const factory = widgetCalls[0]?.factory;
		assert.equal(typeof factory, "function");
		const component = (factory as (tui: object, theme: object) => { render(width: number): string[] })({}, {});
		assert.deepEqual(component.render(80), ["1000:run:80"]);

		now = 2_000;
		snapshot = { visible: true, label: "run updated" };
		controller.refresh("state");
		assert.equal(widgetCalls.length, 1, "visible update must not remount");
		scheduler.flush();
		assert.equal(renderRequests(), 2);
		assert.deepEqual(component.render(80), ["2000:run updated:80"]);

		snapshot = { visible: false, label: "" };
		controller.refresh("state");
		assert.equal(widgetCalls.length, 2, "hidden transition should unmount once");
		assert.equal(widgetCalls[1]?.factory, undefined);
		scheduler.flush();
		assert.equal(renderRequests(), 3);
	});

	test("remounts once after the host releases a live widget", () => {
		const scheduler = makeScheduler();
		const widgetCalls: Array<{
			key: string;
			factory: ReactiveWidgetFactory<object> | undefined;
			options: ExtensionWidgetOptions | undefined;
		}> = [];
		const releaseListeners = new Map<string, Set<() => void>>();
		const ui: ReactiveWidgetUi<object> = {
			setWidget(
				key: string,
				factory: ReactiveWidgetFactory<object> | undefined,
				options?: ExtensionWidgetOptions,
			): void {
				widgetCalls.push({ key, factory, options });
			},
			requestRender(): void {},
			onWidgetRelease(key: string, listener: () => void): () => void {
				const listeners = releaseListeners.get(key) ?? new Set<() => void>();
				listeners.add(listener);
				releaseListeners.set(key, listeners);
				return () => listeners.delete(listener);
			},
		};
		const snapshot = { visible: true, label: "run" };
		const controller = installReactiveWidget({
			ui,
			key: "test.widget",
			scheduler,
			getSnapshot: () => snapshot,
			getPreviewLines: (snap) => (snap.visible ? [snap.label] : []),
			render: (snap) => [snap.label],
		});

		assert.equal(widgetCalls.length, 1);
		for (const listener of releaseListeners.get("test.widget") ?? []) listener();
		assert.equal(controller.isMounted(), false);
		scheduler.flush();
		assert.equal(widgetCalls.length, 2, "release should schedule exactly one fresh mount");

		controller.refresh("state");
		assert.equal(widgetCalls.length, 2, "ordinary updates after remount must stay in place");
	});

	test("reports a stale mount failure once without rearming clock refresh", () => {
		const scheduler = makeScheduler();
		const timers = makeTimers();
		let snapshot = { visible: true };
		let shouldThrow = true;
		let mountAttempts = 0;
		let mountErrors = 0;
		const ui = {
			setWidget(_key: string, factory: ReactiveWidgetFactory<object> | undefined): void {
				if (factory === undefined) return;
				mountAttempts++;
				if (shouldThrow) throw new Error("This extension ctx is stale after session replacement");
			},
			requestRender(): void {},
		};
		let mountError: ReactiveWidgetMountError | undefined;
		const controller = installReactiveWidget({
			ui,
			key: "test.widget",
			scheduler,
			timers,
			getSnapshot: () => snapshot,
			getPreviewLines: (current) => (current.visible ? ["run"] : []),
			render: () => ["run"],
			getNextRefreshDelayMs: (current) => (current.visible ? 100 : undefined),
			isStaleError: (error) => error instanceof Error && error.message.includes("ctx is stale"),
			onMountError: (error) => {
				mountError = error;
				mountErrors++;
			},
		});

		assert.equal(mountAttempts, 1, "initial visible state should attempt one mount");
		assert.equal(mountErrors, 1, "initial stale mount failure should be observable once");
		assert.ok(mountError);
		assert.equal(mountError.message, "This extension ctx is stale after session replacement");
		assert.ok(mountError.cause instanceof Error);
		assert.equal(mountError.cause.message, mountError.message);
		const pendingTimers = timers.scheduled.filter((timer) => !timer.cleared);
		assert.equal(pendingTimers.length, 0, "a failed mount must not arm a clock refresh");
		for (const timer of pendingTimers) timer.handler();
		assert.equal(mountAttempts, 1, "without a timer, clock refresh must not retry the mount");
		assert.equal(mountErrors, 1, "without a timer, clock refresh must not repeat the warning");

		controller.refresh("state");
		assert.equal(mountAttempts, 2, "a later state refresh may retry the failed mount");
		assert.equal(mountErrors, 1, "repeated stale failures must not repeat the warning");
		assert.equal(timers.scheduled.filter((timer) => !timer.cleared).length, 0);

		shouldThrow = false;
		controller.refresh("state");
		assert.equal(mountAttempts, 3, "a later successful state refresh should mount");
		snapshot = { visible: false };
		controller.refresh("state");
		shouldThrow = true;
		snapshot = { visible: true };
		controller.refresh("state");
		assert.equal(mountErrors, 2, "a successful mount should reset stale-failure reporting");
		assert.equal(timers.scheduled.filter((timer) => !timer.cleared).length, 0);
		controller.dispose();
	});

	test("reports and rethrows generic mount failures once before retry", () => {
		const timers = makeTimers();
		let snapshot = { visible: false };
		let mountAttempts = 0;
		let mountError: ReactiveWidgetMountError | undefined;
		const originalError = new Error("renderer init failed");
		const ui: ReactiveWidgetUi<object> = {
			setWidget(_key, factory): void {
				if (factory === undefined) return;
				mountAttempts++;
				throw originalError;
			},
			requestRender(): void {},
		};
		const controller = installReactiveWidget({
			ui,
			key: "test.widget",
			timers,
			getSnapshot: () => snapshot,
			getPreviewLines: (current) => (current.visible ? ["run"] : []),
			render: () => ["run"],
			getNextRefreshDelayMs: () => 100,
			isStaleError: () => false,
			onMountError: (error) => {
				mountError = error;
			},
		});

		snapshot = { visible: true };
		assert.throws(
			() => controller.refresh("state"),
			(error) => error === originalError,
		);
		assert.equal(mountAttempts, 1);
		assert.ok(mountError);
		assert.equal(mountError.message, "renderer init failed");
		assert.equal(mountError.cause, originalError);
		assert.equal(timers.scheduled.filter((timer) => !timer.cleared).length, 0);

		assert.throws(
			() => controller.refresh("state"),
			(error) => error === originalError,
		);
		assert.equal(mountAttempts, 2);
		assert.equal(mountError.message, "renderer init failed");
		assert.equal(timers.scheduled.filter((timer) => !timer.cleared).length, 0);
		controller.dispose();
	});

	test("rolls back subscriptions when the initial mount fails", () => {
		const originalError = new Error("renderer init failed during installation");
		const releaseListeners = new Set<() => void>();
		const subscriptions = new Set<() => void>();
		let mountAttempts = 0;
		const ui: ReactiveWidgetUi<object> = {
			setWidget(_key, factory): void {
				if (factory === undefined) return;
				mountAttempts++;
				throw originalError;
			},
			onWidgetRelease(_key, listener): () => void {
				releaseListeners.add(listener);
				return () => releaseListeners.delete(listener);
			},
		};

		const install = (): void => {
			assert.throws(
				() =>
					installReactiveWidget({
						ui,
						key: "test.widget",
						subscribe: () => {
							const subscription = (): void => {};
							subscriptions.add(subscription);
							return () => subscriptions.delete(subscription);
						},
						getSnapshot: () => ({ visible: true }),
						getPreviewLines: () => ["run"],
						render: () => ["run"],
					}),
				(error) => error === originalError,
			);
			assert.equal(releaseListeners.size, 0, "failed installation must remove the host release listener");
			assert.equal(subscriptions.size, 0, "failed installation must remove the store subscription");
		};

		install();
		install();
		assert.equal(mountAttempts, 2);
		assert.equal(releaseListeners.size, 0, "repeated failed installations must not accumulate listeners");
	});

	test("propagates stale-looking mount reporter failures", () => {
		const reporterError = new Error("Reporting failed because extension ctx is stale");
		const ui = {
			setWidget(): void {
				throw new Error("This extension ctx is stale after session replacement");
			},
		};

		assert.throws(
			() =>
				installReactiveWidget({
					ui,
					key: "test.widget",
					getSnapshot: () => ({ visible: true }),
					getPreviewLines: () => ["run"],
					render: () => ["run"],
					isStaleError: (error) => error instanceof Error && error.message.includes("ctx is stale"),
					onMountError: () => {
						throw reporterError;
					},
				}),
			(error) => error === reporterError,
		);
	});

	test("state no-op refresh still requests paint, clock no-op does not", () => {
		const scheduler = makeScheduler();
		const { ui, renderRequests } = makeUi();
		const snapshot = { visible: true, label: "run" };

		const controller = installReactiveWidget({
			ui,
			key: "test.widget",
			scheduler,
			now: () => 1_000,
			getSnapshot: () => snapshot,
			getPreviewLines: (snap) => (snap.visible ? [snap.label] : []),
			render: (snap) => [snap.label],
		});
		scheduler.flush();
		assert.equal(renderRequests(), 1);

		controller.refresh("state");
		scheduler.flush();
		assert.equal(renderRequests(), 2, "semantic state refresh should repaint even when preview lines are unchanged");

		controller.refresh("clock");
		scheduler.flush();
		assert.equal(renderRequests(), 2, "clock refresh with unchanged preview lines should stay quiet");
	});

	test("coalesces multiple render requests in one microtask", () => {
		const scheduler = makeScheduler();
		const { ui, renderRequests } = makeUi();
		let snapshot = { visible: true, label: "one" };

		const controller = installReactiveWidget({
			ui,
			key: "test.widget",
			scheduler,
			now: () => 1_000,
			getSnapshot: () => snapshot,
			getPreviewLines: (snap) => (snap.visible ? [snap.label] : []),
			render: (snap) => [snap.label],
		});
		assert.equal(scheduler.queued(), 1);

		snapshot = { visible: true, label: "two" };
		controller.refresh("state");
		snapshot = { visible: true, label: "three" };
		controller.refresh("state");
		assert.equal(scheduler.queued(), 1, "pending render should absorb later refreshes");

		scheduler.flush();
		assert.equal(renderRequests(), 1);
	});

	test("uses the mounted TUI requestRender fallback when the extension UI lacks one", () => {
		const scheduler = makeScheduler();
		const timers = makeTimers();
		const widgetCalls: Array<{ key: string; factory: unknown; options: unknown }> = [];
		let now = 1_000;
		const snapshot = { visible: true, label: "run" };
		interface RequestRenderHost {
			calls: number;
			requestRender(this: RequestRenderHost): void;
		}
		const host: RequestRenderHost = {
			calls: 0,
			requestRender(): void {
				assert.equal(this, host, "fallback requestRender should stay bound to the TUI host");
				this.calls++;
			},
		};
		const ui = {
			setWidget(
				key: string,
				factory: ((tui: unknown, theme: object) => { render(width: number): string[] }) | undefined,
				options?: unknown,
			): void {
				widgetCalls.push({ key, factory, options });
				factory?.(host, {});
			},
		};

		installReactiveWidget({
			ui,
			key: "test.widget",
			scheduler,
			timers,
			now: () => now,
			getSnapshot: () => snapshot,
			getPreviewLines: (snap, capturedNow) => (snap.visible ? [`${snap.label}:${capturedNow}`] : []),
			render: (snap, context) => [`${snap.label}:${context.now}`],
			getNextRefreshDelayMs: () => 100,
		});
		scheduler.flush();
		assert.equal(host.calls, 1, "mount should request a render through the TUI fallback");

		now = 1_100;
		timers.scheduled[0]!.handler();
		scheduler.flush();
		assert.equal(host.calls, 2, "timer tick should repaint through the TUI fallback");
		assert.equal(widgetCalls.length, 1, "timer tick must not remount to find the fallback");
	});

	test("timer refresh advances captured time and is cleaned up on dispose", () => {
		const scheduler = makeScheduler();
		const timers = makeTimers();
		const { ui, widgetCalls, renderRequests } = makeUi();
		let now = 1_000;
		const snapshot = { visible: true, label: "run" };

		const controller = installReactiveWidget({
			ui,
			key: "test.widget",
			scheduler,
			timers,
			now: () => now,
			getSnapshot: () => snapshot,
			getPreviewLines: (snap, capturedNow) => (snap.visible ? [`${snap.label}:${capturedNow}`] : []),
			render: (snap, context) => [`${snap.label}:${context.now}`],
			getNextRefreshDelayMs: () => 100,
		});
		scheduler.flush();
		assert.equal(renderRequests(), 1);
		assert.equal(timers.scheduled.length, 1);
		assert.equal(timers.scheduled[0]?.delayMs, 100);
		assert.equal(timers.scheduled[0]?.handle.unrefCalls, 1);

		const factory = widgetCalls[0]?.factory;
		assert.equal(typeof factory, "function");
		const component = (factory as (tui: object, theme: object) => { render(width: number): string[] })({}, {});
		assert.deepEqual(component.render(80), ["run:1000"]);

		now = 1_100;
		timers.scheduled[0]!.handler();
		scheduler.flush();
		assert.equal(renderRequests(), 2);
		assert.deepEqual(component.render(80), ["run:1100"]);
		assert.equal(timers.scheduled.length, 2, "clock refresh should schedule the next timer");

		controller.dispose();
		assert.equal(timers.scheduled[1]?.cleared, true);
		assert.equal(widgetCalls.at(-1)?.factory, undefined);
	});

	test("swallows configured stale requestRender errors from coalesced paints", () => {
		const scheduler = makeScheduler();
		const ui = {
			setWidget(): void {},
			requestRender(): void {
				throw new Error("This extension ctx is stale after session replacement");
			},
		};

		installReactiveWidget({
			ui,
			key: "test.widget",
			scheduler,
			getSnapshot: () => ({ visible: true }),
			getPreviewLines: () => ["run"],
			render: () => ["run"],
			isStaleError: (error) => error instanceof Error && error.message.includes("ctx is stale"),
		});

		assert.doesNotThrow(() => scheduler.flush());
	});

	test("swallows configured stale context errors", () => {
		const scheduler = makeScheduler();
		const ui = {
			setWidget() {
				throw new Error("This extension ctx is stale after session replacement");
			},
			requestRender() {},
		};

		assert.doesNotThrow(() =>
			installReactiveWidget({
				ui,
				key: "test.widget",
				scheduler,
				getSnapshot: () => ({ visible: true }),
				getPreviewLines: () => ["run"],
				render: () => ["run"],
				isStaleError: (error) => error instanceof Error && error.message.includes("ctx is stale"),
			}),
		);
	});
});
