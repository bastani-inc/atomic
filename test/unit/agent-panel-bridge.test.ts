import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-editor-actions.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-custom-ui.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-runtime.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-render-chat.js";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { Container } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-deps.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
import {
	agentPanelHasRows,
	bindAgentPanel,
	setAgentPanelVisible,
	showAgentPanel,
	themedAgentPanelStyle,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import type { TaskInspectorUi } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

initTheme("dark");

const healthyRow: AgentPanelItem = {
	id: "run:healthy",
	kind: "agent",
	state: "running",
	name: "ralph",
	task: "stage build",
	elapsedMs: 5_000,
};

interface MountedPanelComponent {
	invalidate(): void;
	render(width: number): string[];
	handleInput(data: string): boolean;
	dispose(): void;
}

function createPanelUi(
	options: {
		onMount?: (component: MountedPanelComponent, done: () => void) => void | Promise<void>;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	} = {},
): TaskInspectorUi & { mounts: number } {
	const ui: TaskInspectorUi & { mounts: number } = {
		mounts: 0,
		notify: options.notify,
		getChatRenderSettings: () => ({}) as never,
		getFooterDataProvider: () => ({}) as never,
		getToolsExpanded: () => false,
		setToolsExpanded() {},
		async custom(factory) {
			ui.mounts++;
			return new Promise<void>((resolve, reject) => {
				let component: MountedPanelComponent | undefined;
				let finished = false;
				let mountSettled = false;
				let mountFailed = false;
				const done = () => {
					if (finished) return;
					finished = true;
					component?.dispose();
					if (mountSettled && !mountFailed) resolve();
				};
				let mountResult: void | Promise<void>;
				try {
					component = factory(
						{ requestRender() {}, terminal: { rows: 24 } } as never,
						theme,
						new KeybindingsManager(),
						done as never,
					) as MountedPanelComponent;
					mountResult = options.onMount?.(component, done);
				} catch (error) {
					mountFailed = true;
					mountSettled = true;
					component?.dispose();
					reject(error);
					return;
				}
				if (mountResult !== undefined && typeof (mountResult as { readonly then?: unknown }).then === "function") {
					void Promise.resolve(mountResult).then(
						() => {
							mountSettled = true;
							if (finished && !mountFailed) resolve();
						},
						(error) => {
							mountFailed = true;
							mountSettled = true;
							component?.dispose();
							reject(error);
						},
					);
					return;
				}
				mountSettled = true;
				if (finished && !mountFailed) resolve();
			}) as never;
		},
	};
	return ui;
}

test("a source that reopens the panel while listing rows cannot mount a second panel (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const ui = createPanelUi({ onMount: (_component, done) => done() });
	let nested: Promise<void> | undefined;
	let reentered = false;
	hub.register({
		items: () => {
			if (!reentered) {
				reentered = true;
				nested = showAgentPanel(session, ui);
			}
			return [healthyRow];
		},
		subscribe: () => () => {},
	});
	await showAgentPanel(session, ui);
	await nested;
	assert.equal(ui.mounts, 1);
});

test("showAgentPanel stop chain normalizes non-string reasons, strips terminal controls, and catches rejections (#5224, #5239)", async () => {
	const reasons: Array<string | symbol | object> = [
		Symbol("stop-symbol"),
		Object.create(null) as object,
		{
			toString() {
				throw new Error("reason toString exploded");
			},
		},
		"\x1b]0;pwned\x07blocked\nnext",
	];
	const unhandled: Error[] = [];
	const onUnhandled = (reason: Error) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		for (const reason of reasons) {
			const hub = new AgentPanelSourceHub();
			hub.register({
				items: () => [{ ...healthyRow, name: "ralph\x1b]0;title\x07" }],
				subscribe: () => () => {},
				stop: async () => ({ ok: false, reason: reason as string }),
			});
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			const warnings: string[] = [];
			const ui = createPanelUi({
				notify: (message) => warnings.push(message),
				async onMount(component, done) {
					component.handleInput("x");
					component.handleInput("x");
					await new Promise<void>((resolve) => setImmediate(resolve));
					done();
				},
			});
			await showAgentPanel(session, ui);
			assert.equal(unhandled.length, 0);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /^Could not stop ralph: /);
			assert.equal(warnings[0]!.includes("\x1b"), false);
			assert.equal(warnings[0]!.includes("\x07"), false);
		}
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("unfocused and focused panel renders catch unexpected throws without per-frame projection, return empty lines, and report once (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	let reads = 0;
	hub.register({
		items: () => {
			reads++;
			return [healthyRow];
		},
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const warnings: string[] = [];
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: object | undefined) {
			widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
		},
		requestRender() {},
		notify: (message: string) => warnings.push(message),
	} as never);
	try {
		assert.ok(widget);
		reads = 0;
		const throwingWidth = {
			valueOf() {
				throw Object.create(null);
			},
		} as never as number;
		assert.deepEqual(widget!.render(throwingWidth), []);
		assert.deepEqual(widget!.render(throwingWidth), []);
		assert.equal(reads, 0, "render fault is caught without re-reading source items");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /^Agent panel: a source failed:/);
		assert.doesNotMatch(warnings[0]!, /and is hidden/);

		const focusedThrowingWidth = {
			valueOf() {
				throw new Error("focused width fault");
			},
		} as never as number;
		const ui = createPanelUi({
			notify: (message) => warnings.push(message),
			onMount(component, done) {
				reads = 0;
				assert.deepEqual(component.render(focusedThrowingWidth), []);
				assert.deepEqual(component.render(focusedThrowingWidth), []);
				assert.equal(reads, 0, "focused render fault is caught without re-reading source items");
				done();
			},
		});
		await showAgentPanel(session, ui);
		assert.equal(warnings.length, 2);
		assert.match(warnings[1]!, /^Agent panel: a source failed: focused width fault/);
	} finally {
		dispose();
	}
});

test("update catch in bindAgentPanel remains total even when widget teardown throws (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	const listeners = new Set<() => void>();
	let broken = false;
	hub.register({
		items: () => [healthyRow],
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const session = {
		extensionRunner: { getAgentPanelSourceHub: () => hub },
	};
	const warnings: string[] = [];
	let widget: object | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: object | undefined) {
			widget = content;
			if (content === undefined) throw Object.create(null);
		},
		requestRender() {
			if (broken) throw Object.create(null);
		},
		notify: (message: string) => warnings.push(message),
	} as never);
	try {
		assert.notEqual(widget, undefined);
		broken = true;
		for (const listener of listeners) listener();
		await vi.waitFor(() => assert.equal(widget, undefined));
		assert.equal(agentPanelHasRows(session), true);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /^Agent panel: a source failed:/);
	} finally {
		dispose();
	}
});

test("focused panel coalesces notification bursts into one microtask and contains listener errors (#5224, #5239)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("background worker");
		const hub = new AgentPanelSourceHub();
		const listeners = new Set<() => void>();
		let reads = 0;
		let throwNullProto = false;
		hub.register({
			items: () => {
				reads++;
				if (throwNullProto) throw Object.create(null);
				return [healthyRow];
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		});
		const session = {
			extensionRunner: {
				getAgentPanelSourceHub: () => hub,
			},
		};
		bindOwnerTaskStore(session, fixture.store);
		const warnings: string[] = [];
		const unhandled: Error[] = [];
		const onUnhandled = (reason: Error) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const ui = createPanelUi({
				notify: (message) => warnings.push(message),
				async onMount(component, done) {
					reads = 0;
					for (let i = 0; i < 1000; i++) {
						for (const listener of listeners) listener();
					}
					const synchronousReads = reads;
					await Promise.resolve();
					assert.equal(synchronousReads, 0, "burst notifications do not rebuild synchronously");
					assert.equal(reads, 1, "coalesced into one refresh");
					const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
					const accentSpy = vi.spyOn(themedAgentPanelStyle(), "accent");
					try {
						const firstFocused80 = component.render(80);
						assert.ok(accentSpy.mock.calls.length > 0);
						accentSpy.mockClear();
						const secondFocused80 = component.render(80);
						assert.equal(accentSpy.mock.calls.length, 0, "focused render reuses cached row lines");
						assert.deepEqual(secondFocused80, firstFocused80);
						component.invalidate();
						const invalidatedFocused80 = component.render(80);
						assert.ok(accentSpy.mock.calls.length > 0, "focused invalidate forces a fresh row render");
						assert.deepEqual(invalidatedFocused80, firstFocused80);
					} finally {
						accentSpy.mockRestore();
						nowSpy.mockRestore();
					}
					component.render(100);
					assert.equal(reads, 1, "focused render uses cached rows between notifications");

					throwNullProto = true;
					for (const listener of listeners) listener();
					await Promise.resolve();
					assert.equal(unhandled.length, 0);
					assert.equal(warnings.length, 1);
					done();
				},
			});
			await showAgentPanel(session, ui);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	} finally {
		await fixture.dispose();
	}
});

test("focused panel contains malformed source items when a real OwnerTaskStore event fires (#5224, #5239)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("first worker");
		const hub = new AgentPanelSourceHub();
		const listeners = new Set<() => void>();
		let malformed = false;
		hub.register({
			items: () => {
				if (malformed) {
					return [{ ...healthyRow, id: 123 as never as string }];
				}
				return [healthyRow];
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		});
		const session = {
			extensionRunner: {
				getAgentPanelSourceHub: () => hub,
			},
		};
		bindOwnerTaskStore(session, fixture.store);
		const warnings: string[] = [];
		const ui = createPanelUi({
			notify: (message) => warnings.push(message),
			async onMount(component, done) {
				malformed = true;
				for (const listener of listeners) listener();
				await fixture.start("second worker");
				await fixture.settle(0);
				await Promise.resolve();
				const rendered = component.render(120).join("\n");
				assert.match(rendered, /second worker/);
				assert.equal(fixture.store.tasks.length, 2);
				assert.equal(warnings.length, 1);
				assert.match(warnings[0]!, /^Agent panel: a source failed:/);
				done();
			},
		});
		await showAgentPanel(session, ui);
	} finally {
		await fixture.dispose();
	}
});

test("a source with one malformed row and a valid neighbour keeps the neighbour visible and reports without claiming the source is hidden (#5224, #5239)", () => {
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [
			healthyRow,
			{ ...healthyRow, id: "run:malformed-choices", choices: {} as never as readonly string[] },
		],
		subscribe: () => () => {},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const warnings: string[] = [];
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: object | undefined) {
			widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
		},
		requestRender() {},
		notify: (message: string) => warnings.push(message),
	} as never);
	try {
		assert.ok(widget);
		const rendered = widget!.render(120).join("\n");
		assert.match(rendered, /ralph/);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /^Agent panel: a source failed:/);
		assert.doesNotMatch(warnings[0]!, /and is hidden/);
	} finally {
		dispose();
	}
});

test("unfocused panel skips row recomputation while hidden and reuses cached rendered lines across frames (#5224, #5239)", async () => {
	assert.equal(themedAgentPanelStyle(), themedAgentPanelStyle());
	const nowSpy = vi.spyOn(Date, "now").mockReturnValue(10_000);
	const hub = new AgentPanelSourceHub();
	const listeners = new Set<() => void>();
	let reads = 0;
	hub.register({
		items: () => {
			reads++;
			return [healthyRow];
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	let widget: { invalidate(): void; render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: object | undefined) {
			widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
		},
		requestRender() {},
	} as never);
	try {
		assert.ok(widget);
		reads = 0;
		const style = themedAgentPanelStyle();
		const mutedSpy = vi.spyOn(style, "muted");
		try {
			const first80 = widget!.render(80);
			assert.ok(mutedSpy.mock.calls.length > 0);
			mutedSpy.mockClear();
			const second80 = widget!.render(80);
			assert.equal(mutedSpy.mock.calls.length, 0, "same rows, width, and spinner frame reuse cached lines");
			assert.equal(second80, first80);
			widget!.invalidate();
			const afterInvalidate80 = widget!.render(80);
			assert.ok(mutedSpy.mock.calls.length > 0, "invalidate forces a fresh render");
			assert.notEqual(afterInvalidate80, first80);
			assert.deepEqual(afterInvalidate80, first80);
			mutedSpy.mockClear();
			const first120 = widget!.render(120);
			assert.ok(mutedSpy.mock.calls.length > 0, "width change re-renders lines");
			assert.notDeepEqual(first120, first80);
		} finally {
			mutedSpy.mockRestore();
		}
		assert.equal(reads, 0, "unfocused render uses cached rows across frames and resizes");

		setAgentPanelVisible(session, false);
		assert.equal(reads, 0, "hiding the panel reuses cached source items");
		for (const listener of listeners) listener();
		await vi.waitFor(() =>
			assert.equal(reads, 1, "notifications while hidden sample updated sources at publish time"),
		);
		assert.equal(widget, undefined);

		setAgentPanelVisible(session, true);
		assert.equal(reads, 1, "restoring visibility reuses the sampled source cache");
		assert.notEqual(widget, undefined);
	} finally {
		dispose();
		nowSpy.mockRestore();
	}
});

test("unfocused panel enforces a refresh budget across separate-turn notification bursts (#5224, #5239)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	let now = 1_000;
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
	const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
	const hub = new AgentPanelSourceHub();
	const listeners = new Set<() => void>();
	let reads = 0;
	hub.register({
		items: () => {
			reads++;
			now += 2;
			return [{ ...healthyRow, task: `stage ${reads}` }];
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const dispose = bindAgentPanel(session, {
		setWidget() {},
		requestRender() {},
	} as never);
	try {
		assert.equal(reads, 1, "initial bind refreshes once");
		for (let turn = 0; turn < 4; turn++) {
			for (const listener of listeners) listener();
			await Promise.resolve();
		}
		assert.equal(reads, 5, "first four separate-turn refreshes run within the burst allowance");
		for (const listener of listeners) listener();
		await Promise.resolve();
		assert.equal(reads, 5, "fifth separate-turn notification is deferred once the 8ms/50ms refresh budget is spent");
		now += 50;
		vi.advanceTimersByTime(50);
		assert.equal(reads, 6, "deferred refresh runs once the 50ms budget window resets");
	} finally {
		dispose();
		perfSpy.mockRestore();
		dateSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("a source that notifies its listener inside items() quiesces without starving timers in unfocused and focused panels (#5224, #5239)", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	try {
		for (const policy of ["always", "onChange"] as const) {
			let reads = 0;
			let step = 0;
			let lastTask = "";
			let macrotaskRan = false;
			const listeners = new Set<() => void>();
			const hub = new AgentPanelSourceHub();
			hub.register({
				items: () => {
					reads++;
					const task = policy === "onChange" ? `stage ${step}` : "stage build";
					if (!macrotaskRan && reads <= 50 && (policy === "always" || task !== lastTask)) {
						lastTask = task;
						for (const listener of listeners) listener();
					}
					return [{ ...healthyRow, task }];
				},
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			});
			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			const dispose = bindAgentPanel(session, {
				setWidget() {},
				requestRender() {},
			} as never);
			try {
				await new Promise<void>((resolve) =>
					setTimeout(() => {
						macrotaskRan = true;
						resolve();
					}, 0),
				);
				assert.ok(
					reads <= 2,
					`unfocused bind (${policy}) must quiesce instead of spinning microtasks (got ${reads})`,
				);

				reads = 0;
				step++;
				macrotaskRan = false;
				const afterNotify = new Promise<void>((resolve) =>
					setTimeout(() => {
						macrotaskRan = true;
						resolve();
					}, 0),
				);
				for (const listener of listeners) listener();
				await afterNotify;
				assert.ok(reads <= 2, `unfocused notify (${policy}) must quiesce before setTimeout(0) (got ${reads})`);
			} finally {
				dispose();
			}

			reads = 0;
			step++;
			lastTask = "";
			macrotaskRan = false;
			const ui = createPanelUi({
				async onMount(_component, done) {
					await new Promise<void>((resolve) =>
						setTimeout(() => {
							macrotaskRan = true;
							resolve();
						}, 0),
					);
					assert.ok(reads <= 2, `focused mount (${policy}) must quiesce before setTimeout(0) (got ${reads})`);

					reads = 0;
					step++;
					macrotaskRan = false;
					const afterTick = new Promise<void>((resolve) =>
						setTimeout(() => {
							macrotaskRan = true;
							resolve();
						}, 0),
					);
					vi.advanceTimersByTime(1_000);
					await afterTick;
					assert.ok(reads <= 2, `focused 1s tick (${policy}) must quiesce before setTimeout(0) (got ${reads})`);
					done();
				},
			});
			await showAgentPanel(session, ui);
		}
	} finally {
		vi.useRealTimers();
	}
});

test("resetExtensionUI while the focused panel is open releases the single-flight guard, restores the unfocused widget, and allows reopening (#5224, #5239)", async () => {
	const hub1 = new AgentPanelSourceHub();
	hub1.register({
		items: () => [{ ...healthyRow, id: "run:one", name: "first-wf" }],
		subscribe: () => () => {},
	});
	let runner = { getAgentPanelSourceHub: () => hub1 };
	const session = {
		get extensionRunner() {
			return runner;
		},
	};
	const widgets = new Map<string, object>();
	const releaseCallbacks: Array<() => void> = [];
	const dispose = bindAgentPanel(session, {
		setWidget(key: string, factory: object | undefined) {
			if (factory === undefined) widgets.delete(key);
			else widgets.set(key, factory);
		},
		requestRender() {},
		onWidgetRelease(_key: string, callback: () => void) {
			releaseCallbacks.push(callback);
			return () => {};
		},
	} as never);
	try {
		assert.equal(widgets.size, 1);
		const mode = Object.create(InteractiveModeBase.prototype) as InteractiveModeBase;
		Object.assign(mode, {
			runtimeHost: { session },
			extensionDialogs: [],
			extensionOverlays: new Set(),
			editor: { getText: () => "", getExpandedText: () => "", setText() {} },
			editorContainer: { children: [], clear() {}, addChild() {} },
			ui: { hasOverlay: () => false, requestRender() {}, setFocus() {} },
			programStatus: { setBlocked() {} },
			keybindings: new KeybindingsManager(),
			beginHostInlineCustomUi: () => () => {},
			shouldDeferInlineCustomUiFocus: () => false,
			notifyHostCustomUiStateListeners() {},
			clearExtensionTerminalInputListeners() {},
			setExtensionFooter() {},
			setExtensionHeader() {},
			clearExtensionWidgets() {
				widgets.clear();
				for (const callback of releaseCallbacks) callback();
			},
			footerDataProvider: { clearExtensionStatuses() {} },
			footer: { invalidate() {} },
			setCustomEditorComponent() {},
			setupAutocompleteProvider() {},
			defaultEditor: {},
			updateTerminalTitle() {},
			setWorkingIndicator() {},
			setHiddenThinkingLabel() {},
		});
		let factories = 0;
		const panelUi: TaskInspectorUi = {
			custom: ((factory: Parameters<typeof mode.showExtensionCustom>[0], options: object) => {
				factories++;
				return mode.showExtensionCustom(factory, options);
			}) as never,
			getChatRenderSettings: () => ({}) as never,
			getFooterDataProvider: () => ({}) as never,
			getToolsExpanded: () => false,
			setToolsExpanded() {},
		};

		let firstSettled = false;
		const firstOpen = showAgentPanel(session, panelUi).then(() => {
			firstSettled = true;
		});
		await Promise.resolve();
		assert.equal(factories, 1);
		assert.equal(mode.extensionDialogs.length, 1);
		assert.equal(widgets.size, 0, "unfocused widget is hidden while focused panel is open");

		mode.resetExtensionUI();
		const hub2 = new AgentPanelSourceHub();
		hub2.register({
			items: () => [{ ...healthyRow, id: "run:two", name: "reloaded-wf" }],
			subscribe: () => () => {},
		});
		runner = { getAgentPanelSourceHub: () => hub2 };
		hub1.dispose();
		await Promise.race([firstOpen, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
		assert.equal(firstSettled, true, "disposing the focused dialog without done() settles showAgentPanel");
		assert.equal(widgets.size, 1, "unfocused widget remounts after resetExtensionUI");

		let secondSettled = false;
		const secondOpen = showAgentPanel(session, panelUi).then(() => {
			secondSettled = true;
		});
		await Promise.resolve();
		assert.equal(factories, 2, "down-arrow reopens the focused panel after reload");
		assert.equal(mode.extensionDialogs.length, 1);
		mode.resetExtensionUI();
		await Promise.race([secondOpen, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
		assert.equal(secondSettled, true);
	} finally {
		dispose();
	}
});

test("extension row onReturn catches and reports a rejecting back() navigation (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	let onReturnCallback: (() => void) | undefined;
	let brokenOnReturn = false;
	hub.register({
		items: () => [healthyRow],
		subscribe: () => () => {},
		open: (_id, options) => {
			onReturnCallback = options?.onReturn;
		},
	});
	const session = {
		extensionRunner: { getAgentPanelSourceHub: () => hub },
	};
	const warnings: string[] = [];
	const unhandled: Error[] = [];
	const onUnhandled = (reason: Error) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const ui = createPanelUi({
			notify: (message) => warnings.push(message),
			onMount(component) {
				if (brokenOnReturn) throw Object.create(null);
				component.handleInput("\r");
			},
		});
		await showAgentPanel(session, ui);
		assert.ok(onReturnCallback);
		brokenOnReturn = true;
		onReturnCallback!();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(unhandled.length, 0);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /^Agent panel: a source failed:/);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("showAgentPanel enforces single-flight per session and restores unfocused visibility on rejection (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	const listeners = new Set<() => void>();
	hub.register({
		items: () => [healthyRow],
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	const session = {
		extensionRunner: { getAgentPanelSourceHub: () => hub },
	};
	let widget: object | undefined;
	const warnings: string[] = [];
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: object | undefined) {
			widget = content;
		},
		requestRender() {},
		notify: (message: string) => warnings.push(message),
	} as never);
	try {
		assert.notEqual(widget, undefined);
		const finishCallbacks: Array<() => void> = [];
		const ui = createPanelUi({
			notify: (message) => warnings.push(message),
			onMount(_component, done) {
				finishCallbacks.push(done);
			},
		});
		const first = showAgentPanel(session, ui);
		const second = showAgentPanel(session, ui);
		await second;
		assert.equal(ui.mounts, 1, "second concurrent showAgentPanel returns early without mounting");
		for (const finish of finishCallbacks) finish();
		await first;
		assert.notEqual(widget, undefined, "unfocused widget visibility is restored when focused panel closes");

		const failingUi = createPanelUi({
			notify: (message) => warnings.push(message),
			onMount() {
				throw Object.create(null);
			},
		});
		await assert.rejects(showAgentPanel(session, failingUi));
		assert.notEqual(widget, undefined, "unfocused widget visibility is restored even when custom UI rejects");
	} finally {
		dispose();
	}
});

test("showAgentPanel restores unfocused widget visibility when hiding the unfocused widget throws (#5224, #5239)", async () => {
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [healthyRow],
		subscribe: () => () => {},
	});
	const session = {
		extensionRunner: { getAgentPanelSourceHub: () => hub },
	};
	let widget: object | undefined;
	let failTeardown = true;
	let mountedFocused = false;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: object | undefined) {
			widget = content;
			if (content === undefined && failTeardown) throw Object.create(null);
		},
		requestRender() {},
		notify() {},
	} as never);
	try {
		assert.notEqual(widget, undefined);
		const ui = createPanelUi({
			onMount(_component, done) {
				mountedFocused = true;
				failTeardown = false;
				done();
			},
		});
		await showAgentPanel(session, ui);
		assert.equal(mountedFocused, true);
		assert.notEqual(widget, undefined, "unfocused widget is remounted after focused navigation finishes");
	} finally {
		failTeardown = false;
		dispose();
	}
});

test("in-process and RPC open_agent_panel catch handlers format null and hostile non-Error rejections into non-empty messages (#5224, #5239)", async () => {
	const unhandled: Error[] = [];
	const onUnhandled = (reason: Error) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const hostileRejections: Array<null | Error | object> = [
			null,
			Object.defineProperty(new Error("boom"), "message", {
				get() {
					throw new Error("message getter exploded");
				},
			}),
			Object.create(null) as object,
		];
		for (const hostile of hostileRejections) {
			const notifications: Array<{ message: string; type?: string }> = [];
			const hub = new AgentPanelSourceHub();
			hub.register({ items: () => [healthyRow], subscribe: () => () => {} });
			let customCalls = 0;
			let hostCalls = 0;
			const brokenSession = {
				getAgentTaskHost() {
					hostCalls++;
					throw hostile;
				},
				extensionRunner: {
					getUIContext: () => ({
						notify: (message: string, type?: string) => notifications.push({ message, type }),
					}),
					getAgentPanelSourceHub: () => hub,
				},
			};
			const handler = createRpcCommandHandler({
				runtimeHost: {} as never,
				getSession: () => brokenSession as never,
				rebindSession: async () => {},
				output() {},
				keybindings: new KeybindingsManager(),
				taskInspectorUi: {
					custom() {
						customCalls++;
						throw hostile;
					},
				} as never,
			});
			await handler({ id: "1", type: "open_agent_panel" });
			await handler({ id: "2", type: "open_task_inspector" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(customCalls, 1);
			assert.equal(hostCalls, 1);
			assert.equal(unhandled.length, 0);
			assert.equal(notifications.length, 2);
			for (const entry of notifications) {
				assert.equal(entry.type, "error");
				assert.equal(typeof entry.message, "string");
				assert.ok(entry.message.length > 0);
			}

			const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
			const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
			const warnings: string[] = [];
			const editor = { getText: () => "", onAction() {} };
			const fakeMode = Object.create(InteractiveModeBase.prototype) as InteractiveModeBase;
			fakeMode.addTuiInputListener = (listener) => {
				inputListeners.push(listener);
				return () => {};
			};
			fakeMode.footerDataProvider = { setExtensionStatus() {} } as never;
			fakeMode.ui = {
				hasOverlay: () => false,
				requestRender() {},
			} as never;
			fakeMode.keybindings = new KeybindingsManager();
			fakeMode.editor = editor as never;
			fakeMode.editorContainer = { children: [editor] } as never;
			fakeMode.isBashMode = false;
			fakeMode.defaultEditor = editor as never;
			Object.defineProperty(fakeMode, "session", { value: session });
			fakeMode.createExtensionUIContext = () => ({}) as never;
			fakeMode.showExtensionCustom = async () => {
				throw hostile;
			};
			fakeMode.showWarning = (message: string) => warnings.push(message);
			fakeMode.runtimeHost = {} as never;
			await fakeMode.setupKeyHandlers();

			for (const listener of inputListeners) listener("\x1b[B");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(unhandled.length, 0);
			assert.equal(warnings.length, 1);
			assert.equal(typeof warnings[0], "string");
			assert.ok(warnings[0]!.length > 0);

			const isolatedHost = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
			isolatedHost.openAgentPanel = async () => {
				throw hostile;
			};
			fakeMode.runtimeHost = isolatedHost as never;
			for (const listener of inputListeners) listener("\x1b[B");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(unhandled.length, 0);
			assert.equal(warnings.length, 2);
			assert.equal(typeof warnings[1], "string");
			assert.ok(warnings[1]!.length > 0);
		}
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("warnings emitted during deferred startup survive rebuildChatFromMessages in startupNoticesContainer (#5224, #5239)", () => {
	const chatContainer = new Container();
	const resourceDisclosureContainer = new Container();
	const startupNoticesContainer = new Container();
	chatContainer.addChild(resourceDisclosureContainer);
	chatContainer.addChild(startupNoticesContainer);

	const fakeMode = Object.create(InteractiveModeBase.prototype) as InteractiveModeBase;
	fakeMode.chatContainer = chatContainer;
	fakeMode.resourceDisclosureContainer = resourceDisclosureContainer;
	fakeMode.startupNoticesContainer = startupNoticesContainer;
	fakeMode.deferredStartupPending = true;
	fakeMode.ui = { requestRender() {} } as never;
	Object.defineProperty(fakeMode, "sessionManager", {
		value: {
			getEntries: () => [],
			getLeafId: () => undefined,
		},
	});
	// A redraw shows the untrusted-project warning when it applies; this session is trusted.
	Object.defineProperty(fakeMode, "settingsManager", { value: { isProjectTrusted: () => true } });
	fakeMode.renderSessionEntries = () => {};

	fakeMode.showExtensionNotify("Agent panel: a source failed: boom", "warning");
	fakeMode.rebuildChatFromMessages();

	const rendered = chatContainer.render(120).join("\n");
	assert.match(rendered, /Agent panel: a source failed: boom/);
});
