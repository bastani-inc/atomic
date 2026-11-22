import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, Container, getKeybindings, setKeybindings, Text } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { dismissedAgentPanelItems } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { OperationId, TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { agentViewBridge } from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-view-bridge.js";
import type { AgentViewSwitcher } from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-view-switcher.js";
import type { AgentViewPort } from "../../packages/coding-agent/src/modes/interactive/agent-view/contracts.js";
import { installAgentView } from "../../packages/coding-agent/src/modes/interactive/agent-view/install.js";
import { markNavigationView } from "../../packages/coding-agent/src/modes/interactive/components/prompt-slot.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
	type RemoteComponentUI,
	type TuiRendererLifecycle,
	watchWidgetFrames,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.js";
import {
	AGENT_PANEL_WIDGET_KEY,
	bindAgentPanel,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import {
	handleSetViewedAgent,
	installEngineAgentViewBridge,
} from "../../packages/coding-agent/src/modes/rpc/agent-view-rpc-panel.js";
import type { AgentViewRpcCommandBody } from "../../packages/coding-agent/src/modes/rpc/agent-view-rpc-types.js";
import {
	agentPanelBoardSource,
	showTaskInspector,
	type TaskInspectorUi,
} from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { FakeOwnerTaskStore } from "../helpers/fake-owner-task-store.js";
import { taskRecord } from "../helpers/task-record.js";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

const plain = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());
const selectedLine = (lines: readonly string[]) => plain(lines).find((line) => /^\s*(?:❯|∀)\s/.test(line)) ?? "";
const tick = async (turns = 4) => {
	for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function doneAgent(id: string, title: string, ordinal: number, opId = `op-${id}`): TaskRecord {
	const base = taskRecord(id);
	return {
		...base,
		agentName: "worker",
		title,
		launchOrdinal: ordinal,
		wasBackground: true,
		launchOperationId: opId as OperationId,
		observation: { kind: "none", reason: "task-settled" },
		execution: { kind: "settled", result: { kind: "completed", output: base.output } },
	};
}

function fakePort(taskId: string, agentKey = `agent:${taskId}`): AgentViewPort & { disposed: boolean } {
	let retained = 0;
	const listeners = new Set<() => void>();
	const status = {
		taskId: taskId as TaskId,
		agentKey,
		name: "worker",
		title: taskId,
		busy: false,
		gone: false,
		heldPrompt: false,
		placeholder: `Message @worker…`,
		ruleLabel: `worker · ${taskId}`,
	};
	const port = {
		agentKey,
		disposed: false,
		transcript: {
			render: () => [`transcript:${taskId}`],
			renderSized: () => [`transcript:${taskId}`],
			handleViewKey: () => true,
			capturesInput: () => false,
			handleInput: () => {},
			invalidate: () => {},
		},
		steering: {} as never,
		status: () => status,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		pause: async () => ({ ok: true as const, value: { steering: [], followUp: [] } }),
		prompts: async () => [],
		commands: async () => undefined,
		lastAgentMessageText: async () => undefined,
		retain: () => {
			retained++;
			let done = false;
			return () => {
				if (done) return;
				done = true;
				if (--retained === 0) port.disposed = true;
			};
		},
	};
	return port as unknown as AgentViewPort & { disposed: boolean };
}

function mountTasksUi(
	drive: (
		component: { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void },
		rows: () => string[],
	) => Promise<void> | void,
): TaskInspectorUi {
	return {
		notify() {},
		async custom<T>(factory: Parameters<TaskInspectorUi["custom"]>[0]): Promise<T> {
			let finish!: (value: T) => void;
			const done = new Promise<T>((resolve) => {
				finish = resolve;
			});
			const component = await factory(
				{ requestRender() {}, terminal: { rows: 24, columns: 100 } } as never,
				theme,
				getKeybindings() as KeybindingsManager,
				finish as (result: unknown) => void,
			);
			const rows = () => plain(component.render(100));
			await drive(component as never, rows);
			const result = await done;
			(component as { dispose?(): void }).dispose?.();
			return result;
		},
	};
}

// Re-export helper that seeds agentViewSwitcher BEFORE installAgentView!
import { agentViewSwitcher } from "../../packages/coding-agent/src/modes/interactive/agent-view/install.js";

function createHarnessWithOpenPort(
	tasks: TaskRecord[],
	openPort: (
		taskId: TaskId,
		requestOptions?: { keepScreen?: boolean; panel?: boolean },
	) => Promise<AgentViewPort | undefined>,
	options: { engineVersion?: "new" | "old" } = {},
) {
	const store = new FakeOwnerTaskStore(tasks);
	const session = { extensionRunner: {} } as unknown as AgentSession;
	bindOwnerTaskStore(session, store);

	const engineToHostQueue: string[] = [];
	const hostToEngineSetViewed: Array<{ command: AgentViewRpcCommandBody; resolve: () => void }> = [];
	const hostToEngineCommands: string[] = [];

	const engineCustomUi = new EngineCustomUiService((line) => {
		engineToHostQueue.push(line);
	}, new KeybindingsManager());

	const engineContext = {
		session,
		send(message: InteractiveEngineMessage) {
			let wire = serializeInteractiveEngineMessage(message);
			if (options.engineVersion === "old" && message.type === "engine_view_agent") {
				const raw = JSON.parse(wire) as Record<string, unknown>;
				delete raw.requestId;
				wire = JSON.stringify(raw);
			}
			if (options.engineVersion === "old" && message.type === "engine_custom_frame") {
				const raw = JSON.parse(wire) as Record<string, unknown>;
				delete raw.previewSeq;
				wire = JSON.stringify(raw);
			}
			engineToHostQueue.push(wire);
		},
		customUi: engineCustomUi,
		ui: {
			setWidget: (key: string, factory: unknown, opts?: unknown) =>
				engineCustomUi.setWidget(key, factory as never, opts as never),
			requestRender: () => {},
		} as never,
	};

	const detachBridge = installEngineAgentViewBridge(engineContext);
	const unbindPanel = bindAgentPanel(session, engineContext.ui, undefined, {
		custom: () => Promise.resolve(undefined),
	} as never);

	const engineListeners = new Set<(message: InteractiveEngineMessage) => void>();
	const endedListeners = new Set<(event: { expected: boolean; generation: number }) => void>();
	let generation = 1;

	const runtime = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype), {
		onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			engineListeners.add(listener);
			return () => engineListeners.delete(listener);
		},
		onGenerationEnded(listener: (event: { expected: boolean; generation: number }) => void) {
			endedListeners.add(listener);
			return () => endedListeners.delete(listener);
		},
		sendEngineCommand(command: InteractiveEngineCommand) {
			hostToEngineCommands.push(JSON.stringify(command));
		},
		requestAgentView(command: AgentViewRpcCommandBody) {
			return new Promise<void>((resolve) => {
				hostToEngineSetViewed.push({ command, resolve });
			});
		},
		getGeneration: () => generation,
	}) as IsolatedInteractiveRuntime & RemoteComponentRuntime;

	const widgets = new Map<string, Component>();
	const widgetReleaseListeners = new Map<string, Set<() => void>>();
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	const editor = Object.assign(new Text("❯ prompt", 0, 0), {
		setPlaceholder() {},
		setTopRuleLabel() {},
		getExpandedText: () => "",
		getText: () => "",
		setText() {},
		actionHandlers: new Map(),
	});
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	let hasOverlay = false;

	const ui: RemoteComponentUI = {
		requestRender() {},
		setWidget(key, factory) {
			if (typeof factory === "function") {
				widgets.set(
					key,
					(factory as (tui: { terminal: { rows: number; columns: number } }) => Component)({
						terminal: { rows: 24, columns: 100 },
					}),
				);
			} else {
				widgets.delete(key);
				for (const listener of widgetReleaseListeners.get(key) ?? []) listener();
			}
		},
		onWidgetRelease(key, listener) {
			let set = widgetReleaseListeners.get(key);
			if (set === undefined) {
				set = new Set();
				widgetReleaseListeners.set(key, set);
			}
			set.add(listener);
			return () => set.delete(listener);
		},
		custom: () => new Promise(() => {}),
	};

	const lifecycle: TuiRendererLifecycle = {
		isFullscreen: () => true,
		onRendererReplaced: () => () => {},
	};
	const controller = new RemoteComponentController(runtime, ui, lifecycle);

	const mode = {
		runtimeHost: runtime,
		session,
		ui: {
			terminal: { rows: 24, columns: 100 },
			requestRender() {},
			hasOverlay: () => hasOverlay,
			getFocusedComponent: () => editorContainer.children.at(-1) ?? editor,
			setFocus() {},
			children: [],
		},
		editor,
		defaultEditor: editor,
		editorContainer,
		documentContainer: new Container(),
		chatContainer: new Container(),
		statusContainer: new Text("", 0, 0),
		footer: { setViewedWork() {} },
		sessionManager: { getSessionName: () => undefined },
		keybindings: getKeybindings(),
		showWarning() {},
		showStatus() {},
		showError() {},
		jumpToTranscriptEnd() {},
		updatePendingMessagesDisplay() {},
		addTuiInputListener: (listener: (data: string) => { consume?: boolean } | undefined) => {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
		onTuiRendererChange: () => () => {},
		disposeAgentView: undefined as (() => void) | undefined,
		agentView: undefined as AgentViewSwitcher | undefined,
	};

	// Seed custom openPort BEFORE installAgentView installs isolated runtime listeners!
	agentViewSwitcher(mode as never, openPort);
	const switcher = installAgentView(mode as never);

	const deliverAllEngineToHost = (): InteractiveEngineMessage[] => {
		const out: InteractiveEngineMessage[] = [];
		while (engineToHostQueue.length > 0) {
			const raw = engineToHostQueue.shift()!;
			const parsed = parseInteractiveEngineMessage(raw);
			if (parsed === undefined) continue;
			for (const listener of [...engineListeners]) listener(parsed);
			out.push(parsed);
		}
		return out;
	};

	const deliverAllSetViewedToEngine = async (): Promise<AgentViewRpcCommandBody[]> => {
		const out: AgentViewRpcCommandBody[] = [];
		while (hostToEngineSetViewed.length > 0) {
			const next = hostToEngineSetViewed.shift()!;
			let cmd = next.command;
			if (options.engineVersion === "old" && cmd.type === "set_viewed_agent") {
				cmd = { type: "set_viewed_agent", ...(cmd.taskId === undefined ? {} : { taskId: cmd.taskId }) };
			}
			if (cmd.type === "set_viewed_agent") {
				await handleSetViewedAgent(cmd, engineContext);
			}
			next.resolve();
			out.push(next.command);
		}
		return out;
	};

	const deliverAllHostCommandsToEngine = async (): Promise<void> => {
		while (hostToEngineCommands.length > 0) {
			const line = hostToEngineCommands.shift()!;
			engineCustomUi.handleLine(line);
		}
		await tick(4);
	};

	const renderHostPanel = (): string[] => {
		const widget = widgets.get(AGENT_PANEL_WIDGET_KEY);
		if (widget === undefined) return [];
		return plain(widget.render(100));
	};

	const sendHostKey = (data: string): boolean => {
		for (const listener of [...inputListeners]) {
			if (listener(data)?.consume === true) return true;
		}
		return false;
	};

	const emitGenerationEnded = () => {
		generation++;
		for (const listener of [...endedListeners]) listener({ expected: false, generation });
	};

	return {
		store,
		session,
		runtime,
		controller,
		mode,
		switcher,
		engineContext,
		engineCustomUi,
		widgets,
		editor,
		editorContainer,
		setHasOverlay: (value: boolean) => {
			hasOverlay = value;
		},
		engineToHostQueue,
		hostToEngineSetViewed,
		hostToEngineCommands,
		deliverAllEngineToHost,
		deliverAllSetViewedToEngine,
		deliverAllHostCommandsToEngine,
		renderHostPanel,
		sendHostKey,
		emitGenerationEnded,
		dispose() {
			mode.disposeAgentView?.();
			controller.dispose();
			unbindPanel();
			detachBridge();
		},
	};
}

beforeAll(() => initTheme("dark"));
let previousKeys: ReturnType<typeof getKeybindings>;
const disposers: Array<() => void> = [];

beforeEach(() => {
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	while (disposers.length > 0) disposers.pop()?.();
	setKeybindings(previousKeys);
});

test("isolated panelOnView speculative preview + Esc + failed open resets next /tasks to top (never lands on failed target)", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const a3 = doneAgent("a3", "third gamma", 3);
	let releaseOpen!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort(
		[a1, a2, a3],
		() =>
			new Promise((resolve) => {
				releaseOpen = resolve;
			}),
	);
	disposers.push(() => h.dispose());

	// Open /tasks (hides empty idle panel), select middle finished subagent a2, press Enter -> sends engine_view_agent with panelOnView: true.
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);

	// User re-opens /tasks and presses Esc before the host finishes opening.
	await showTaskInspector(
		mountTasksUi((c) => {
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);

	// Host receives engine_view_agent(a2, panelOnView: true), sends speculative preview to engine.
	const sentToHost = h.deliverAllEngineToHost();
	assert.ok(
		sentToHost.some((m) => m.type === "engine_view_agent" && m.taskId === "a2" && m.panelOnView === true),
		"panelOnView request sent for finished subagent when idle panel is empty",
	);
	await h.deliverAllSetViewedToEngine();

	// Engine committed viewedTaskId() MUST remain undefined during speculative preview!
	assert.equal(
		agentViewBridge(h.session)?.viewedTaskId(),
		undefined,
		"speculative preview must not mutate committed viewedTaskId",
	);

	// Host openPort("a2") FAILS -> sends committed correction (main) to engine.
	releaseOpen(undefined);
	await tick(4);
	await h.deliverAllSetViewedToEngine();

	// Next /tasks on main MUST start at top (a3 = third gamma), NOT failed a2 (second beta)!
	let nextSelection = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			nextSelection = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	assert.match(nextSelection, /third gamma/, `expected top row after Esc+fail, got: ${nextSelection}`);
});

test("host Esc while panelOnView open is in flight never paints speculative preview (including render overtake) and resets next /tasks to top", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const a3 = doneAgent("a3", "third gamma", 3);
	let releaseOpen!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort(
		[a1, a2, a3],
		() =>
			new Promise((resolve) => {
				releaseOpen = resolve;
			}),
	);
	disposers.push(() => h.dispose());

	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);

	// Host receives engine_view_agent(a2, panelOnView: true) and sends preview to engine.
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	// Engine opens panel widget for speculative preview; host renders unseen & engine produces preview frame.
	h.deliverAllEngineToHost();
	assert.deepEqual(h.renderHostPanel(), [], "speculative preview must never paint live before open commits");
	await h.deliverAllHostCommandsToEngine();
	h.deliverAllEngineToHost();
	// Even AFTER the engine's preview frame arrived on host, live render MUST NOT paint it before commit!
	assert.deepEqual(h.renderHostPanel(), [], "buffered speculative preview frame must stay hidden before commit");

	// User presses Esc on host while openPort("a2") is still in flight!
	assert.equal(h.sendHostKey(ESC), true, "Esc cancels pending open");
	assert.equal(h.switcher.pendingTaskId, undefined);
	assert.deepEqual(h.renderHostPanel(), [], "live panel stays empty right after Esc");

	// Simulate rpc-input.ts overtake: engine processes engine_custom_render BEFORE processing the queued set_viewed_agent correction!
	assert.ok(h.hostToEngineSetViewed.length >= 1, "correction set_viewed_agent is queued");
	await h.deliverAllHostCommandsToEngine();
	h.deliverAllEngineToHost();
	assert.deepEqual(
		h.renderHostPanel(),
		[],
		"stale speculative preview frame rendered before correction set_viewed_agent MUST be dropped and never paint!",
	);

	// Now deliver correction set_viewed_agent to engine, and let late openPort resolve with a port (must be disposed unused!).
	await h.deliverAllSetViewedToEngine();
	const latePort = fakePort("a2");
	releaseOpen(latePort);
	await tick(4);
	assert.equal(latePort.disposed, true, "late port from cancelled open must be disposed unused");
	assert.equal(h.switcher.viewed.kind, "main");

	// Next /tasks must land at top (third gamma).
	let nextSelection = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			nextSelection = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	assert.match(nextSelection, /third gamma/, `expected top row after host Esc cancel, got: ${nextSelection}`);
});

test("Esc pressed in the closing-/tasks window (after engine_view_agent arrived, before engine_custom_done restores editor) still cancels pending open without stealing Esc from inline dialogs", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	let releaseOpen!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort(
		[a1, a2],
		() =>
			new Promise((resolve) => {
				releaseOpen = resolve;
			}),
	);
	disposers.push(() => h.dispose());

	// An unrelated non-navigation inline dialog (ui.select / confirm / input) already mounted
	// in editorContainer when engine_view_agent(keepScreen: true) arrives must not have its Esc stolen.
	const unrelatedInlineDialog = new Text("Select an option", 0, 0);
	h.editorContainer.clear();
	h.editorContainer.addChild(unrelatedInlineDialog);

	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);

	h.deliverAllEngineToHost();
	assert.equal(h.switcher.pendingTaskId, "a2");
	assert.equal(h.sendHostKey(ESC), false, "must not steal Esc from an unrelated non-navigation inline dialog");
	assert.equal(h.switcher.pendingTaskId, "a2", "pending open untouched when Esc belongs to unrelated inline dialog");
	h.switcher.cancelPending();
	releaseOpen(undefined);
	await tick(2);

	// Real closing navigation view (/tasks marked via markNavigationView): Esc cancels pending open,
	// while a newly mounted dialog replacing it does NOT have its Esc stolen!
	let releaseOpen2!: (port: AgentViewPort | undefined) => void;
	const h2 = createHarnessWithOpenPort(
		[a1, a2],
		() =>
			new Promise((resolve) => {
				releaseOpen2 = resolve;
			}),
	);
	disposers.push(() => h2.dispose());
	const closingTasksComp = new Text("Tasks picker", 0, 0);
	markNavigationView(closingTasksComp, true);
	h2.editorContainer.clear();
	h2.editorContainer.addChild(closingTasksComp);
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h2.store,
		undefined,
		{ board: agentPanelBoardSource(h2.session) },
	);
	h2.deliverAllEngineToHost();
	assert.equal(h2.switcher.pendingTaskId, "a2");
	assert.equal(
		h2.sendHostKey(ESC),
		true,
		"Esc during closing-/tasks navigation window must cancel pending keepScreen open",
	);
	assert.equal(h2.switcher.pendingTaskId, undefined);
	const latePort = fakePort("a2");
	releaseOpen2(latePort);
	await tick(2);
	assert.equal(latePort.disposed, true);
	assert.equal(h2.switcher.viewed.kind, "main");
	markNavigationView(closingTasksComp, false);
});

test("hideFramesUntilFresh clears stale speculative lines so the 250ms timer can never unhide and paint them (New Host x Old Engine safety)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	try {
		const a1 = doneAgent("a1", "first alpha", 1);
		const a2 = doneAgent("a2", "second beta", 2);
		let releaseOpen!: (port: AgentViewPort | undefined) => void;
		const h = createHarnessWithOpenPort(
			[a1, a2],
			() =>
				new Promise((resolve) => {
					releaseOpen = resolve;
				}),
			{ engineVersion: "old" },
		);
		disposers.push(() => h.dispose());

		await showTaskInspector(
			mountTasksUi(async (c) => {
				await tick(2);
				c.handleInput?.(ENTER);
			}),
			h.store,
			undefined,
			{ board: agentPanelBoardSource(h.session) },
		);

		// New Host receives legacy engine_view_agent (no requestId) with panelOnView: true -> still sends taskId so Old Engine draws panel!
		h.deliverAllEngineToHost();
		assert.equal(h.hostToEngineSetViewed[0]?.command.type, "set_viewed_agent");
		const previewCmd = h.hostToEngineSetViewed[0]?.command;
		assert.equal(
			previewCmd?.type === "set_viewed_agent" ? previewCmd.taskId : undefined,
			"a2",
			"New Host must still populate taskId on preview for Old Engine #6240 compatibility",
		);
		await h.deliverAllSetViewedToEngine();
		await tick(2);
		h.deliverAllEngineToHost();
		// Prime panel frame from Old Engine (untagged, no previewSeq):
		assert.deepEqual(h.renderHostPanel(), [], "staged preview from Old Engine must stay hidden before commit");
		await h.deliverAllHostCommandsToEngine();
		h.deliverAllEngineToHost();
		assert.deepEqual(h.renderHostPanel(), [], "buffered untagged preview from Old Engine stays hidden before commit");

		// Open fails -> host cancels preview & hides frames until fresh; 250ms timer expires BEFORE any fresh frame arrives!
		releaseOpen(undefined);
		await tick(4);
		vi.advanceTimersByTime(300);
		assert.deepEqual(
			h.renderHostPanel(),
			[],
			"250ms timer expiry must NEVER unhide and paint stale speculative preview lines!",
		);
	} finally {
		vi.useRealTimers();
	}
});

test("happy-path panelOnView commit promotes staged preview with 0-frame gap (#6240 preserved)", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	let releaseOpen!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort([a1, a2], (_taskId, opts) => {
		const panel = opts?.panel ? watchWidgetFrames(h.runtime, AGENT_PANEL_WIDGET_KEY) : undefined;
		return new Promise((resolve) => {
			releaseOpen = (port) => {
				if (panel) {
					void panel.drawn().then(() => {
						panel.stop();
						resolve(port);
					});
				} else {
					resolve(port);
				}
			};
		});
	});
	disposers.push(() => h.dispose());

	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);

	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	// Prime frame unseen (as HeldDockRows does)
	assert.deepEqual(h.renderHostPanel(), [], "hidden before commit");
	await h.deliverAllHostCommandsToEngine();
	h.deliverAllEngineToHost();
	assert.deepEqual(h.renderHostPanel(), [], "still hidden while pending before commit");

	// Commit openPort("a2") -> panel MUST immediately paint a2 on the very next render (0-frame gap)!
	releaseOpen(fakePort("a2"));
	await tick(4);
	assert.equal(h.switcher.viewedTaskId(), "a2");
	const painted = h.renderHostPanel();
	assert.ok(
		painted.some((line) => line.includes("second beta")),
		`expected 0-frame-gap panel row for a2 immediately on commit, got: ${painted.join("\n")}`,
	);
});

test("host-initiated switch racing an unreceived engine_view_agent does not wipe engine pending anchor", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const a3 = doneAgent("a3", "third gamma", 3);
	const h = createHarnessWithOpenPort([a1, a2, a3], async (taskId) => fakePort(taskId));
	disposers.push(() => h.dispose());

	// First view a1 normally and settle both sides.
	await h.switcher.view("a1" as TaskId);
	await h.deliverAllSetViewedToEngine();
	assert.equal(agentViewBridge(h.session)?.viewedTaskId(), "a1");

	// Engine opens /tasks and requests a2 (requestId = 1), NOT delivered to host yet!
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			// Currently viewing a1 -> /tasks selects a1; move up to a2... wait: order is a3, a2, a1!
			c.handleInput?.("\x1b[A"); // UP from a1 -> a2
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);

	// BEFORE host receives engine_view_agent(a2, reqId=1), user presses <- on host to go back to main!
	await h.switcher.view(undefined);
	await h.deliverAllSetViewedToEngine();

	// Now host receives engine_view_agent(a2, reqId=1), opens a2, and sends committed set_viewed_agent(a2).
	h.deliverAllEngineToHost();
	await tick(4);
	await h.deliverAllSetViewedToEngine();

	// Return to main -> /tasks MUST restore a2 (proving host-initiated switch didn't prematurely wipe a2's pending)!
	await h.switcher.view(undefined);
	await h.deliverAllSetViewedToEngine();
	let restored = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			restored = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	assert.match(restored, /second beta/, `expected a2 restored after unreached host switch race, got: ${restored}`);
});

test("mixed-version compatibility: protocolVersion stays 4 and Old Host untagged set_viewed_agent works with New Engine", async () => {
	assert.equal(INTERACTIVE_ENGINE_PROTOCOL_VERSION, 4);
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const store = new FakeOwnerTaskStore([a1, a2]);
	const session = { extensionRunner: {} } as unknown as AgentSession;
	bindOwnerTaskStore(session, store);
	const sent: InteractiveEngineMessage[] = [];
	const context = {
		session,
		send: (message: InteractiveEngineMessage) => sent.push(message),
	} as never;
	disposers.push(installEngineAgentViewBridge(context));

	await showTaskInspector(
		mountTasksUi((c) => {
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		store,
		undefined,
		{ board: agentPanelBoardSource(session) },
	);

	// Old Host sends legacy untagged set_viewed_agent (no preview, no viewSeq, no settledRequestId).
	await handleSetViewedAgent({ id: "old-1", type: "set_viewed_agent", taskId: "a1" }, context);
	assert.equal(agentViewBridge(session)?.viewedTaskId(), "a1");
	await handleSetViewedAgent({ id: "old-2", type: "set_viewed_agent" }, context);
	assert.equal(agentViewBridge(session)?.viewedTaskId(), undefined);

	let restored = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			restored = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		store,
		undefined,
		{ board: agentPanelBoardSource(session) },
	);
	assert.match(restored, /first alpha/);
});

test("prior viewed subagent anchor is preserved when a panelOnView switch fails or is cancelled by Esc", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const a3 = doneAgent("a3", "third gamma", 3);
	let failNext = false;
	let releaseOpen: ((port: AgentViewPort | undefined) => void) | undefined;
	const h = createHarnessWithOpenPort([a1, a2, a3], (taskId) => {
		if (failNext)
			return new Promise((resolve) => {
				releaseOpen = resolve;
			});
		return Promise.resolve(fakePort(taskId));
	});
	disposers.push(() => h.dispose());

	// Open a1 from /tasks and commit it.
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await tick(4);
	await h.deliverAllSetViewedToEngine();
	assert.equal(agentViewBridge(h.session)?.viewedTaskId(), "a1");

	// Dismiss a1 from the idle panel so the panel has 0 rows -> requesting a2 emits panelOnView: true!
	dismissedAgentPanelItems(h.session).add("task:a1");
	failNext = true;
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.("\x1b[A"); // UP from a1 -> a2
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	const msgs = h.deliverAllEngineToHost();
	assert.ok(msgs.some((m) => m.type === "engine_view_agent" && m.taskId === "a2" && m.panelOnView === true));
	await h.deliverAllSetViewedToEngine();
	// Committed viewedTaskId stays on a1 during speculative preview of a2!
	assert.equal(agentViewBridge(h.session)?.viewedTaskId(), "a1");

	// a2 open FAILS -> stays on a1 -> return to main -> /tasks MUST restore a1 (not a2 or top)!
	releaseOpen?.(undefined);
	await tick(4);
	await h.deliverAllSetViewedToEngine();
	await h.switcher.view(undefined);
	await h.deliverAllSetViewedToEngine();
	let restored = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			restored = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	assert.match(
		restored,
		/first alpha/,
		`expected prior viewed a1 preserved after failed panelOnView switch, got: ${restored}`,
	);
});

test("supersede chains: superseding a panelOnView open with another open or main never paints old preview and never wipes new pending anchor", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const a3 = doneAgent("a3", "third gamma", 3);
	const resolvers = new Map<string, (port: AgentViewPort | undefined) => void>();
	const h = createHarnessWithOpenPort([a1, a2, a3], (taskId) => {
		return new Promise((resolve) => {
			resolvers.set(taskId, resolve);
		});
	});
	disposers.push(() => h.dispose());

	// 1. /tasks Enter a2 (panelOnView: true, requestId: 1)
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	h.renderHostPanel();
	await h.deliverAllHostCommandsToEngine();
	h.deliverAllEngineToHost();
	assert.deepEqual(h.renderHostPanel(), [], "a2 preview hidden while staged");

	// 2. Before a2 opens, user opens /tasks and enters a1 (requestId: 2) -> supersedes a2!
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN); // from pending a2 -> a1
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();

	// Late a2 port resolves -> disposed unused!
	const stalePort = fakePort("a2");
	resolvers.get("a2")?.(stalePort);
	await tick(2);
	assert.equal(stalePort.disposed, true);

	// Now a1 resolves -> commits a1, and returning to main MUST restore a1 (req 2 was NOT wiped by req 1's supersede!).
	resolvers.get("a1")?.(fakePort("a1"));
	await tick(4);
	await h.deliverAllSetViewedToEngine();
	assert.equal(agentViewBridge(h.session)?.viewedTaskId(), "a1");
	await h.switcher.view(undefined);
	await h.deliverAllSetViewedToEngine();
	let restored = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			restored = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	assert.match(restored, /first alpha/, `expected a1 restored after superseding a2, got: ${restored}`);
});

test("stale preview requestId < lastRequestId is ignored on engine, and host external supersede clears /tasks pending", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const a3 = doneAgent("a3", "third gamma", 3);
	const resolvers: Array<{ taskId: string; resolve: (p: AgentViewPort | undefined) => void }> = [];
	const h = createHarnessWithOpenPort([a1, a2, a3], (taskId) => {
		return new Promise((resolve) => {
			resolvers.push({ taskId, resolve });
		});
	});
	disposers.push(() => h.dispose());

	// /tasks Enter a1 (requestId: 1), delivered to host.
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	// Host queued preview(a1, requestId: 1). Hold it on the wire while engine sends requestId: 2 (null -> main)!
	const queuedPreview = h.hostToEngineSetViewed.slice();
	assert.equal(queuedPreview.length, 1);
	agentViewBridge(h.session)?.requestView(undefined); // requestId: 2
	// Now deliver stale preview(a1, requestId: 1) to engine -> engine MUST ignore it since 1 < lastRequestId(2)!
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	assert.deepEqual(h.renderHostPanel(), [], "stale preview requestId < lastRequestId must not activate panel");

	// Superseded /tasks open on isolated host: /tasks Enter a1 -> external host switcher.view(a3) supersedes a1 -> Esc on /tasks -> external switcher.view(a1) -> back to main -> next /tasks at top.
	for (const r of resolvers.splice(0)) r.resolve(undefined);
	await tick(4);
	await h.deliverAllSetViewedToEngine();

	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	// Host externally switches to a3 (superseding /tasks's a1!), then switches to a1 externally, then main.
	void h.switcher.view("a3" as TaskId);
	await h.deliverAllSetViewedToEngine();
	await showTaskInspector(
		mountTasksUi((c) => {
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	const a3Entry = resolvers.find((r) => r.taskId === "a3");
	a3Entry?.resolve(fakePort("a3"));
	await tick(2);
	await h.deliverAllSetViewedToEngine();
	const pA1 = h.switcher.view("a1" as TaskId);
	resolvers.at(-1)?.resolve(fakePort("a1"));
	await pA1;
	await h.deliverAllSetViewedToEngine();
	await h.switcher.view(undefined);
	await h.deliverAllSetViewedToEngine();

	let afterSupersede = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			afterSupersede = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	assert.match(afterSupersede, /third gamma/, `superseded a1 must not resurrect, got: ${afterSupersede}`);
});

test("same-agentKey already-shown request still acknowledges settledRequestId, and leaving viewed agent drops late promoted preview frames", async () => {
	const a1 = doneAgent("a1", "first alpha", 1, "op-same");
	const a1r = doneAgent("a1r", "first alpha resumed", 2, "op-same");
	const a2 = doneAgent("a2", "second beta", 3);
	let releaseFirst!: (port: AgentViewPort | undefined) => void;
	let firstOpen = true;
	const h = createHarnessWithOpenPort([a1, a2], (taskId) => {
		if (firstOpen && taskId === "a1") {
			firstOpen = false;
			return new Promise((resolve) => {
				releaseFirst = resolve;
			});
		}
		if (taskId === "a1" || taskId === "a1r") return Promise.resolve(fakePort(taskId, "agent:same"));
		return Promise.resolve(fakePort(taskId));
	});
	disposers.push(() => h.dispose());

	// Open a1 (panelOnView: true), keep openPort pending while engine renders previewSeq=1 frame!
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	// Trigger panel frame under previewSeq=1, capture a copy of the wire frame!
	h.renderHostPanel();
	await h.deliverAllHostCommandsToEngine();
	const capturedPreviewFrames = h.engineToHostQueue.filter((line) => line.includes('"previewSeq"'));
	assert.ok(capturedPreviewFrames.length >= 1, "engine emitted previewSeq-tagged panel frame");
	h.deliverAllEngineToHost();
	// Now commit a1!
	releaseFirst(fakePort("a1", "agent:same"));
	await tick(4);
	await h.deliverAllSetViewedToEngine();
	assert.equal(agentViewBridge(h.session)?.viewedTaskId(), "a1");

	// Now a1 resumes as a1r (same agentKey on host!) and user opens /tasks -> Enter a1r!
	h.store.set([a1r, a2]);
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await tick(4);
	// Host must STILL send a committed set_viewed_agent acknowledging settledRequestId even though agentKey matched without onChange!
	const acks = await h.deliverAllSetViewedToEngine();
	assert.ok(
		acks.some((cmd) => cmd.type === "set_viewed_agent" && cmd.preview !== true && (cmd.settledRequestId ?? 0) >= 2),
		`expected settledRequestId ack on same-agentKey open, got: ${JSON.stringify(acks)}`,
	);

	// Leave a1 back to main -> clears promotedSeq -> replaying the captured previewSeq=1 frame MUST be dropped!
	await h.switcher.view(undefined);
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	assert.deepEqual(h.renderHostPanel(), []);

	// Inject late duplicate of the old previewSeq=1 frame!
	h.engineToHostQueue.push(capturedPreviewFrames[0]!);
	h.deliverAllEngineToHost();
	assert.deepEqual(
		h.renderHostPanel(),
		[],
		"late previewSeq frame after leaving viewed agent back to main MUST be dropped and never paint!",
	);
});

test("generation reset clears host viewSeq/settledRequestId watermarks so a replacement engine starting at requestId=1 works cleanly", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	let releaseOpen!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort(
		[a1, a2],
		() =>
			new Promise((resolve) => {
				releaseOpen = resolve;
			}),
	);
	disposers.push(() => h.dispose());

	// Generation 1: request a2 -> fails (settledRequestId = 1, viewSeq = 2).
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	releaseOpen(undefined);
	await tick(4);
	await h.deliverAllSetViewedToEngine();

	// Generation 1 dies -> host resets watermarks & preview gates!
	h.emitGenerationEnded();
	h.engineToHostQueue.push(
		serializeInteractiveEngineMessage({
			type: "engine_ready",
			protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION,
			pid: 4242,
		}),
	);
	h.deliverAllEngineToHost();

	// Replacement engine starts fresh at requestId=1!
	const freshSession = { extensionRunner: {} } as unknown as AgentSession;
	const freshStore = new FakeOwnerTaskStore([a1, a2]);
	bindOwnerTaskStore(freshSession, freshStore);
	const freshCtx = {
		session: freshSession,
		send(message: InteractiveEngineMessage) {
			h.engineToHostQueue.push(serializeInteractiveEngineMessage(message));
		},
		customUi: h.engineCustomUi,
		ui: h.engineContext.ui,
	};
	disposers.push(installEngineAgentViewBridge(freshCtx));

	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(DOWN);
			c.handleInput?.(ENTER);
		}),
		freshStore,
		undefined,
		{ board: agentPanelBoardSource(freshSession) },
	);
	h.deliverAllEngineToHost();
	releaseOpen(fakePort("a1"));
	await tick(4);
	const cmds = h.hostToEngineSetViewed.splice(0);
	for (const item of cmds) {
		if (item.command.type === "set_viewed_agent") await handleSetViewedAgent(item.command, freshCtx);
		item.resolve();
	}
	assert.equal(agentViewBridge(freshSession)?.viewedTaskId(), "a1", "replacement engine requestId=1 accepted cleanly");
	const lastCmd = cmds.at(-1)?.command;
	assert.equal(
		lastCmd?.type === "set_viewed_agent" ? lastCmd.viewSeq : undefined,
		1,
		"host viewSeq reset to 1 on new generation",
	);
});

test("clicking main in the idle panel while a speculative preview is active cancels the preview and requests main", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	let releaseOpen!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort(
		[a1, a2],
		() =>
			new Promise((resolve) => {
				releaseOpen = resolve;
			}),
	);
	disposers.push(() => h.dispose());

	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	// Render panel on engine so painted rows include `main` + previewed `a2`.
	h.renderHostPanel();
	await h.deliverAllHostCommandsToEngine();
	const frames = h.deliverAllEngineToHost();
	const panelFrame = frames.find((m) => m.type === "engine_custom_frame");
	assert.ok(panelFrame?.type === "engine_custom_frame");

	// Simulate clicking row 0 (`main`) on the engine widget while only speculative preview is active (committed === undefined).
	h.engineCustomUi.handleLine(
		JSON.stringify({
			type: "engine_custom_click",
			componentId: panelFrame.componentId,
			frame: panelFrame.frame ?? 1,
			rowKey: panelFrame.rowKeys?.[0],
			clickId: 1,
			cancelsClicks: true,
			x: 2,
			y: 0,
			width: 100,
			height: 2,
		}),
	);
	h.engineCustomUi.handleLine(
		JSON.stringify({
			type: "engine_custom_click_settle",
			componentId: panelFrame.componentId,
			clickId: 1,
		}),
	);
	const afterClick = h.deliverAllEngineToHost();
	assert.ok(
		afterClick.some((m) => m.type === "engine_view_agent" && m.taskId === null),
		"clicking main while preview is active must emit engine_view_agent(null) to cancel preview",
	);
	assert.equal(h.switcher.pendingTaskId, undefined, "host pending open cancelled by clicking main");
	const latePort = fakePort("a2");
	releaseOpen(latePort);
	await tick(2);
	assert.equal(latePort.disposed, true);
});

test("prior viewed subagent going gone while next panelOnView open is in flight preserves the active preview until commit", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	let a1GoneListener: (() => void) | undefined;
	let a1Gone = false;
	const a1Port = fakePort("a1");
	const origStatus = a1Port.status.bind(a1Port);
	a1Port.status = () => ({ ...origStatus(), gone: a1Gone });
	a1Port.subscribe = (listener: () => void) => {
		a1GoneListener = listener;
		return () => {
			if (a1GoneListener === listener) a1GoneListener = undefined;
		};
	};
	let releaseA2!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort([a1, a2], (taskId) => {
		if (taskId === "a1") return Promise.resolve(a1Port);
		return new Promise((resolve) => {
			releaseA2 = resolve;
		});
	});
	disposers.push(() => h.dispose());

	// View a1, dismiss a1 from panel so idle panel is empty, then request a2 from /tasks (panelOnView: true).
	await h.switcher.view("a1" as TaskId);
	await h.deliverAllSetViewedToEngine();
	dismissedAgentPanelItems(h.session).add("task:a1");
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.("\x1b[A"); // UP to a2
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	// Prime preview frame for a2.
	h.renderHostPanel();
	await h.deliverAllHostCommandsToEngine();
	h.deliverAllEngineToHost();

	// While a2 is STILL opening, a1 becomes gone -> host switches committed view to main (settledRequestId < a2's reqId)!
	a1Gone = true;
	a1GoneListener?.();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	assert.ok(
		h.widgets.has(AGENT_PANEL_WIDGET_KEY),
		"panel must remain mounted for in-flight a2 preview when a1 goes gone",
	);

	// Commit a2 -> panel paints a2 immediately with 0-frame gap!
	releaseA2(fakePort("a2"));
	await tick(4);
	assert.equal(h.switcher.viewedTaskId(), "a2");
	assert.ok(
		h.renderHostPanel().some((line) => line.includes("second beta")),
		"a2 panel row must paint immediately on commit even after prior a1 went gone mid-open",
	);
});

test("stale engCommitted === requestedAgentId when host already left to main and open fails resets next /tasks to top", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const a3 = doneAgent("a3", "third gamma", 3);
	let failA1 = false;
	const h = createHarnessWithOpenPort([a1, a2, a3], async (taskId) => {
		if (failA1 && taskId === "a1") return undefined;
		return fakePort(taskId);
	});
	disposers.push(() => h.dispose());

	// Externally view a1 (no /tasks anchor saved yet).
	await h.switcher.view("a1" as TaskId);
	await h.deliverAllSetViewedToEngine();
	assert.equal(agentViewBridge(h.session)?.viewedTaskId(), "a1");

	// Host leaves a1 -> main, but set_viewed_agent(undefined) is still in flight on the wire!
	await h.switcher.view(undefined);
	failA1 = true;

	// Engine (with stale committed === "a1") opens /tasks and enters a1 (requestId: 1).
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);

	// Deliver host's earlier leave-to-main (settledRequestId: 0), then host processes reqId=1 and fails openPort("a1") (settledRequestId: 1).
	await h.deliverAllSetViewedToEngine();
	h.deliverAllEngineToHost();
	await tick(4);
	await h.deliverAllSetViewedToEngine();

	// Next /tasks on main MUST start at top (third gamma), NOT failed a1!
	let nextSelection = "";
	await showTaskInspector(
		mountTasksUi((c, rows) => {
			nextSelection = selectedLine(rows());
			c.handleInput?.(ESC);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	assert.match(nextSelection, /third gamma/, `failed re-open of stale a1 must reset to top, got: ${nextSelection}`);
});

test("synchronous widget.render() after preview clears still unmounts 0-row panel in the microtask so subsequent panelOnView opens mount cleanly", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	let releaseOpen!: (port: AgentViewPort | undefined) => void;
	const h = createHarnessWithOpenPort(
		[a1, a2],
		() =>
			new Promise((resolve) => {
				releaseOpen = resolve;
			}),
	);
	disposers.push(() => h.dispose());

	// 1. Mount panel via speculative preview.
	await showTaskInspector(
		mountTasksUi(async (c) => {
			await tick(2);
			c.handleInput?.(ENTER);
		}),
		h.store,
		undefined,
		{ board: agentPanelBoardSource(h.session) },
	);
	h.deliverAllEngineToHost();
	await h.deliverAllSetViewedToEngine();
	await tick(2);
	h.deliverAllEngineToHost();
	assert.ok(h.widgets.has(AGENT_PANEL_WIDGET_KEY), "preview mounted panel widget");

	// 2. Cancel open -> host sends correction set_viewed_agent(undefined) -> engine clears preview & queues microtask.
	// Trigger a synchronous widget render BEFORE the microtask runs!
	h.switcher.cancelPending();
	releaseOpen(undefined);
	await h.deliverAllSetViewedToEngine();
	// Synchronous render before microtask:
	h.renderHostPanel();
	await h.deliverAllHostCommandsToEngine();
	// Now let microtasks drain and deliver engine messages to host:
	await tick(4);
	h.deliverAllEngineToHost();
	assert.equal(
		h.widgets.has(AGENT_PANEL_WIDGET_KEY),
		false,
		"0-row panel widget must unmount in microtask even after synchronous render()",
	);
});

test("urgent bridge preview mount/unmount bypasses refresh budget even when scheduleUpdate already queued the microtask", async () => {
	const a1 = doneAgent("a1", "first alpha", 1);
	const a2 = doneAgent("a2", "second beta", 2);
	const h = createHarnessWithOpenPort([a1, a2], async (taskId) => fakePort(taskId));
	disposers.push(() => h.dispose());

	// Exhaust the 8ms refresh budget with rapid store ticks, leaving a background scheduleUpdate microtask pending.
	for (let i = 0; i < 6; i++) {
		h.store.set([a1, a2]);
	}
	// In the SAME tick, deliver a speculative preview set_viewed_agent -> scheduleViewUpdate sets viewDirty=true!
	await handleSetViewedAgent(
		{ id: "urgent-preview-1", type: "set_viewed_agent", taskId: "a2", preview: true, viewSeq: 1, requestId: 1 },
		h.engineContext,
	);
	// After microtask drains (without waiting 50ms!), panel MUST already be mounted!
	await Promise.resolve();
	await Promise.resolve();
	h.deliverAllEngineToHost();
	assert.equal(
		h.widgets.has(AGENT_PANEL_WIDGET_KEY),
		true,
		"bridge preview mount must run in the microtask without being deferred by background refresh budget",
	);
});
