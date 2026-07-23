import { test } from "bun:test";
import assert from "node:assert/strict";
import { getKeybindings, Key, type KeyId, parseKey, setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { routeGlobalClearInput } from "../../packages/coding-agent/src/modes/interactive/interactive-global-clear.ts";
import { ExtensionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

/**
 * pi-tui exposes key parsing (raw bytes -> KeyId) but no encoder, so tests
 * define the raw terminal sequences once and validate them against pi-tui's
 * own parser instead of trusting hardcoded bytes.
 */
function rawKeyData(sequence: string, keyId: KeyId): string {
	assert.equal(parseKey(sequence), keyId, `fixture must encode ${keyId}`);
	return sequence;
}

const CTRL_C = rawKeyData("\u0003", Key.ctrl("c"));
const ESCAPE = rawKeyData("\u001b", Key.escape);

function makeOptions(overrides: Partial<{
	hasOverlay: boolean;
	blockingInlineCustomUiActive: boolean;
	editorOwnsInput: boolean;
}> = {}) {
	const keybindings = new KeybindingsManager();
	const state = { clears: 0 };
	const options = {
		matchesClear: (candidate: string) => keybindings.matches(candidate, "app.clear"),
		hasOverlay: () => overrides.hasOverlay ?? false,
		blockingInlineCustomUiActive: () => overrides.blockingInlineCustomUiActive ?? false,
		editorOwnsInput: () => overrides.editorOwnsInput ?? true,
		onClear: () => { state.clears += 1; },
		requestRender: () => {},
	};
	return { options, state };
}

test("global clear consumes ctrl+c only while the editor owns input", () => {
	const editorOwned = makeOptions({ editorOwnsInput: true });
	assert.deepEqual(routeGlobalClearInput(CTRL_C, editorOwned.options), { consume: true });
	assert.equal(editorOwned.state.clears, 1);

	const popupOwned = makeOptions({ editorOwnsInput: false });
	assert.equal(routeGlobalClearInput(CTRL_C, popupOwned.options), undefined);
	assert.equal(popupOwned.state.clears, 0, "ctrl+c must reach the focused popup instead of the global clear handler");
});

test("global clear guards are evaluated live, not at registration time", () => {
	let overlay = false;
	let editorOwns = true;
	const keybindings = new KeybindingsManager();
	let clears = 0;
	const options = {
		matchesClear: (candidate: string) => keybindings.matches(candidate, "app.clear"),
		hasOverlay: () => overlay,
		blockingInlineCustomUiActive: () => false,
		editorOwnsInput: () => editorOwns,
		onClear: () => { clears += 1; },
		requestRender: () => {},
	};

	assert.deepEqual(routeGlobalClearInput(CTRL_C, options), { consume: true });
	assert.equal(clears, 1);

	editorOwns = false; // a /login popup replaced the editor
	assert.equal(routeGlobalClearInput(CTRL_C, options), undefined);
	assert.equal(clears, 1);

	editorOwns = true;
	overlay = true; // a real TUI overlay is on screen
	assert.equal(routeGlobalClearInput(CTRL_C, options), undefined);
	assert.equal(clears, 1);
});

test("a single ctrl+c cancels the login auth-method selector once input reaches it", () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	// ExtensionSelectorComponent reads the global theme at construction time.
	// Initialize it here so this file does not depend on another test file
	// having called initTheme() earlier in the same process (file execution
	// order is not stable across platforms).
	initTheme("dark");
	try {
		let cancelled = 0;
		const selector = new ExtensionSelectorComponent(
			"Select authentication method:",
			["Use a subscription", "Use an API key"],
			() => {},
			() => { cancelled += 1; },
		);
		// With the fix, the deferred global handler lets the focused selector
		// receive the raw ctrl+c byte; tui.select.cancel binds escape AND ctrl+c.
		selector.handleInput(CTRL_C);
		assert.equal(cancelled, 1, "ctrl+c must cancel the selector exactly like escape");

		const viaEscape = new ExtensionSelectorComponent(
			"Select authentication method:",
			["Use a subscription", "Use an API key"],
			() => {},
			() => { cancelled += 1; },
		);
		viaEscape.handleInput(ESCAPE);
		assert.equal(cancelled, 2);
	} finally {
		setKeybindings(previous);
	}
});
