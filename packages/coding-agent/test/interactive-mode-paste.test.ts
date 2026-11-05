import assert from "node:assert/strict";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, it, vi } from "vitest";
import type { HostCustomUiStateListener } from "../src/core/extensions/types.js";
import type { EditorFactory } from "../src/core/extensions/ui-types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

// A paste over 10 lines collapses into a marker whose content only the editor that received it can expand.
const COLLAPSED_MARKER = "[paste #1 +12 lines]";
const EXPANDED_DRAFT = Array.from({ length: 12 }, (_, i) => `draft ${i + 1}`).join("\n");

function collapsedEditor() {
	let text = COLLAPSED_MARKER;
	return Object.assign(new Text("editor"), {
		getText: () => text,
		getExpandedText: () => (text === COLLAPSED_MARKER ? EXPANDED_DRAFT : text),
		setText: vi.fn((next: string) => {
			text = next;
		}),
	});
}

// A custom editor an extension installs need not know paste markers, so it has no getExpandedText.
function plainEditor() {
	let text = "plain draft";
	return Object.assign(new Text("editor"), {
		getText: () => text,
		setText: vi.fn((next: string) => {
			text = next;
		}),
	});
}

type Prototype = Record<string, unknown>;

function bindToPrototype<T extends object>(target: T): T {
	const prototype = InteractiveMode.prototype as unknown as Prototype;
	return new Proxy(target, {
		get(object, key, receiver) {
			if (key in object) return Reflect.get(object, key, receiver);
			const value = prototype[key as string];
			return typeof value === "function" ? value.bind(receiver) : value;
		},
	});
}

describe("InteractiveMode keeps collapsed paste content when it moves a draft (pi #10146)", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		["the expanded draft", collapsedEditor, EXPANDED_DRAFT],
		["the draft of an editor without paste expansion", plainEditor, "plain draft"],
	] as const)("restores %s after an inline custom UI closes", async (_name, createEditor, draft) => {
		const editor = createEditor();
		const context = bindToPrototype({
			extensionDialogs: [] as { component: Component }[],
			editorContainer: new Container(),
			editor,
			ui: { setFocus: vi.fn(), requestRender: vi.fn(), hasOverlay: () => false },
			programStatus: { setBlocked: vi.fn() },
			disposeActiveSelector: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			blockingInlineCustomUiDepth: 0,
			navigationInlineCustomUiDepth: 0,
			deferredInlineCustomUiFocusDepth: 0,
			pendingInlineCustomUiFocus: undefined,
			hostCustomUiStateListeners: new Set<HostCustomUiStateListener>(),
		}) as unknown as {
			showExtensionCustom<T>(
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
			): Promise<T>;
		};
		let close: ((result: string) => void) | undefined;
		const shown = context.showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
			close = done;
			return new Text("custom");
		});
		await vi.waitFor(() => assert.ok(close));
		close?.("closed");
		assert.equal(await shown, "closed");

		assert.equal(editor.getText(), draft);
	});

	it.each([
		["the expanded draft", collapsedEditor, EXPANDED_DRAFT],
		["the draft of an editor without paste expansion", plainEditor, "plain draft"],
	] as const)("copies %s into a replacement editor", (_name, createEditor, draft) => {
		const replacement = { setText: vi.fn() };
		const factory: EditorFactory = () => replacement as never;
		const host = bindToPrototype({
			editorComponentFactory: undefined,
			extensionDialogs: [],
			activeSelectorToken: {},
			activeSelectorDispose: vi.fn(),
			editor: createEditor(),
			defaultEditor: {
				onSubmit: undefined,
				onChange: undefined,
				getPaddingX: () => 2,
				getAutocompleteMaxVisible: () => 5,
				actionHandlers: new Map(),
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			autocompleteProvider: undefined,
			keybindings: {},
		}) as unknown as { setCustomEditorComponent(factory: EditorFactory | undefined): void };

		host.setCustomEditorComponent(factory);

		assert.deepEqual(replacement.setText.mock.calls, [[draft]]);
	});

	it.each([
		["the expanded draft", collapsedEditor, EXPANDED_DRAFT],
		["the draft of an editor without paste expansion", plainEditor, "plain draft"],
	] as const)("keeps %s below restored queued messages", async (_name, createEditor, draft) => {
		const editor = createEditor();
		const host = bindToPrototype({
			editor,
			clearAllQueues: async () => ({ steering: [], followUp: ["queued follow-up"] }),
			updatePendingMessagesDisplay: vi.fn(),
		}) as unknown as { restoreQueuedMessagesToEditor(): Promise<number> };

		assert.equal(await host.restoreQueuedMessagesToEditor(), 1);

		assert.equal(editor.getText(), `queued follow-up\n\n${draft}`);
	});
});
