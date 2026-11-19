import assert from "node:assert/strict";
import { type Component, Container, Text, type TUI } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { AgentPanelSourceHub } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.ts";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";

const DOWN = "\x1b[B";

type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

interface FocusHost {
	listeners: InputListener[];
	extensionDialogs: Array<{ component: Component }>;
	editorContainer: Container;
	press(data: string): boolean;
	setupKeyHandlers(): Promise<void>;
}

beforeAll(() => initTheme("dark"));

function panelHub(): AgentPanelSourceHub {
	const hub = new AgentPanelSourceHub();
	hub.register({
		items: () => [{ id: "fixture:run", kind: "agent", state: "running", name: "review", task: "stage one" }],
		subscribe: () => () => {},
	});
	return hub;
}

function focusHost(
	options: { runtimeHost?: object; customEditor?: Component & { getText(): string } } = {},
): FocusHost {
	const keybindings = new KeybindingsManager();
	const tui = { requestRender: () => {} } as TUI;
	const defaultEditor = new CustomEditor(tui, getEditorTheme(), keybindings);
	const editor = options.customEditor ?? defaultEditor;
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const listeners: InputListener[] = [];
	const noop = () => {};
	const session = { extensionRunner: { getAgentPanelSourceHub: panelHub }, settingsManager: {} };
	const state = {
		listeners,
		keybindings,
		defaultEditor,
		editor,
		editorContainer,
		isBashMode: false,
		extensionDialogs: [] as Array<{ component: Component }>,
		extensionOverlays: new Set<() => void>(),
		blockingInlineCustomUiDepth: 0,
		navigationInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		pendingInlineCustomUiFocus: undefined,
		hostCustomUiStateListeners: new Set(),
		programStatus: { setBlocked: noop },
		footerDataProvider: { setExtensionStatus: noop },
		runtimeHost: options.runtimeHost ?? { session },
		ui: { requestRender: noop, hasOverlay: () => false, setFocus: noop },
		addTuiInputListener: (listener: InputListener) => {
			listeners.push(listener);
			return noop;
		},
		disposeActiveSelector: noop,
		renderWidgets: noop,
		showWarning: noop,
		createExtensionUIContext: () => ({
			getChatRenderSettings: () => ({}),
			getFooterDataProvider: () => undefined,
			getToolsExpanded: () => false,
			setToolsExpanded: noop,
			notify: noop,
		}),
		press(data: string): boolean {
			return listeners.some((listener) => listener(data)?.consume === true);
		},
	};
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	return new Proxy(state, {
		get(target, key, receiver) {
			if (key in target) return Reflect.get(target, key, receiver);
			if (key === "session") return (target.runtimeHost as { session?: unknown }).session ?? session;
			const value = prototype[key as string];
			return typeof value === "function" ? value.bind(receiver) : value;
		},
	}) as unknown as FocusHost;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("↓ inside an extension's custom editor stays with that editor instead of focusing the agent panel (#5224)", async () => {
	const formEditor = Object.assign(new Text("inputs form", 0, 0), { getText: () => "" });
	const host = focusHost({ customEditor: formEditor });
	await host.setupKeyHandlers();

	assert.equal(host.press(DOWN), false);
	await settle();
	assert.equal(host.extensionDialogs.length, 0);
	assert.deepEqual(host.editorContainer.children, [formEditor]);
});

test("two ↓ presses read in one burst focus a single agent panel (#5224)", async () => {
	const host = focusHost();
	await host.setupKeyHandlers();

	assert.equal(host.press(DOWN), true);
	host.press(DOWN);
	await settle();

	assert.equal(host.extensionDialogs.length, 1);
});

test("a second ↓ before the isolated engine answers sends no second focus request (#5224)", async () => {
	let requests = 0;
	let answer!: () => void;
	const runtimeHost = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype) as object, {
		openAgentPanel: () => {
			requests += 1;
			return new Promise<void>((resolve) => {
				answer = resolve;
			});
		},
	});
	const host = focusHost({ runtimeHost });
	await host.setupKeyHandlers();

	assert.equal(host.press(DOWN), true);
	assert.equal(host.press(DOWN), true);
	assert.equal(requests, 1);

	answer();
	await settle();
	host.press(DOWN);
	assert.equal(requests, 2);
});
