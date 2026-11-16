import assert from "node:assert/strict";
import { test } from "vitest";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
	agentPanelItems,
	subscribeAgentPanel,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelRows, bindAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";

initTheme("dark");

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
	const renderWidget = () => widget.component?.render(100) ?? [];
	const unbindLazy = bindAgentPanel(lazySession, {
		setWidget(_key, factory) {
			widget.component = typeof factory === "function" ? factory({ requestRender() {} } as never, theme) : undefined;
		},
		requestRender() {},
		notify() {},
	});
	try {
		assert.equal(widget.component, undefined);
		pending = true;
		notifyLazy?.();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.equal(generation, 1);
		assert.equal(agentPanelRows(lazySession)[0]?.task, "generation 1");
		assert.match(renderWidget().join("\n"), /generation 1/);

		pending = true;
		generation++;
		notifyLazy?.();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.equal(generation, 3);
		assert.equal(agentPanelRows(lazySession)[0]?.task, "generation 3");
		assert.match(renderWidget().join("\n"), /generation 3/);
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
					kind: "workflow",
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
				kind: "workflow",
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
								kind: "workflow",
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
