/**
 * An extension shortcut that prefers the editor yields to the editor's own key for the same input, natively and through
 * the isolated engine; a legacy literal shortcut still overrides it. Ported from the retired workflow-widget scroll
 * tests (#5224), which exercised this policy through the workflow list's Alt+K/J shortcuts.
 */
import assert from "node:assert/strict";
import {
	getKeybindings,
	isKittyProtocolActive,
	type KeyId,
	matchesKey,
	setKeybindings,
	setKittyProtocolActive,
} from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { resolveExtensionShortcuts } from "../../packages/coding-agent/src/core/extensions/runner-shortcuts.js";
import type { Extension } from "../../packages/coding-agent/src/core/extensions/types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.js";
import { getEditorTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { attachInteractiveEngineHost } from "../../packages/coding-agent/src/modes/interactive-engine/extension-ui-bridge.js";
import { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.js";
import {
	type EngineKeybindingState,
	parseInteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import { createProductionFullscreenContext } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";

function literalExtension(shortcut: KeyId, preferEditor: boolean, handler: () => void): Extension {
	const extension: Extension = {
		path: "shortcut-fixture",
		resolvedPath: "shortcut-fixture",
		sourceInfo: { path: "shortcut-fixture", source: "test", scope: "temporary", origin: "top-level" },
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, preferEditor, handler });
	return extension;
}

test("editor-first shortcuts yield to modifier-order, shift+return and reserved escape equivalents", () => {
	for (const [shortcut, editor, action] of [
		["ctrl+alt+k", "alt+ctrl+k", "tui.editor.cursorUp"],
		["shift+return", "shift+enter", "tui.input.newLine"],
		["esc", "escape", "tui.select.cancel"],
	] as const) {
		const bindings = new KeybindingsManager({ [action]: editor }).getEffectiveConfig();
		const extension = literalExtension(shortcut, true, () => {});
		assert.equal(resolveExtensionShortcuts([extension], bindings, true).shortcuts.has(shortcut), false, shortcut);
	}
});

test("literal editor-first shortcuts yield to equivalent keys but legacy registrations still override", () => {
	const extension = literalExtension("ctrl+alt+k", false, () => {});
	const bindings = new KeybindingsManager({ "tui.editor.cursorUp": "alt+ctrl+k" }).getEffectiveConfig();
	assert.ok(resolveExtensionShortcuts([extension], bindings, true).shortcuts.has("ctrl+alt+k"));
	extension.shortcuts.get("ctrl+alt+k")!.preferEditor = true;
	assert.equal(resolveExtensionShortcuts([extension], bindings, true).shortcuts.has("ctrl+alt+k"), false);
});

test("unrelated extension shortcuts retain their existing editor-conflict policy", () => {
	const extension = literalExtension("alt+j", false, () => {});
	delete (extension.shortcuts.get("alt+j") as { preferEditor?: boolean }).preferEditor;
	const defaults = new KeybindingsManager().getEffectiveConfig();
	assert.equal(resolveExtensionShortcuts([extension], defaults, true).diagnostics.length, 0);
	const vim = { ...defaults, "tui.editor.cursorDown": "alt+j" as KeyId };
	const legacy = resolveExtensionShortcuts([extension], vim, true);
	assert.ok(legacy.shortcuts.has("alt+j"));
	assert.equal(legacy.diagnostics.length, 1);
	extension.shortcuts.get("alt+j")!.preferEditor = true;
	assert.equal(resolveExtensionShortcuts([extension], vim, true).shortcuts.has("alt+j"), false);
});

const sharedInputs: {
	shortcut: KeyId;
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
	{ shortcut: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u" },
	{ shortcut: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", defaults: true },
	{ shortcut: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", kitty: true },
	{ shortcut: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", windows: true, ssh: true },
	{ shortcut: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", literal: true },
	{ shortcut: "ctrl+h", editor: "backspace", bytes: "\b", explicit: "\x1b[104;5u", literal: false },
	{ shortcut: "ctrl+h", editor: "ctrl+backspace", bytes: "\b", explicit: "\x1b[27;5;104~", windows: true },
	{ shortcut: "backspace", editor: "ctrl+h", bytes: "\b", explicit: "\x1b[127u" },
	{ shortcut: "ctrl+i", editor: "tab", bytes: "\t", explicit: "\x1b[105;5u" },
	{ shortcut: "ctrl+m", editor: "enter", bytes: "\r", explicit: "\x1b[109;5u" },
	{ shortcut: "ctrl+i", editor: "tab", action: "tui.input.tab", bytes: "\t", explicit: "\x1b[105;5u" },
	{ shortcut: "ctrl+m", editor: "enter", action: "tui.input.submit", bytes: "\r", explicit: "\x1b[109;5u" },
	{ shortcut: "ctrl+j", editor: "enter", bytes: "\n", explicit: "\x1b[106;5u" },
	{ shortcut: "ctrl+j", editor: "shift+enter", bytes: "\n", explicit: "\x1b[106;5u", kitty: true },
	{ shortcut: "ctrl+[", editor: "escape", bytes: "\x1b", explicit: "\x1b[91;5u" },
	{ shortcut: "ctrl+-", editor: "ctrl+_", bytes: "\x1f", explicit: "\x1b[45;5u" },
	{ shortcut: "ctrl+_", editor: "ctrl+-", bytes: "\x1f", explicit: "\x1b[95;5u" },
	{ shortcut: "ctrl+alt+h", editor: "alt+backspace", bytes: "\x1b\b", explicit: "\x1b[104;7u" },
	{ shortcut: "ctrl+alt+m", editor: "alt+enter", bytes: "\x1b\r", explicit: "\x1b[109;7u" },
	{ shortcut: "alt+b", editor: "alt+left", bytes: "\x1bb", explicit: "\x1b[98;3u" },
	{ shortcut: "alt+f", editor: "alt+right", bytes: "\x1bf", explicit: "\x1b[102;3u" },
	{ shortcut: "alt+p", editor: "alt+up", bytes: "\x1bp", explicit: "\x1b[112;3u" },
	{ shortcut: "alt+n", editor: "alt+down", bytes: "\x1bn", explicit: "\x1b[110;3u" },
	{ shortcut: "ctrl+alt+k", editor: "alt+ctrl+k", bytes: "\x1b[107;7u" },
	{ shortcut: "shift+return", editor: "shift+enter", bytes: "\x1b[13;2u" },
	{ shortcut: "esc", editor: "escape", bytes: "\x1b" },
];

for (const route of ["native", "remote"])
	for (const scenario of sharedInputs)
		test(`${route}: ${scenario.shortcut}/${scenario.editor} ${JSON.stringify(scenario)}`, async () => {
			const f = createProductionFullscreenContext({ columns: 100, rows: 30 });
			const previous = getKeybindings();
			const previousKitty = isKittyProtocolActive();
			let disposeRemote: (() => void) | undefined;
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				let fired = 0;
				const extension = literalExtension(scenario.shortcut, scenario.literal ?? true, () => {
					fired++;
				});
				// Isolate this configured editor action from defaults that also accept the input.
				const empty = Object.fromEntries(
					Object.keys(new KeybindingsManager().getEffectiveConfig()).map((action) => [action, []]),
				);
				const bindings = new KeybindingsManager({
					...(scenario.defaults ? {} : empty),
					[scenario.action ?? "tui.editor.deleteCharBackward"]: scenario.editor,
				});
				const rawBindings = JSON.stringify(bindings.getUserBindings());
				setKittyProtocolActive(scenario.kitty ?? false);
				vi.stubEnv("WT_SESSION", scenario.windows ? "fixture" : "");
				for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) vi.stubEnv(name, "");
				if (scenario.ssh) vi.stubEnv("SSH_CONNECTION", "fixture");
				assert.ok(matchesKey(scenario.bytes, scenario.shortcut));
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
				assert.equal(fired, sharedScroll);
				if (scenario.explicit) {
					assert.ok(matchesKey(scenario.explicit, scenario.shortcut));
					assert.equal(matchesKey(scenario.explicit, scenario.editor), false);
					f.terminal.input(scenario.explicit);
					f.tui.renderNow();
					assert.equal(editor.getText(), expectedDraft);
					assert.equal(fired, sharedScroll + 1);
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
				f.resolveTheme();
				await f.initPromise;
				f.tui.stop();
				f.restoreOffline();
			}
		});
