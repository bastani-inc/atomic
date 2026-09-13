import assert from "node:assert/strict";
import {
	getKeybindings,
	isKittyProtocolActive,
	type KeyId,
	matchesKey,
	setKeybindings,
	setKittyProtocolActive,
	Text,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { resolveExtensionShortcuts } from "../../packages/coding-agent/src/core/extensions/runner-shortcuts.js";
import type { Extension } from "../../packages/coding-agent/src/core/extensions/types.js";
import type { WidgetScrollState } from "../../packages/coding-agent/src/core/extensions/ui-types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.js";
import { ScrollWidget } from "../../packages/coding-agent/src/modes/interactive/components/scroll-widget.js";
import { getEditorTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import { attachInteractiveEngineHost } from "../../packages/coding-agent/src/modes/interactive-engine/extension-ui-bridge.js";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
import {
	type EngineKeybindingState,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.js";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type LayoutBox,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import factory from "../../packages/workflows/src/extension/extension-factory.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { installStoreWidget, scrollStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.js";
import { workflowScrollHint } from "../../packages/workflows/src/tui/widget-scroll-hint.js";

function registrations(): Extension {
	const extension: Extension = {
		path: "workflow-fixture",
		resolvedPath: "workflow-fixture",
		sourceInfo: { path: "workflow-fixture", source: "test", scope: "temporary", origin: "top-level" },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	factory({
		on() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut(key, options) {
			extension.shortcuts.set(key as KeyId, {
				...options,
				handler: () => options.handler(),
				shortcut: key as KeyId,
				extensionPath: extension.path,
			});
		},
		events: { on: () => () => {}, emit() {} },
	});
	return extension;
}

// Actual workflow registration and production shortcut resolution, not source assertions.
test("workflow actions resolve Alt letter and Page aliases, configurable empties/remaps and editor conflicts", () => {
	const extension = registrations();
	const defaults = new KeybindingsManager().getEffectiveConfig();
	const resolve = (config = defaults) => resolveExtensionShortcuts([extension], config, true).shortcuts;
	const shortcuts = resolve();
	for (const [bytes, key] of [
		["\x1bk", "alt+k"],
		["\x1bj", "alt+j"],
		["\x1b[5;3~", "alt+pageup"],
		["\x1b[6;3~", "alt+pagedown"],
		["\x1b[107;3u", "alt+k"],
		["\x1b[106;3u", "alt+j"],
	]) {
		assert.ok(shortcuts.has(key as KeyId), key);
		assert.equal(matchesKey(bytes!, key as KeyId), true, JSON.stringify(bytes));
	}
	assert.equal(matchesKey("˚", "alt+k"), false); // Option-as-character is ordinary text, not Alt.
	assert.equal(matchesKey("j", "alt+j"), false);
	assert.equal(shortcuts.has("alt+up"), false);
	const vim = {
		...defaults,
		"tui.editor.cursorUp": ["up", "alt+k"],
		"tui.editor.cursorDown": ["down", "alt+j"],
	} as typeof defaults;
	assert.equal(resolve(vim).has("alt+k"), false);
	assert.equal(resolve(vim).has("alt+j"), false);
	assert.ok(resolve(vim).has("alt+pageup" as KeyId));
	const disabled = { ...defaults, "app.workflows.scrollUp": [], "app.workflows.scrollDown": [] };
	assert.equal(resolve(disabled).size, 1); // Unrelated F2 remains.
	const remapped = { ...disabled, "app.workflows.scrollUp": "ctrl+alt+k" as KeyId };
	assert.ok(resolve(remapped).has("ctrl+alt+k"));
	assert.equal(resolve(remapped).has("alt+pageup" as KeyId), false);
	assert.equal(resolve({ ...remapped, "tui.editor.cursorUp": "ctrl+alt+k" as KeyId }).has("ctrl+alt+k"), false);
	// PR #3022: Windows/WSL restores queued messages with Alt+Q, other hosts with Alt+Up.
	for (const dequeueKey of ["alt+up", "alt+q"] as KeyId[]) {
		assert.equal(
			resolve({ ...disabled, "app.message.dequeue": dequeueKey, "app.workflows.scrollUp": dequeueKey }).has(
				dequeueKey,
			),
			false,
		);
	}
	const duplicate = resolve({ ...defaults, "app.workflows.scrollUp": ["alt+j", "alt+j"] as KeyId[] });
	assert.equal(duplicate.get("alt+j")?.keybinding, "app.workflows.scrollDown"); // Existing last-registration map policy.
	assert.match(workflowScrollHint(defaults, "darwin"), /Option\+k\/Option\+j/);
	assert.match(workflowScrollHint(defaults, "linux"), /Alt\+k\/Alt\+j/);
	assert.match(workflowScrollHint(defaults, "win32"), /Alt\+k\/Alt\+j/);
	assert.equal(workflowScrollHint(disabled, "darwin"), " Wheel scroll workflows");
	assert.doesNotMatch(workflowScrollHint(vim, "darwin"), /Option\+[kj]/);
});

test("workflow yields to editor modifier-order equivalents without rewriting configured keys", () => {
	const workflow: KeyId = "ctrl+alt+k";
	const editor: KeyId = "alt+ctrl+k";
	const bytes = "\x1b[107;7u";
	assert.ok(matchesKey(bytes, workflow));
	assert.ok(matchesKey(bytes, editor));
	const bindings = new KeybindingsManager({
		"app.workflows.scrollUp": [workflow],
		"app.workflows.scrollDown": [],
		"tui.editor.cursorUp": ["up", editor],
	}).getEffectiveConfig();
	const shortcuts = resolveExtensionShortcuts([registrations()], bindings, true).shortcuts;
	assert.equal(
		[...shortcuts.keys()].some((key) => matchesKey(bytes, key)),
		false,
	);
	assert.deepEqual(bindings["app.workflows.scrollUp"], workflow);
	assert.equal(workflowScrollHint(bindings, "darwin"), " Wheel scroll workflows");
});

test("workflow yields to the editor's shift+enter when configured as shift+return", () => {
	const bytes = "\x1b[13;2u";
	assert.ok(matchesKey(bytes, "shift+return"));
	assert.ok(matchesKey(bytes, "shift+enter"));
	const bindings = new KeybindingsManager({
		"app.workflows.scrollUp": "shift+return",
		"app.workflows.scrollDown": [],
	}).getEffectiveConfig();
	const shortcuts = resolveExtensionShortcuts([registrations()], bindings, true).shortcuts;
	assert.equal(
		[...shortcuts.keys()].some((key) => matchesKey(bytes, key)),
		false,
	);
	assert.equal(workflowScrollHint(bindings, "linux"), " Wheel scroll workflows");
});

test("workflow esc yields to reserved escape, including without preferEditor", () => {
	const bytes = "\x1b";
	assert.ok(matchesKey(bytes, "esc"));
	assert.ok(matchesKey(bytes, "escape"));
	const bindings = new KeybindingsManager({
		"app.workflows.scrollUp": "esc",
		"app.workflows.scrollDown": [],
	}).getEffectiveConfig();
	const extension = registrations();
	for (const preferEditor of [true, false]) {
		for (const shortcut of extension.shortcuts.values()) shortcut.preferEditor = preferEditor;
		const shortcuts = resolveExtensionShortcuts([extension], bindings, true).shortcuts;
		assert.equal(
			[...shortcuts.keys()].some((key) => matchesKey(bytes, key)),
			false,
		);
	}
	assert.equal(workflowScrollHint(bindings, "win32"), " Wheel scroll workflows");
});

test("literal editor-first shortcuts yield to equivalent keys but legacy registrations still override", () => {
	const extension = registrations();
	extension.shortcuts.clear();
	const shortcut = {
		shortcut: "ctrl+alt+k" as KeyId,
		extensionPath: extension.path,
		handler() {},
		preferEditor: false,
	};
	extension.shortcuts.set(shortcut.shortcut, shortcut);
	const bindings = new KeybindingsManager({ "tui.editor.cursorUp": "alt+ctrl+k" }).getEffectiveConfig();
	assert.ok(resolveExtensionShortcuts([extension], bindings, true).shortcuts.has(shortcut.shortcut));
	shortcut.preferEditor = true;
	assert.equal(resolveExtensionShortcuts([extension], bindings, true).shortcuts.has(shortcut.shortcut), false);
});

const sharedInputs: {
	workflow: KeyId;
	editor: KeyId;
	bytes: string;
	explicit?: string;
	kitty?: boolean;
	windows?: boolean;
	ssh?: boolean;
	defaults?: boolean;
	literal?: boolean;
	action?: "tui.input.tab" | "tui.input.submit";
}[] = [
	{ workflow: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u" },
	{ workflow: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", defaults: true },
	{ workflow: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", kitty: true },
	{ workflow: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", windows: true, ssh: true },
	{ workflow: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", literal: true },
	{ workflow: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", literal: false },
	{ workflow: "ctrl+h", editor: "ctrl+backspace", bytes: "\b", explicit: "\x1b[27;5;104~", windows: true },
	{ workflow: "backspace", editor: "ctrl+h", bytes: "\b", explicit: "\x1b[127u" },
	{ workflow: "ctrl+i", editor: "tab", bytes: "\t", explicit: "\x1b[105;5u" },
	{ workflow: "ctrl+m", editor: "enter", bytes: "\r", explicit: "\x1b[109;5u" },
	{ workflow: "ctrl+i", editor: "tab", action: "tui.input.tab", bytes: "\t", explicit: "\x1b[105;5u" },
	{ workflow: "ctrl+m", editor: "enter", action: "tui.input.submit", bytes: "\r", explicit: "\x1b[109;5u" },
	{ workflow: "ctrl+j", editor: "enter", bytes: "\n", explicit: "\x1b[106;5u" },
	{ workflow: "ctrl+j", editor: "shift+enter", bytes: "\n", explicit: "\x1b[106;5u", kitty: true },
	{ workflow: "ctrl+[", editor: "escape", bytes: "\x1b", explicit: "\x1b[91;5u" },
	{ workflow: "ctrl+-", editor: "ctrl+_", bytes: "\x1f", explicit: "\x1b[45;5u" },
	{ workflow: "ctrl+_", editor: "ctrl+-", bytes: "\x1f", explicit: "\x1b[95;5u" },
	{ workflow: "ctrl+alt+h", editor: "alt+backspace", bytes: "\x1b\b", explicit: "\x1b[104;7u" },
	{ workflow: "ctrl+alt+m", editor: "alt+enter", bytes: "\x1b\r", explicit: "\x1b[109;7u" },
	{ workflow: "alt+b", editor: "alt+left", bytes: "\x1bb", explicit: "\x1b[98;3u" },
	{ workflow: "alt+f", editor: "alt+right", bytes: "\x1bf", explicit: "\x1b[102;3u" },
	{ workflow: "alt+p", editor: "alt+up", bytes: "\x1bp", explicit: "\x1b[112;3u" },
	{ workflow: "alt+n", editor: "alt+down", bytes: "\x1bn", explicit: "\x1b[110;3u" },
	{ workflow: "ctrl+alt+k", editor: "alt+ctrl+k", bytes: "\x1b[107;7u" },
	{ workflow: "shift+return", editor: "shift+enter", bytes: "\x1b[13;2u" },
	{ workflow: "esc", editor: "escape", bytes: "\x1b" },
];

for (const route of ["native", "remote"])
	for (const scenario of sharedInputs)
		test(`${route}: ${scenario.workflow}/${scenario.editor} ${JSON.stringify(scenario)}`, async () => {
			const f = createProductionFullscreenContext({ columns: 100, rows: 30 });
			const previous = getKeybindings();
			const ids = Array.from({ length: 14 }, (_, i) => `shared-input-${i}`);
			const previousKitty = isKittyProtocolActive();
			let disposeRemote: (() => void) | undefined;
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				factory({
					ui: f.context.createExtensionUIContext() as unknown as NonNullable<ExtensionAPI["ui"]>,
					on() {},
					registerTool() {},
					registerCommand() {},
					events: { on: () => () => {}, emit() {} },
				});
				for (const id of ids)
					store.recordRunStart({ id, name: id, status: "paused", startedAt: Date.now(), inputs: {}, stages: [] });
				await Promise.resolve();
				// Isolate this configured editor action from defaults that also accept the input.
				const empty = Object.fromEntries(
					Object.keys(new KeybindingsManager().getEffectiveConfig()).map((action) => [action, []]),
				);
				const bindings = new KeybindingsManager({
					...(scenario.defaults ? {} : empty),
					"app.workflows.scrollUp": [],
					"app.workflows.scrollDown": scenario.workflow,
					[scenario.action ?? "tui.editor.deleteCharBackward"]: scenario.editor,
				});
				const rawBindings = JSON.stringify(bindings.getUserBindings());
				setKittyProtocolActive(scenario.kitty ?? false);
				vi.stubEnv("WT_SESSION", scenario.windows ? "fixture" : "");
				for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, "");
				if (scenario.ssh) vi.stubEnv("SSH_CONNECTION", "fixture");
				assert.ok(matchesKey(scenario.bytes, scenario.workflow));
				assert.ok(matchesKey(scenario.bytes, scenario.editor));
				setKeybindings(bindings);
				const editor = new CustomEditor(f.tui, getEditorTheme(), bindings);
				const submissions: string[] = [];
				editor.onSubmit = (value) => submissions.push(value);
				if (scenario.action === "tui.input.tab")
					editor.setAutocompleteProvider({
						getSuggestions: async () => ({
							items: [{ value: "completed", label: "completed" }],
							prefix: "draft",
						}),
						applyCompletion: () => ({ lines: ["completed"], cursorLine: 0, cursorCol: 9 }),
					});
				let escapes = 0;
				editor.onEscape = () => {
					escapes++;
				};
				Object.assign(f.context, { keybindings: bindings, editor, defaultEditor: editor });
				Object.assign(f.context.session, {
					sessionManager: { getCwd: () => process.cwd() },
					agent: { signal: new AbortController().signal },
				});
				f.context.editorContainer.clear();
				f.context.editorContainer.addChild(editor);
				f.tui.setFocus(editor);
				const extension = registrations();
				if (scenario.literal !== undefined) {
					const shortcut = [...extension.shortcuts.values()].find(
						(value) => value.keybinding === "app.workflows.scrollDown",
					)!;
					extension.shortcuts.clear();
					extension.shortcuts.set(scenario.workflow, {
						...shortcut,
						keybinding: undefined,
						shortcut: scenario.workflow,
						preferEditor: scenario.literal,
					});
				}
				const shortcuts = resolveExtensionShortcuts([extension], bindings.getEffectiveConfig(), true).shortcuts;
				if (route === "native") {
					f.context.setupExtensionShortcuts({
						getShortcuts: () => shortcuts,
						getUIContext: () => f.context.createExtensionUIContext(),
					} as never);
				} else {
					const stateListeners = new Set<(state: EngineKeybindingState) => void>();
					const runtime = Object.assign(
						Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime,
						{
							onDiagnostic: () => () => {},
							setExtensionUIHandler: () => () => {},
							onGenerationEnded: () => () => {},
							onEngineMessage: () => () => {},
							sendEngineCommand() {},
							onKeybindingState: (listener: (state: EngineKeybindingState) => void) => {
								stateListeners.add(listener);
								return () => stateListeners.delete(listener);
							},
							invokeRemoteShortcut: async (key: KeyId) => {
								await shortcuts.get(key)!.handler({} as never);
							},
						},
					);
					disposeRemote = attachInteractiveEngineHost(
						runtime,
						f.context.createExtensionUIContext(),
						() => {},
						{
							isFullscreen: () => true,
							onRendererReplaced: () => () => {},
						},
						(handler) => {
							editor.onExtensionShortcut = handler;
							return () => {
								editor.onExtensionShortcut = undefined;
							};
						},
						bindings,
					);
					const message = parseInteractiveEngineMessage(
						JSON.stringify({
							type: "engine_keybindings_reloaded",
							state: {
								userBindings: bindings.getUserBindings(),
								effectiveBindings: bindings.getEffectiveConfig(),
								shortcuts: [...shortcuts].map(([key, shortcut]) => ({ key, editorKeys: shortcut.editorKeys })),
							},
						}),
					);
					assert.ok(message?.type === "engine_keybindings_reloaded");
					for (const listener of stateListeners) listener(message.state);
				}
				editor.setText("draft");
				f.tui.renderNow();
				const widget = f.context.extensionWidgetsBelow.get("workflow.run");
				assert.ok(widget instanceof ScrollWidget);
				f.terminal.input(scenario.bytes);
				await new Promise<void>((resolve) => setImmediate(resolve));
				f.tui.renderNow();
				const expectedDraft =
					scenario.action === "tui.input.tab"
						? "completed"
						: scenario.action === "tui.input.submit"
							? ""
							: scenario.editor === "escape" || scenario.literal === false
								? "draft"
								: "draf";
				assert.equal(editor.getText(), expectedDraft);
				assert.deepEqual(submissions, scenario.action === "tui.input.submit" ? ["draft"] : []);
				assert.equal(escapes, scenario.editor === "escape" ? 1 : 0);
				const sharedScroll = scenario.literal === false ? 1 : 0;
				assert.equal(widget.scrollTop, sharedScroll);
				assert.equal(workflowScrollHint(bindings.getEffectiveConfig(), "linux"), " Wheel scroll workflows");
				if (scenario.explicit) {
					assert.ok(matchesKey(scenario.explicit, scenario.workflow));
					assert.equal(matchesKey(scenario.explicit, scenario.editor), false);
					f.terminal.input(scenario.explicit);
					f.tui.renderNow();
					assert.equal(editor.getText(), expectedDraft);
					assert.equal(widget.scrollTop, sharedScroll + 1);
				}
				assert.equal(JSON.stringify(bindings.getUserBindings()), rawBindings);
				assert.equal(f.tui.getFocusedComponent(), editor);
				f.terminal.input(" typed");
				assert.equal(editor.getText(), `${expectedDraft} typed`);
			} finally {
				disposeRemote?.();
				setKeybindings(previous);
				setKittyProtocolActive(previousKitty);
				vi.unstubAllEnvs();
				for (const id of ids) store.removeRun(id);
				f.context.clearExtensionWidgets();
				f.resolveTheme();
				await f.initPromise;
				f.tui.stop();
				f.restoreOffline();
			}
		});

test("unrelated extension shortcuts retain their existing editor-conflict policy", () => {
	const extension = registrations();
	extension.shortcuts.clear();
	extension.shortcuts.set("alt+j", { shortcut: "alt+j", extensionPath: extension.path, handler() {} });
	const defaults = new KeybindingsManager().getEffectiveConfig();
	assert.equal(resolveExtensionShortcuts([extension], defaults, true).diagnostics.length, 0);
	const vim = { ...defaults, "tui.editor.cursorDown": "alt+j" as KeyId };
	const legacy = resolveExtensionShortcuts([extension], vim, true);
	assert.ok(legacy.shortcuts.has("alt+j"));
	assert.equal(legacy.diagnostics.length, 1);
	extension.shortcuts.get("alt+j")!.preferEditor = true;
	assert.equal(resolveExtensionShortcuts([extension], vim, true).shortcuts.has("alt+j"), false);
});

function boxFor(box: LayoutBox, widget: object): LayoutBox | undefined {
	if (box.component === widget) return box;
	for (const child of box.children ?? []) {
		const found = boxFor(child, widget);
		if (found) return found;
	}
}

test("workflow wheel uses actual clipped bounds, contains boundaries, preserves outside transcript and editor input", async () => {
	const f = createProductionFullscreenContext({ columns: 100, rows: 18, transcriptLines: 80 });
	const ids = Array.from({ length: 14 }, (_, i) => `adapter-wheel-${i}`);
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		const extension = registrations();
		// Install the same actual factory against the production UI.
		factory({
			ui: f.context.createExtensionUIContext() as unknown as NonNullable<ExtensionAPI["ui"]>,
			on() {},
			registerTool() {},
			registerCommand() {},
			events: { on: () => () => {}, emit() {} },
		});
		for (const [i, id] of ids.entries())
			store.recordRunStart({
				id,
				name: "same name",
				status: "paused",
				startedAt: Date.now() + i,
				inputs: {},
				stages: [],
			});
		await Promise.resolve();
		const editor = new CustomEditor(f.tui, getEditorTheme(), new KeybindingsManager());
		f.context.editorContainer.clear();
		f.context.editorContainer.addChild(editor);
		f.context.editor = editor;
		f.context.defaultEditor = editor;
		f.tui.setFocus(editor);
		f.context.editor.setText("draft intact");
		f.context.editorContainer.addChild(new Text("draft two\ndraft three", 0, 0));
		f.tui.renderNow();
		const widget = f.context.extensionWidgetsBelow.get("workflow.run");
		assert.ok(widget instanceof ScrollWidget);
		const transcript = f.context.transcriptScrollView!;
		const render = () => {
			f.tui.renderNow();
			return boxFor(getLayoutFrame(f.tui).root, widget)!;
		};
		assert.ok(render().rect.height > 0 && render().rect.height <= 6);
		assert.equal(widget.isScrollbarVisible, true);
		transcript.scrollTo(15);
		render();
		const wheel = (code: number) => {
			const box = render();
			f.terminal.input(`\x1b[<${code};2;${box.rect.y + 1}M`);
			render();
		};
		wheel(65);
		assert.ok(widget.scrollTop > 0);
		assert.equal(transcript.scrollTop, 15);
		for (let i = 0; i < 80; i++) wheel(65);
		assert.equal(transcript.scrollTop, 15);
		const bottom = widget.scrollTop;
		assert.match(getLayoutFrame(f.tui).lines.join("\n"), /Wheel scroll workflows/);
		f.terminal.input("\x1b[<64;2;2M");
		render();
		assert.equal(widget.scrollTop, bottom);
		assert.notEqual(transcript.scrollTop, 15);
		const shortcuts = resolveExtensionShortcuts(
			[extension],
			new KeybindingsManager().getEffectiveConfig(),
			true,
		).shortcuts;
		await shortcuts.get("alt+k")!.handler({} as never);
		render();
		assert.equal(widget.scrollTop, bottom - 1);
		f.terminal.input(" typed");
		render();
		assert.equal(f.context.editor.getText(), "draft intact typed");
		f.terminal.resize(100, 36);
		render();
		assert.equal(widget.maxHeight, 10);
		for (const id of ids.slice(1)) store.removeRun(id);
		await Promise.resolve();
		render();
		assert.equal(widget.scrollTop, 0);
		assert.equal(widget.isScrollbarVisible, false);
	} finally {
		for (const id of ids) store.removeRun(id);
		f.context.clearExtensionWidgets();
		f.resolveTheme();
		await f.initPromise;
		f.tui.stop();
		f.restoreOffline();
	}
});

test("remote workflow adapter synchronizes full content, wheel, shortcuts and fractional resize", async () => {
	const f = createProductionFullscreenContext({ columns: 100, rows: 36, transcriptLines: 60 });
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const messages: InteractiveEngineMessage[] = [];
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		assert.ok(message);
		messages.push(message);
		for (const listener of listeners) listener(message);
	}, new KeybindingsManager());
	const controller = new RemoteComponentController(
		{
			onGenerationEnded: () => () => {},
			onEngineMessage: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			sendEngineCommand: (command) => {
				assert.equal(service.handleLine(serializeInteractiveEngineFrame(command)), true);
			},
		},
		f.context.createExtensionUIContext(),
		{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
	);
	const remoteStore = createStore();
	for (let i = 0; i < 15; i++)
		remoteStore.recordRunStart({
			id: `remote-${i}`,
			name: "duplicate remote",
			status: "paused",
			startedAt: Date.now() + i,
			inputs: {},
			stages: [],
		});
	const dispose = installStoreWidget(
		{
			ui: {
				setWidget: (key, producer, options) =>
					service.setWidget(
						key,
						producer
							? (tui, theme) => {
									const component = producer(tui, theme);
									return {
										render: (width) => component.render(width),
										getScrollRequest: () => component.getScrollRequest?.(),
										onScroll: (state: WidgetScrollState) => component.onScroll?.(state),
										invalidate: () => component.invalidate?.(),
										dispose: () => component.dispose?.(),
									};
								}
							: undefined,
						options?.placement,
						options?.scroll,
					),
				requestRender: () => service.requestRender(),
			},
		},
		remoteStore,
	);
	const settle = async () => {
		for (let i = 0; i < 8; i++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			f.tui.renderNow();
		}
	};
	try {
		await settle();
		const widget = f.context.extensionWidgetsBelow.get("workflow.run");
		assert.ok(widget instanceof ScrollWidget);
		assert.equal(widget.maxHeight, 10);
		const frame = messages.findLast((message) => message.type === "engine_custom_frame");
		assert.ok(frame?.type === "engine_custom_frame" && frame.lines.length > 10);
		assert.match(frame.lines.at(-1)!, /Wheel scroll workflows/);
		assert.equal(frame.lines.at(-1)!.includes("1–4/4"), false);
		const box = boxFor(getLayoutFrame(f.tui).root, widget)!;
		f.terminal.input(`\x1b[<65;2;${box.rect.y + 1}M`);
		await settle();
		const position = widget.scrollTop;
		assert.ok(position > 0);
		scrollStoreWidget(remoteStore, 1);
		await settle();
		assert.equal(widget.scrollTop, position + 1);
		f.terminal.resize(100, 18);
		await settle();
		assert.equal(widget.maxHeight, 6);
		assert.equal(widget.scrollTop, position + 1);
		assert.equal(f.context.extensionWidgetsBelow.get("workflow.run"), widget);
		const before = widget.scrollTop;
		f.terminal.input("\x1b[<65;2;2M");
		await settle();
		assert.equal(widget.scrollTop, before);
	} finally {
		dispose();
		controller.dispose();
		service.dispose();
		f.context.clearExtensionWidgets();
		f.resolveTheme();
		await f.initPromise;
		f.tui.stop();
		f.restoreOffline();
	}
});
