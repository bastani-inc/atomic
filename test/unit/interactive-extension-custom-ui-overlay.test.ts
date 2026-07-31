import assert from "node:assert/strict";
import { test } from "vitest";
import { InteractiveModeBase } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-custom-ui.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { sleep } from "../helpers/runtime.js";

initTheme("dark");

/**
 * Overlay close must target the overlay that is closing, not whatever happens to
 * be on top. During engine-death teardown an unrelated native overlay can sit
 * above an engine-owned one, and a generic top-overlay call would dismiss the
 * native dialog instead.
 *
 * The inline path has a matching fence: it must not pull focus away from an
 * overlay that is still up.
 */
interface CustomUiStub {
	mode: InteractiveModeBase;
	handleHides: number;
	genericHides: number;
	focused: unknown[];
	inline: unknown[];
	overlayVisible: boolean;
}

function makeStub(options?: { overlayStaysUp?: boolean }): CustomUiStub {
	const editor = {
		getText: () => "saved draft",
		setText: () => {},
	};
	const state = {
		handleHides: 0,
		genericHides: 0,
		focused: [] as unknown[],
		inline: [editor] as unknown[],
		overlayVisible: false,
	};
	const host = {
		editor,
		keybindings: {},
		editorContainer: {
			clear: () => {
				state.inline.length = 0;
			},
			addChild: (child: unknown) => {
				state.inline.push(child);
			},
			get children(): unknown[] {
				return state.inline;
			},
		},
		ui: {
			showOverlay: () => {
				state.overlayVisible = true;
				return {
					hide: () => {
						state.handleHides += 1;
						state.overlayVisible = options?.overlayStaysUp === true;
					},
					setHidden: () => {},
					isHidden: () => false,
					focus: () => {},
					unfocus: () => {},
					isFocused: () => true,
				};
			},
			hideOverlay: () => {
				state.genericHides += 1;
				state.overlayVisible = false;
			},
			hasOverlay: () => state.overlayVisible,
			setFocus: (component: unknown) => {
				state.focused.push(component);
			},
			requestRender: () => {},
		},
		shouldDeferInlineCustomUiFocus: () => false,
		pendingInlineCustomUiFocus: undefined,
		notifyHostCustomUiStateListeners: () => {},
		beginHostInlineCustomUi: () => () => {},
		beginInlineCustomUiFocusDeferral: () => () => {},
	};
	return Object.assign(state, { mode: host as unknown as InteractiveModeBase }) as CustomUiStub;
}

const COMPONENT = { render: () => ["x"], handleInput: () => {}, invalidate: () => {} };

test("closing an overlay custom UI hides that exact overlay, not the top one", async () => {
	const stub = makeStub();
	let done!: (result: unknown) => void;
	const settled = InteractiveModeBase.prototype.showExtensionCustom.call(
		stub.mode,
		(_tui: unknown, _theme: unknown, _keys: unknown, complete: (result: unknown) => void) => {
			done = complete;
			return COMPONENT;
		},
		{ overlay: true },
	);
	await sleep(0);
	done(undefined);
	await settled;
	assert.equal(stub.handleHides, 1, "the overlay's own handle must be used");
	assert.equal(stub.genericHides, 0, "the generic top-overlay call would close an unrelated overlay");
});

test("an inline custom UI restores the editor but never takes focus from a surviving overlay", async () => {
	// A native overlay is still up when the inline layer closes.
	const stub = makeStub({ overlayStaysUp: true });
	stub.overlayVisible = true;
	let done!: (result: unknown) => void;
	const settled = InteractiveModeBase.prototype.showExtensionCustom.call(
		stub.mode,
		(_tui: unknown, _theme: unknown, _keys: unknown, complete: (result: unknown) => void) => {
			done = complete;
			return COMPONENT;
		},
		{ overlay: false },
	);
	await sleep(0);
	done(undefined);
	await settled;
	assert.equal(stub.inline.length, 1, "the editor is remounted");
	assert.deepEqual(stub.focused, [COMPONENT], "only the mount focused; close must not pull focus");
	assert.notEqual(stub.focused.at(-1), stub.mode.editor, "focus must stay with the surviving overlay");
});

test("an inline custom UI focuses the editor when nothing else owns input", async () => {
	const stub = makeStub();
	let done!: (result: unknown) => void;
	const settled = InteractiveModeBase.prototype.showExtensionCustom.call(
		stub.mode,
		(_tui: unknown, _theme: unknown, _keys: unknown, complete: (result: unknown) => void) => {
			done = complete;
			return COMPONENT;
		},
		{ overlay: false },
	);
	await sleep(0);
	done(undefined);
	await settled;
	assert.equal(stub.focused.length, 2, "the component is focused on mount and the editor on close");
	assert.equal(stub.focused.at(-1), stub.mode.editor);
});
