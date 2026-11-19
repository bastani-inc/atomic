import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	agentPanelItems,
	subscribeAgentPanel,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	AGENT_PANEL_REFRESH_WINDOW_MS,
	agentPanelRows,
	bindAgentPanel,
	setAgentPanelVisible,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

initTheme("dark");

test("read-time source elapsed values are exact on first display and after a hidden period (#5239)", async () => {
	let now = 1000;
	const date = vi.spyOn(Date, "now").mockImplementation(() => now);
	const startedAt = now;
	const hub = new AgentPanelSourceHub();
	let notify = () => {};
	hub.register({
		items: () => [
			{
				id: "run:clock",
				kind: "agent",
				state: "running",
				name: "clock",
				task: "build",
				elapsedMs: now - startedAt,
			},
		],
		subscribe(listener) {
			notify = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let widget: { render(width: number): string[] } | undefined;
	now += 9000;
	const unbind = bindAgentPanel(session, {
		setWidget(_key, factory) {
			widget = typeof factory === "function" ? factory({ requestRender() {} } as never, theme) : undefined;
		},
		requestRender() {},
	});
	try {
		assert.equal(agentPanelRows(session)[0]?.elapsedMs, now - startedAt);
		assert.match(stripVTControlCharacters(widget!.render(80).join("\n")), /9s$/);
		setAgentPanelVisible(session, false);
		now += 10_000;
		notify();
		await Promise.resolve();
		now += 10_000;
		setAgentPanelVisible(session, true);
		assert.equal(agentPanelRows(session)[0]?.elapsedMs, now - startedAt);
		assert.match(stripVTControlCharacters(widget!.render(80).join("\n")), /29s$/);
	} finally {
		unbind();
		hub.dispose();
		date.mockRestore();
	}
});

test("a source applies all pending changes before returning its notified snapshot (#5239)", () => {
	const hub = new AgentPanelSourceHub();
	let generation = 0;
	let pending = 0;
	let notify = () => {};
	hub.register({
		items() {
			if (pending > 0) {
				generation += pending;
				pending = 0;
				notify();
			}
			return [{ id: "run:pending", kind: "agent", state: "running", name: "job", task: `generation ${generation}` }];
		},
		subscribe(listener) {
			notify = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	try {
		agentPanelItems(session);
		pending = 3;
		notify();
		assert.equal(agentPanelRows(session)[0]?.task, "generation 3");
		assert.equal(pending, 0);
		assert.equal(agentPanelRows(session)[0]?.task, "generation 3");
	} finally {
		hub.dispose();
	}
});

test("hidden panel refreshes sample extension sources without rebuilding background task rows (#5239)", async () => {
	const fixture = taskFixture();
	await fixture.start();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const hub = new AgentPanelSourceHub();
	let notify = () => {};
	let reads = 0;
	hub.register({
		items() {
			reads++;
			return [{ id: "run:sample", kind: "agent", state: "running", name: "job", task: "build" }];
		},
		subscribe(listener) {
			notify = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	bindOwnerTaskStore(session, fixture.store);
	const taskReads = vi.spyOn(fixture.store, "backgroundTasks", "get");
	const unbind = bindAgentPanel(session, { setWidget() {}, requestRender() {} });
	try {
		setAgentPanelVisible(session, false);
		taskReads.mockClear();
		reads = 0;
		notify();
		await vi.advanceTimersByTimeAsync(AGENT_PANEL_REFRESH_WINDOW_MS);
		assert.equal(taskReads.mock.calls.length, 0);
		assert.equal(reads, 1);
		setAgentPanelVisible(session, true);
		assert.equal(taskReads.mock.calls.length, 1);
		assert.equal(reads, 1);
	} finally {
		unbind();
		taskReads.mockRestore();
		hub.dispose();
		vi.useRealTimers();
		await fixture.dispose();
	}
});

test("a source that returns a pre-change snapshot and notifies inside items() renders the new rows while an always-notifying source still quiesces (#5224)", async () => {
	let generation = 0;
	let pending = false;
	let notifyLazy: (() => void) | undefined;
	let lazyReads = 0;
	const lazyHub = new AgentPanelSourceHub();
	lazyHub.register({
		items() {
			lazyReads++;
			const snapshot: AgentPanelItem[] =
				generation === 0
					? []
					: [
							{
								id: "ext:lazy",
								kind: "agent",
								state: "running",
								name: "job",
								task: `generation ${generation}`,
							},
						];
			if (pending) {
				pending = false;
				generation++;
				notifyLazy?.();
			}
			return snapshot;
		},
		subscribe(listener) {
			notifyLazy = listener;
			return () => {
				if (notifyLazy === listener) notifyLazy = undefined;
			};
		},
	});
	const lazySession = { extensionRunner: { getAgentPanelSourceHub: () => lazyHub } };
	const widget: { component?: { render(width: number): string[] } } = {};
	let painted = "";
	const unbindLazy = bindAgentPanel(lazySession, {
		setWidget(_key, factory) {
			widget.component = typeof factory === "function" ? factory({ requestRender() {} } as never, theme) : undefined;
		},
		requestRender() {
			painted = widget.component?.render(100).join("\n") ?? "";
		},
		notify() {},
	});
	try {
		assert.equal(widget.component, undefined);
		pending = true;
		notifyLazy?.();
		await vi.waitFor(() => assert.match(painted, /generation 1/));
		assert.equal(generation, 1);
		assert.equal(agentPanelRows(lazySession)[0]?.task, "generation 1");

		pending = true;
		generation++;
		notifyLazy?.();
		await vi.waitFor(() => assert.match(painted, /generation 3/));
		assert.equal(generation, 3);
		assert.equal(agentPanelRows(lazySession)[0]?.task, "generation 3");
		assert.ok(lazyReads <= 6);
	} finally {
		unbindLazy();
	}

	let alwaysReads = 0;
	let throwingReads = 0;
	let notifyAlways: (() => void) | undefined;
	let notifyThrowing: (() => void) | undefined;
	const noisyHub = new AgentPanelSourceHub();
	noisyHub.register({
		items() {
			alwaysReads++;
			notifyAlways?.();
			return [
				{
					id: "ext:always",
					kind: "agent",
					state: "running",
					name: "wf",
					task: `step ${alwaysReads}`,
				},
			];
		},
		subscribe(listener) {
			notifyAlways = listener;
			return () => {
				if (notifyAlways === listener) notifyAlways = undefined;
			};
		},
	});
	noisyHub.register({
		items() {
			throwingReads++;
			notifyThrowing?.();
			throw new Error("always fail after notify");
		},
		subscribe(listener) {
			notifyThrowing = listener;
			return () => {
				if (notifyThrowing === listener) notifyThrowing = undefined;
			};
		},
	});
	const noisySession = { extensionRunner: { getAgentPanelSourceHub: () => noisyHub } };
	const unbindNoisy = bindAgentPanel(noisySession, {
		setWidget() {},
		requestRender() {},
		notify() {},
	});
	try {
		notifyAlways?.();
		await vi.waitFor(() => assert.ok(alwaysReads >= 2 && throwingReads >= 2));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.ok(alwaysReads >= 2 && alwaysReads <= 4);
		assert.ok(throwingReads >= 2 && throwingReads <= 4);
	} finally {
		unbindNoisy();
	}
});

test("subscribeAgentPanel follows a non-transactional reload that invalidates the old runtime before registering on the new runtime and swapping the runner (#5224)", async () => {
	let runtime = createExtensionRuntime();
	const session = {
		get extensionRunner() {
			const current = runtime;
			return { getAgentPanelSourceHub: () => current.agentPanelSourceHub };
		},
	};
	let emitFirst = () => {};
	runtime.agentPanelSourceHub.register({
		items: () => [
			{
				id: "wf:first",
				kind: "agent",
				state: "running",
				name: "first",
				task: "stage one",
			},
		],
		subscribe(listener) {
			emitFirst = listener;
			return () => {};
		},
	});
	let notifications = 0;
	const unsubscribe = subscribeAgentPanel(session, () => {
		notifications++;
	});
	try {
		emitFirst();
		assert.equal(notifications, 1);

		const oldRuntime = runtime;
		oldRuntime.invalidate();
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		const nextRuntime = createExtensionRuntime();
		let emitReloaded = () => {};
		let active = false;
		nextRuntime.agentPanelSourceHub.register({
			items: () =>
				active
					? [
							{
								id: "wf:reloaded",
								kind: "agent",
								state: "running",
								name: "reloaded",
								task: "stage two",
							},
						]
					: [],
			subscribe(listener) {
				emitReloaded = listener;
				return () => {};
			},
		});
		runtime = nextRuntime;

		const beforeNotify = notifications;
		active = true;
		emitReloaded();
		assert.equal(notifications, beforeNotify + 1);
		assert.deepEqual(
			agentPanelItems(session).map((item) => item.id),
			["wf:reloaded"],
		);
	} finally {
		unsubscribe();
	}
});
