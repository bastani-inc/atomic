import assert from "node:assert/strict";
import { setKeybindings } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { TrustDecisionSelector } from "../src/modes/interactive/components/trust-decision-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

test("keeps line breaks within a guarded startup draft without trailing separators (#5241)", () => {
	const drafts: string[] = [];
	const selector = new TrustDecisionSelector(
		new ExtensionSelectorComponent(
			"Choice",
			["No"],
			() => {},
			() => {},
		),
		(draft) => drafts.push(draft),
	);
	for (const key of ["abc", "\r", "def", "\n", "\r"]) selector.handleInput(key);
	selector.dispose();
	assert.deepEqual(drafts, ["abc\ndef"]);
});

test.each([
	["draftx", "draft"],
	["draft🦊", "draft"],
	["draft\ud83e", "draft"],
	["draft\udd8a", "draft"],
])("backspace removes one complete code point from the startup draft %j (#5241)", (text, expected) => {
	for (const key of ["\b", "\x7f"]) {
		const drafts: string[] = [];
		const selector = new TrustDecisionSelector(
			new ExtensionSelectorComponent(
				"Trust project folder?",
				["Do not trust"],
				() => {},
				() => {},
			),
			(draft) => drafts.push(draft),
		);

		selector.handleInput(`\x1b[200~${text}\x1b[201~`);
		selector.handleInput(key);
		selector.dispose();

		assert.deepEqual(drafts, [expected]);
	}
});

test.each([
	["Kitty CSI-u", ["\x1b[104u", "\x1b[105u"], "hi"],
	["Kitty keypad", ["\x1b[57400u"], "1"],
	["modifyOtherKeys", ["\x1b[27;2;72~"], "H"],
] as const)("keeps %s text as a draft without answering the startup question (#5241)", (_protocol, keys, expected) => {
	const answers: string[] = [];
	const drafts: string[] = [];
	const selector = new TrustDecisionSelector(
		new ExtensionSelectorComponent(
			"Trust project folder?",
			["Do not trust"],
			(answer) => answers.push(answer),
			() => {},
		),
		(draft) => drafts.push(draft),
	);

	for (const key of keys) selector.handleInput(key);
	selector.handleInput("\r");
	assert.deepEqual(answers, []);

	selector.handleInput("\x1b[A");
	selector.handleInput("\r");
	selector.dispose();
	assert.deepEqual(answers, ["Do not trust"]);
	assert.deepEqual(drafts, [expected]);
});

test.each([
	["CSI-u control bytes", "a\x1b[106;5ub", "a\nb"],
	["ESC and BEL", "a\x1bb\x07c", "abc"],
	["OSC printable text", "a\x1b]0;title\x07b", "a]0;titleb"],
	["line endings and tabs", "a\r\nb\rc\td", "a\nb\nc    d"],
])("normalizes pasted %s like the editor before keeping a startup draft (#5241)", (_kind, pasted, expected) => {
	const answers: string[] = [];
	const drafts: string[] = [];
	const selector = new TrustDecisionSelector(
		new ExtensionSelectorComponent(
			"Trust project folder?",
			["Do not trust"],
			(answer) => answers.push(answer),
			() => {},
		),
		(draft) => drafts.push(draft),
	);

	selector.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	selector.handleInput("\r");
	assert.deepEqual(answers, []);
	selector.dispose();
	assert.deepEqual(drafts, [expected]);
});

test("drops trailing blank lines of a long pasted startup draft in linear time (#5241)", () => {
	const drafts: string[] = [];
	const selector = new TrustDecisionSelector(
		new ExtensionSelectorComponent(
			"Trust project folder?",
			["Do not trust"],
			() => {},
			() => {},
		),
		(draft) => drafts.push(draft),
	);
	const blankLines = "\n".repeat(100_000);
	selector.handleInput(`\x1b[200~${blankLines}x${blankLines}\x1b[201~`);
	const started = performance.now();
	selector.dispose();
	const elapsed = performance.now() - started;
	assert.deepEqual(drafts, [`${blankLines}x`]);
	assert.ok(elapsed < 1000, `dispose took ${elapsed.toFixed(0)} ms`);
}, 60_000);
