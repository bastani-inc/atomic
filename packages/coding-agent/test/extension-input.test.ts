import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const originalKeybindings = getKeybindings();
beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));
afterEach(() => setKeybindings(originalKeybindings));

test("shows the extension input placeholder only while empty without submitting it (#3672)", () => {
	const placeholder = "expected-placeholder-example";
	const submitted: string[] = [];
	const input = new ExtensionInputComponent("Question", placeholder, (value) => submitted.push(value), assert.fail);
	const rendered = () => input.render(80).map(stripTerminalSequences).join("\n");

	assert.ok(rendered().includes(placeholder));
	input.handleInput("\r");
	assert.deepEqual(submitted, [""]);

	input.handleInput("answer");
	assert.ok(!rendered().includes(placeholder));
	assert.ok(rendered().includes("answer"));
	input.handleInput("\r");
	assert.deepEqual(submitted, ["", "answer"]);

	input.handleInput("\x15");
	assert.ok(rendered().includes(placeholder));
	input.handleInput("\r");
	assert.deepEqual(submitted, ["", "answer", ""]);
});
