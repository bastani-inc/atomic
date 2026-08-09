import { expect, test, vi } from "vitest";
import type { EditorFactory } from "../src/core/extensions/ui-types.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-extension-dialogs.ts";

type CustomEditorHarness = {
	editorComponentFactory: EditorFactory | undefined;
	editor: { getText: () => string };
	defaultEditor: {
		onSubmit: undefined;
		onChange: undefined;
		borderColor: string;
		getPaddingX: () => number;
		getAutocompleteMaxVisible: () => number;
		actionHandlers: Map<string, () => void>;
	};
	editorContainer: { clear: () => void; addChild: (editor: unknown) => void };
	ui: { setFocus: (editor: unknown) => void; requestRender: () => void };
	autocompleteProvider: undefined;
	keybindings: unknown;
};

const setCustomEditorComponent = InteractiveModeBase.prototype.setCustomEditorComponent as unknown as (
	this: CustomEditorHarness,
	factory: EditorFactory | undefined,
) => void;

test("custom editors inherit the default autocomplete dropdown limit", () => {
	const cancelRefresh = vi.fn();
	const setAutocompleteMaxVisible = vi.fn();
	const customEditor = {
		setText: vi.fn(),
		setAutocompleteMaxVisible,
	};
	// Linked to the real prototype: `setCustomEditorComponent` tears the active
	// selector down through `this.disposeActiveSelector()`, so the receiver has to
	// resolve inherited behavior instead of stubbing it away.
	const harness: CustomEditorHarness = Object.assign(Object.create(InteractiveModeBase.prototype), {
		editorComponentFactory: undefined,
		activeSelectorToken: {},
		activeSelectorDispose: cancelRefresh,
		editor: { getText: () => "draft" },
		defaultEditor: {
			onSubmit: undefined,
			onChange: undefined,
			borderColor: "accent",
			getPaddingX: () => 2,
			getAutocompleteMaxVisible: () => 11,
			actionHandlers: new Map(),
		},
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		autocompleteProvider: undefined,
		keybindings: {},
	});
	const factory: EditorFactory = () => customEditor as never;

	setCustomEditorComponent.call(harness, factory);

	expect(setAutocompleteMaxVisible).toHaveBeenCalledWith(11);
	expect(cancelRefresh).toHaveBeenCalledTimes(1);
});
