import assert from "node:assert/strict";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-editor-actions.js";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-custom-ui.js";
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
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.js";
import type { TaskInspectorUi } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

initTheme("dark");

const healthyRow: AgentPanelItem = {
	id: "run:healthy",
	kind: "workflow",
	state: "running",
	name: "ralph",
	task: "stage build",
	elapsedMs: 5_000,
};

function createPanelUi(
	options: {
		onMount?: (
			component: {
				render(width: number): string[];
				handleInput(data: string): boolean;
				dispose(): void;
			},
			done: () => void,
		) => void | Promise<void>;
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
				let component:
					| {
							render(width: number): string[];
							handleInput(data: string): boolean;
							dispose(): void;
					  }
					| undefined;
				const done = () => {
					component?.dispose();
					resolve();
				};
				try {
					component = factory(
						{ requestRender() {} } as never,
						theme,
						new KeybindingsManager(),
						done as never,
					) as never;
					Promise.resolve(options.onMount?.(component, done)).catch((error) => {
						component?.dispose();
						reject(error);
					});
				} catch (error) {
					component?.dispose();
					reject(error);
				}
			}) as never;
		},
	};
	return ui;
}

test("a source that reopens the panel while listing rows cannot mount a second panel (#5239)", async () => {
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

test("showAgentPanel stop chain normalizes non-string reasons, strips terminal controls, and catches rejections (#5239)", async () => {
	const reasons: unknown[] = [
		Symbol("stop-symbol"),
		Object.create(null),
		{
			toString() {
				throw new Error("reason toString exploded");
			},
		},
		"\x1b]0;pwned\x07blocked\nnext",
	];
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
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

test("unfocused and focused panel renders catch unexpected throws without per-frame projection, return empty lines, and report once (#5239)", async () => {
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
		setWidget(_key: string, content: unknown) {
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
		} as unknown as number;
		assert.deepEqual(widget!.render(throwingWidth), []);
		assert.deepEqual(widget!.render(throwingWidth), []);
		assert.equal(reads, 0, "render fault is caught without re-reading source items");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /Agent panel: a source failed and is hidden:/);

		const ui = createPanelUi({
			notify: (message) => warnings.push(message),
			onMount(component, done) {
				try {
					reads = 0;
					assert.deepEqual(component.render(throwingWidth), []);
					assert.deepEqual(component.render(throwingWidth), []);
					assert.equal(reads, 0, "focused render fault is caught without re-reading source items");
				} finally {
					done();
				}
			},
		});
		await showAgentPanel(session, ui);
		assert.equal(warnings.length, 1);
	} finally {
		dispose();
	}
});

test("update catch in bindAgentPanel remains total even when widget teardown throws (#5239)", async () => {
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
	let widget: unknown;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: unknown) {
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
		await Promise.resolve();
		assert.equal(widget, undefined);
		assert.equal(agentPanelHasRows(session), true);
		assert.equal(warnings.length, 1);
	} finally {
		dispose();
	}
});

test("focused panel coalesces notification bursts into one microtask and contains listener errors (#5239)", async () => {
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
				getAgentPanelSourceHub: () => {
					if (throwNullProto) throw Object.create(null);
					return hub;
				},
			},
		};
		bindOwnerTaskStore(session, fixture.store);
		const warnings: string[] = [];
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const ui = createPanelUi({
				notify: (message) => warnings.push(message),
				async onMount(component, done) {
					try {
						reads = 0;
						for (let i = 0; i < 1000; i++) {
							for (const listener of listeners) listener();
						}
						assert.equal(reads, 0, "burst notifications do not rebuild synchronously");
						await Promise.resolve();
						assert.equal(reads, 1, "coalesced into one refresh");
						component.render(80);
						component.render(100);
						assert.equal(reads, 1, "focused render uses cached rows between notifications");

						throwNullProto = true;
						for (const listener of listeners) listener();
						await Promise.resolve();
						assert.equal(unhandled.length, 0);
						assert.equal(warnings.length, 1);
					} finally {
						done();
					}
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

test("unfocused panel skips row recomputation while hidden and renders from cached rows between changes (#5239)", async () => {
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
	let widget: { render(width: number): string[] } | undefined;
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: unknown) {
			widget = typeof content === "function" ? (content({} as never, {} as never) as never) : undefined;
		},
		requestRender() {},
	} as never);
	try {
		assert.ok(widget);
		reads = 0;
		widget!.render(80);
		widget!.render(120);
		assert.equal(reads, 0, "unfocused render uses cached rows across frames and resizes");

		setAgentPanelVisible(session, false);
		assert.equal(reads, 0, "hiding the panel does not rescan sources");
		for (const listener of listeners) listener();
		await Promise.resolve();
		assert.equal(reads, 0, "updates while hidden do not rescan sources");

		setAgentPanelVisible(session, true);
		assert.equal(reads, 1, "restoring visibility refreshes once");
	} finally {
		dispose();
	}
});

test("workflow onReturn catches and reports a rejecting back() navigation (#5239)", async () => {
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
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
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
		assert.match(warnings[0]!, /Agent panel: a source failed and is hidden:/);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("showAgentPanel enforces single-flight per session and restores unfocused visibility after a refresh throw (#5239)", async () => {
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
	let widget: unknown;
	const warnings: string[] = [];
	const dispose = bindAgentPanel(session, {
		setWidget(_key: string, content: unknown) {
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

test("in-process and RPC open_agent_panel catch handlers format non-Error rejections safely (#5239)", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const notifications: Array<{ message: string; type?: string }> = [];
		const hub = new AgentPanelSourceHub();
		hub.register({ items: () => [healthyRow], subscribe: () => () => {} });
		const brokenSession = {
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
				open() {
					throw Object.create(null);
				},
			} as never,
		});
		await handler({ id: "1", type: "open_agent_panel" });
		await handler({ id: "2", type: "open_task_inspector" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(unhandled.length, 0);
		assert.equal(notifications.length, 2);
		assert.equal(notifications[0]?.type, "error");
		assert.equal(notifications[1]?.type, "error");

		const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
		const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
		const warnings: string[] = [];
		const editor = { getText: () => "" };
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
		fakeMode.defaultEditor = {
			onAction() {},
		} as never;
		Object.defineProperty(fakeMode, "session", { value: session });
		fakeMode.createExtensionUIContext = () => ({}) as never;
		fakeMode.showExtensionCustom = async () => {
			throw Object.create(null);
		};
		fakeMode.showWarning = (message: string) => warnings.push(message);
		fakeMode.runtimeHost = {} as never;
		await fakeMode.setupKeyHandlers();

		for (const listener of inputListeners) listener("\x1b[B");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(unhandled.length, 0);
		assert.equal(warnings.length, 1);

		const isolatedHost = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
		isolatedHost.openAgentPanel = async () => {
			throw Object.create(null);
		};
		fakeMode.runtimeHost = isolatedHost as never;
		for (const listener of inputListeners) listener("\x1b[B");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(unhandled.length, 0);
		assert.equal(warnings.length, 2);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("warnings emitted during deferred startup survive rebuildChatFromMessages in startupNoticesContainer (#5239)", () => {
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
	fakeMode.renderSessionEntries = () => {};

	fakeMode.showExtensionNotify("Agent panel: a source failed and is hidden: boom", "warning");
	fakeMode.rebuildChatFromMessages();

	const rendered = chatContainer.render(120).join("\n");
	assert.match(rendered, /Agent panel: a source failed and is hidden: boom/);
});
