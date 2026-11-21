import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import {
	type AgentPanelItem,
	type AgentPanelOpenOptions,
	AgentPanelSourceHub,
	agentPanelExtensionItems,
	agentPanelItems,
	answerAgentPanelItem,
	openAgentPanelItem,
	stopAgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindAgentPanel, showAgentPanel } from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import {
	agentPanelBoardSource,
	showEngineTaskInspector,
	showTaskInspector,
} from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.ts";
import { taskFixture } from "../helpers/task-projection.js";

test("a source whose subscribe throws is not listed and is reported once as an extension error (#5224)", () => {
	const hub = new AgentPanelSourceHub();
	const errors: string[] = [];
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub: () => hub,
			emitError: (error: { error: string }) => {
				errors.push(error.error);
			},
		},
	};
	const item: AgentPanelItem = {
		id: "run:sub-throws",
		kind: "agent",
		state: "running",
		name: "deploy",
		task: "stage build",
	};
	const reg = hub.register({
		items: () => [item],
		subscribe: () => {
			throw new Error("subscribe failed\x1b[2J\x1b]2;title\x07\u202e");
		},
	});
	assert.deepEqual(agentPanelExtensionItems(session), []);
	assert.deepEqual(errors, ["subscribe failed"]);
	assert.deepEqual(agentPanelItems(session), []);
	assert.equal(errors.length, 1);
	reg.dispose();
	assert.deepEqual(agentPanelExtensionItems(session), []);
});

test("throwing source.open returns false, reports an extension error, and keeps /tasks open with a notice (#5224)", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const hub = new AgentPanelSourceHub();
	const errors: string[] = [];
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub: () => hub,
			emitError: (error: { error: string }) => {
				errors.push(error.error);
			},
		},
	};
	let shouldThrow = true;
	const liveItems: AgentPanelItem[] = [
		{
			id: "run: broken",
			kind: "agent",
			state: "done",
			name: "deploy\x1b[2J\u202e",
			task: "stage 1/1",
		},
	];
	hub.register({
		items: () => liveItems,
		subscribe: () => () => {},
		open: () => {
			if (shouldThrow) throw new Error("graph boom\x1b[2J\x1b]2;pwn\x07\u202e");
		},
		stop: async () => ({ ok: false, reason: "stop raw\x1b[2J\x1b]2;pwn\x07\u202e\nline2" }),
		answer: async () => ({ ok: false, reason: "answer raw\x1b[2J\x1b]2;pwn\x07\u202e\nline2" }),
	});
	const board = agentPanelBoardSource(session);
	let activeComponent: Component | undefined;
	const currentActiveComponent = (): Component | undefined => activeComponent;
	let inspectorClosed = 0;
	try {
		agentPanelExtensionItems(session);
		const stopped = await stopAgentPanelItem(session, "run: broken");
		assert.deepEqual(stopped, { ok: false, reason: "stop raw line2" });
		const answered = await answerAgentPanelItem(session, "run: broken", "ok");
		assert.deepEqual(answered, { ok: false, reason: "answer raw line2" });

		const shown = showTaskInspector(
			{
				custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> {
					return new Promise<T>((resolve) => {
						const done = (result: T) => {
							inspectorClosed++;
							resolve(result);
						};
						void Promise.resolve(
							factory(
								{
									terminal: { rows: 24, columns: 100 },
									requestRender() {},
								} as Parameters<typeof factory>[0],
								theme,
								keys,
								done as (result: unknown) => void,
							),
						).then((resolved) => {
							activeComponent = resolved;
						});
					});
				},
			},
			fixture.store,
			undefined,
			{ board },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const active = currentActiveComponent();
		assert.ok(active);
		active.handleInput?.("\r");
		assert.equal(inspectorClosed, 0);
		assert.deepEqual(errors, ["graph boom"]);
		const frame = active
			.render(100)
			.map((line: string) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(frame, /Could not open deploy/);

		shouldThrow = false;
		assert.equal(openAgentPanelItem(session, "run: broken"), true);
		liveItems.length = 0;
		agentPanelExtensionItems(session);

		active.handleInput?.("\x1b");
		await shown;
	} finally {
		setKeybindings(previousKeys);
		await fixture.dispose();
	}
});

test("bindAgentPanel rebinds to the new extension hub across a real session.reload() (#5224)", async () => {
	initTheme("dark");
	const listenersByGeneration: Array<Set<() => void>> = [];
	const itemsByGeneration: AgentPanelItem[][] = [];
	const makeExtension = (gen: number) => (pi: { registerAgentPanelSource: AgentPanelSourceHub["register"] }) => {
		const listeners = new Set<() => void>();
		const items: AgentPanelItem[] = [];
		listenersByGeneration[gen] = listeners;
		itemsByGeneration[gen] = items;
		pi.registerAgentPanelSource({
			items: () => items,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		});
	};
	const firstExtensions = await createTestExtensionsResult([makeExtension(0) as never]);
	const loader = createTestResourceLoader({ extensionsResult: firstExtensions });
	loader.prepareReload = async () => ({
		loader: createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult([makeExtension(1) as never]),
		}),
		activate() {},
		commit() {},
	});
	const harness = await createHarness({
		sessionManager: SessionManager.inMemory(),
		resourceLoader: loader,
	});
	let widget: Component | undefined;
	const currentWidget = (): Component | undefined => widget;
	const reloaded = Promise.withResolvers<Component>();
	const ui = {
		setWidget(_key, content) {
			widget =
				typeof content === "function"
					? content({} as Parameters<Exclude<typeof content, string[] | undefined>>[0], theme)
					: undefined;
			if (widget) reloaded.resolve(widget);
		},
		requestRender() {},
	} satisfies Pick<ExtensionUIContext, "setWidget" | "requestRender">;
	const disposePanel = bindAgentPanel(harness.session, ui);
	try {
		await harness.session.bindExtensions({});
		const firstHub = harness.session.extensionRunner.getAgentPanelSourceHub();
		await harness.session.reload();
		const secondHub = harness.session.extensionRunner.getAgentPanelSourceHub();
		assert.equal(firstHub === secondHub, false);
		assert.equal(currentWidget(), undefined);

		itemsByGeneration[1]!.push({
			id: "run:after-reload",
			kind: "agent",
			state: "running",
			name: "reloaded-wf",
			task: "stage verify",
		});
		for (const listener of listenersByGeneration[1] ?? []) listener();
		const mounted = await reloaded.promise;
		assert.equal(mounted, currentWidget(), "panel widget mounts when the reloaded hub source emits an item");
		const rendered = mounted
			.render(100)
			.map((line: string) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(rendered, /reloaded-wf/);
	} finally {
		disposePanel();
		await harness.session.dispose();
	}
});

test("showTaskInspector hides the agent panel in-process, across a task reopening, and reports reopen rejection (#5224)", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const hub = new AgentPanelSourceHub();
	let onReturnCallback: (() => void) | undefined;
	hub.register({
		items: () => [
			{
				id: "run:wf-1",
				kind: "agent",
				state: "running",
				name: "alpha",
				task: "stage build",
			},
		],
		subscribe: () => () => {},
		open: (_id: string, options?: AgentPanelOpenOptions) => {
			onReturnCallback = options?.onReturn;
			options?.onReturn?.();
		},
	});
	const session = {
		getAgentTaskHost() {},
		extensionRunner: { getAgentPanelSourceHub: () => hub },
	} as unknown as AgentSession;
	bindOwnerTaskStore(session, fixture.store);

	let widgetMounted = false;
	const widgetStates: boolean[] = [];
	const panelUi = {
		setWidget(_key: string, content: unknown) {
			widgetMounted = content !== undefined;
			widgetStates.push(widgetMounted);
		},
		requestRender() {},
	} satisfies Pick<ExtensionUIContext, "setWidget" | "requestRender">;
	const disposePanel = bindAgentPanel(session, panelUi);

	const mounts: Array<{
		component: Component;
		done: () => void;
		mountedWhilePanelVisible: boolean;
	}> = [];
	let rejectNextMount = false;
	const notices: Array<{ message: string; type?: string }> = [];
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);

	try {
		assert.equal(widgetMounted, true);
		const inspectorUi: Pick<ExtensionUIContext, "custom" | "notify"> = {
			custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> {
				if (rejectNextMount) {
					rejectNextMount = false;
					return Promise.reject(new Error("Host custom UI closed\x1b[2J\x1b]2;pwn\x07\u202e"));
				}
				return new Promise<T>((resolve) => {
					const done = () => resolve(undefined as T);
					// Mounted a microtask later, as the host mounts a view: whether the panel still shows then.
					void Promise.resolve(
						factory(
							{
								terminal: { rows: 24, columns: 100 },
								requestRender() {},
							} as Parameters<typeof factory>[0],
							theme,
							keys,
							done as (result: unknown) => void,
						),
					).then((component) => {
						mounts.push({ component, done, mountedWhilePanelVisible: widgetMounted });
					});
				});
			},
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notices.push({ message, type });
			},
		};

		const inProcess = showTaskInspector(inspectorUi, fixture.store, undefined, {
			board: agentPanelBoardSource(session),
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(mounts.length, 1);
		// Mounted while the panel shows: the panel hides only after that, so no frame shows neither.
		assert.equal(mounts[0]!.mountedWhilePanelVisible, true);
		assert.equal(widgetMounted, false);
		mounts[0]!.component.handleInput?.("\x1b");
		await inProcess;
		assert.equal(widgetMounted, true);

		const engineRun = showEngineTaskInspector(session, inspectorUi);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(mounts.length, 2);
		assert.equal(widgetMounted, false);
		mounts[1]!.component.handleInput?.("\r");
		await engineRun;
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(mounts.length, 3);
		// The first /tasks closed in the same step, showing the panel; the reopened one hides it once mounted.
		assert.equal(mounts[2]!.mountedWhilePanelVisible, true);
		assert.equal(widgetMounted, false, "panel stays hidden while reopened /tasks is mounted");

		mounts[2]!.component.handleInput?.("\x1b");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(widgetMounted, true, "panel remounts after reopened /tasks closes");

		rejectNextMount = true;
		onReturnCallback?.();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
		assert.deepEqual(notices, [{ message: "Host custom UI closed", type: "error" }]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		disposePanel();
		setKeybindings(previousKeys);
		await fixture.dispose();
	}
});

test("re-registering a source after subscribe threw clears the stored subscribe error (#5224)", () => {
	const hub = new AgentPanelSourceHub();
	const errors: string[] = [];
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub: () => hub,
			emitError: (error: { error: string }) => {
				errors.push(error.error);
			},
		},
	};
	let shouldThrow = true;
	const source = {
		items: (): readonly AgentPanelItem[] => [
			{ id: "run:recovered", kind: "agent", state: "running", name: "deploy", task: "stage verify" },
		],
		subscribe: () => {
			if (shouldThrow) throw new Error("transient subscribe failure");
			return () => {};
		},
	};
	const first = hub.register(source);
	first.dispose();
	shouldThrow = false;
	const second = hub.register(source);
	try {
		const subErrors: string[] = [];
		const unsub = hub.subscribe(
			() => {},
			(_src, err) => subErrors.push(err.message),
		);
		unsub();
		assert.deepEqual(subErrors, []);
		assert.deepEqual(
			agentPanelExtensionItems(session).map((entry) => entry.id),
			["run:recovered"],
		);
		assert.deepEqual(errors, []);
	} finally {
		second.dispose();
	}
});

test("closing /tasks or the focused agent panel shows the agent panel again in the step the view closes", async () => {
	initTheme("dark");
	const previousKeys = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [{ id: "run:wf-1", kind: "agent", state: "running", name: "alpha", task: "stage build" }],
		subscribe: () => () => {},
	});
	const session = {
		getAgentTaskHost() {},
		extensionRunner: { getAgentPanelSourceHub: () => hub },
	} as unknown as AgentSession;
	bindOwnerTaskStore(session, fixture.store);
	let widgetMounted = false;
	const disposePanel = bindAgentPanel(session, {
		setWidget(_key: string, content: unknown) {
			widgetMounted = content !== undefined;
		},
		requestRender() {},
	});
	/** Whether the panel was mounted at the moment each view closed: the frame after the close draws it. */
	const shownAtClose: boolean[] = [];
	const views: Component[] = [];
	const ui: Pick<ExtensionUIContext, "custom" | "notify"> = {
		custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> {
			return new Promise<T>((resolve) => {
				const done = () => {
					shownAtClose.push(widgetMounted);
					resolve(undefined as T);
				};
				void Promise.resolve(
					factory(
						{ terminal: { rows: 24, columns: 100 }, requestRender() {} } as Parameters<typeof factory>[0],
						theme,
						keys,
						done as (result: unknown) => void,
					),
				).then((component) => views.push(component));
			});
		},
		notify: () => {},
	};
	try {
		const tasks = showTaskInspector(ui, fixture.store, undefined, { board: agentPanelBoardSource(session) });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(widgetMounted, false, "/tasks hides the panel");
		views.at(-1)!.handleInput?.("\x1b");
		await tasks;
		assert.deepEqual(shownAtClose, [true]);

		const focused = showAgentPanel(session, ui);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(widgetMounted, false, "the focused panel hides the idle one");
		views.at(-1)!.handleInput?.("\x1b");
		await focused;
		assert.deepEqual(shownAtClose, [true, true]);
	} finally {
		disposePanel();
		setKeybindings(previousKeys);
		await fixture.dispose();
	}
});
