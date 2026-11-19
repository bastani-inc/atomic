/**
 * Every key hint is clickable by construction: the shared hint builders mark each key they name with the key a click
 * presses, and a hint written as text anywhere in the shipped sources must go through one of them. A new hint that
 * skips the builders fails here, so it cannot ship without its click.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	type HintAction,
	readHintSpans,
	setKeybindings,
	stripHintMarkers,
	stripTerminalSequences,
} from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	keyHint,
	keyHintIfBound,
	keyTextHint,
	parenthesizedKeyHint,
	rawKeyHint,
} from "../../packages/coding-agent/src/modes/interactive/components/keybinding-hints.js";
import { mainComposerHints } from "../../packages/coding-agent/src/modes/interactive/components/main-composer-keys.js";
import {
	clickableHintText,
	type NavKey,
	type NavKeyStyle,
	renderAutocompleteHintLine,
	renderNavHintLine,
	renderNavKeyOverlay,
} from "../../packages/coding-agent/src/modes/interactive/components/nav-keys.js";
import { taskChatKeys } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { TreeHelp } from "../../packages/coding-agent/src/modes/interactive/components/tree-selector-help.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { moduleDir } from "../helpers/runtime.js";

const plainStyle: NavKeyStyle = {
	dim: (text) => text,
	text: (text) => text,
	muted: (text) => text,
	border: (text) => text,
	bold: (text) => text,
};

beforeAll(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});

/** What a click on each column of `line` runs, as `key`/`/command` names, and the line as the terminal shows it. */
function clicksOf(line: string): { text: string; at: (column: number) => string | undefined } {
	const { spans } = readHintSpans(line);
	const name = (action: HintAction) => (action.kind === "key" ? action.key : action.command);
	return {
		text: stripTerminalSequences(line),
		at: (column) => {
			const span = spans.find((candidate) => column >= candidate.start && column < candidate.end);
			return span === undefined ? undefined : name(span.action);
		},
	};
}

/** Every column of every ` · `-separated hint in `line` runs something, except the separators and the indent. */
function assertEveryHintClickable(line: string, label: string): void {
	const { text, at } = clicksOf(line);
	let column = 0;
	for (const segment of text.split(" · ")) {
		const lead = segment.length - segment.trimStart().length;
		const end = segment.trimEnd().length;
		for (let index = lead; index < end; index++) {
			assert.ok(at(column + index) !== undefined, `${label}: column ${column + index} of "${text}" runs nothing`);
		}
		column += segment.length + " · ".length;
	}
}

describe("the shared hint builders mark every key they name", () => {
	test("keyHint, keyHintIfBound, parenthesizedKeyHint and rawKeyHint press the keys they show", () => {
		assertEveryHintClickable(keyHint("app.tools.expand", "expand"), "keyHint");
		assertEveryHintClickable(keyHintIfBound("tui.select.cancel", "cancel"), "keyHintIfBound");
		const plain = clicksOf(keyTextHint("tui.select.cancel", "Cancel"));
		assert.equal(plain.text, "esc/ctrl+c Cancel", "keyTextHint adds no style of its own");
		assert.deepEqual([plain.at(0), plain.at(5), plain.at(12)], ["escape", "ctrl+c", "ctrl+c"]);
		const raw = clicksOf(rawKeyHint("↑↓", "navigate"));
		assert.deepEqual([raw.at(0), raw.at(1), raw.at(5)], ["up", "down", "down"]);
		const parenthesized = clicksOf(parenthesizedKeyHint("app.tools.expand", "to expand", "20 more lines"));
		assert.equal(parenthesized.at(parenthesized.text.indexOf("ctrl+o")), "ctrl+o");
		assert.equal(parenthesized.at(parenthesized.text.indexOf("20")), undefined, "the count around it is not a key");
	});

	test("hint lines and the ? overlay press the key of the half clicked", () => {
		const keys = new KeybindingsManager();
		const entries: NavKey[] = [
			{ keys: "pgup/pgdn", label: "scroll" },
			{ keys: "esc/←", label: "close" },
			{ keys: "↵", label: "open" },
			{ action: "app.keys.help", label: "keys" },
		];
		const line = renderNavHintLine(entries, 120, plainStyle, keys);
		assertEveryHintClickable(line, "renderNavHintLine");
		const { text, at } = clicksOf(line);
		assert.deepEqual(
			[at(text.indexOf("pgup")), at(text.indexOf("pgdn")), at(text.indexOf("scroll"))],
			["pageUp", "pageDown", "pageDown"],
		);
		assert.equal(at(text.indexOf("↵")), "enter");
		for (const chat of [renderNavHintLine(taskChatKeys("main chat", true, true, true), 160, plainStyle, keys)])
			assertEveryHintClickable(chat, "chat hint line");
		const overlay = renderNavKeyOverlay("keys", entries, 60, plainStyle, keys);
		const close = overlay.find((row) => stripHintMarkers(row).includes("close this help"));
		assert.ok(close !== undefined);
		const closeClicks = clicksOf(close);
		assert.equal(closeClicks.at(closeClicks.text.indexOf("esc")), "escape");
		const autocomplete = renderAutocompleteHintLine(
			[
				{ actions: ["tui.select.up", "tui.select.down"], label: "select" },
				{ actions: ["tui.input.tab"], label: "complete" },
			],
			80,
			keys,
			plainStyle,
		);
		assertEveryHintClickable(autocomplete, "autocomplete hint line");
	});

	test("shortening a remapped key in help keeps the visible shortcut and its label clickable (#5528)", () => {
		const key = "ctrl+shift+alt+super+o";
		const row = renderNavKeyOverlay("keys", [{ action: "app.tools.expand", label: "expand" }], 80, plainStyle, {
			matches: () => false,
			getKeys: () => [key],
		})[1]!;
		const { text, at } = clicksOf(row);
		assert.ok(text.includes("..."));
		assert.equal(at(text.indexOf("ctrl")), key);
		assert.equal(at(text.indexOf("expand")), key);
		assert.equal(at(text.indexOf("...")), undefined);
	});

	test("a hint written as text marks its keys and its slash command", () => {
		assertEveryHintClickable(clickableHintText("↑↓ select · ↵ open stage chat · esc close"), "switcher hint");
		assertEveryHintClickable(clickableHintText("Enter / Esc back"), "spaced alternatives");
		const tasks = clicksOf(clickableHintText("2 shells · /tasks to manage"));
		assert.equal(tasks.at(tasks.text.indexOf("/tasks")), "/tasks");
		assert.equal(tasks.at(0), undefined, "a count is not a key");
	});

	test("a slash shortcut in text is distinct from a slash command and from separators (#5528)", () => {
		const single = clicksOf(clickableHintText("/ choose · /tasks to manage", ["/"]));
		assert.equal(single.at(single.text.indexOf("choose")), "/");
		assert.equal(single.at(single.text.indexOf("manage")), "/tasks");
		const alternatives = clicksOf(clickableHintText("esc///+/-/,/space choose", ["/", "+", "-", ","]));
		for (const [atColumn, key] of [
			[0, "escape"],
			[4, "/"],
			[6, "+"],
			[8, "-"],
			[10, ","],
			[12, "space"],
			[18, "space"],
		] as const) {
			assert.equal(alternatives.at(atColumn), key);
		}
	});

	test("compact tree shortcuts keep the slash key distinct from the slash between actions (#5528)", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.up": "/", "tui.select.down": "+" }));
		try {
			const line = clicksOf(new TreeHelp().render(200)[0]!);
			const start = line.text.indexOf("//+ move");
			assert.notEqual(start, -1);
			assert.deepEqual(
				[line.at(start), line.at(start + 1), line.at(start + 2), line.at(start + 4)],
				["/", "/", "+", "+"],
			);
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	test("the main chat's hints mark ↓ agents, /tasks and ? keys", () => {
		const keys = new KeybindingsManager();
		for (const segment of mainComposerHints(keys, { agentRows: 2 })) assertEveryHintClickable(segment, segment);
		const tasks = mainComposerHints(keys, { agentRows: 0, shells: 2 }).find((segment) =>
			stripHintMarkers(segment).startsWith("/tasks"),
		);
		assert.ok(tasks !== undefined);
		assert.equal(clicksOf(tasks).at(0), "/tasks");
	});
});

const repositoryRoot = join(moduleDir(import.meta.url), "../..");
const SHIPPED_SOURCES = [
	"coding-agent/src",
	"workflows/src",
	"subagents/src",
	"tui/src",
	"intercom",
	"mcp",
	"web-access",
].map((path) => join(repositoryRoot, "packages", path));

/** A key, or alternatives of keys, as hints name them. */
const KEY = String.raw`(?:esc|enter|tab|space|pgup|pgdn|↵|↑↓|↑|↓|←|→|ctrl\+\S|alt\+\S|shift\+tab)`;
/** Text that reads as a key hint: a key followed by what it does, or a slash command followed by `to ...`. */
const HINT_TEXT = new RegExp(
	String.raw`(?:^|·\s|\(|\s{2})(?:${KEY}(?:/${KEY})*\s+(?:to\s+)?[a-z]{3,}|/(?:tasks|agents|workflows)\s+to\s+[a-z])`,
	"iu",
);
/** Calls that draw a hint with its click: a line holding one of these, or near one, draws through it. */
const BUILDERS =
	/\b(?:clickableHintText|clickableKeyTextHint|clickableKeysHint|clickableHint|slashCommandHint|rawKeyHint|keyHint|keyHintIfBound|keyTextHint|parenthesizedKeyHint|renderNavHintLine|localKeyHint|graphRawKeyHint|graphKeyHint)\(/;
/** A `NavKey` entry: hint lines and the `?` overlay draw these through the builders. */
const NAV_KEY_ENTRY = /\b(?:keys|label|action)\s*:/;

/**
 * Text that reads like a hint but is not one a click can run, by file and the text it holds, with why.
 */
const NOT_HINTS: ReadonlyArray<{ readonly file: string; readonly text: RegExp; readonly why: string }> = [
	{
		file: "packages/coding-agent/src/modes/interactive/interactive-input-handling.ts",
		text: /esc cancel first/,
		why: "a warning sentence shown for a moment, not a hint row",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/components/chat-session-host-actions.ts",
		text: /esc cancel first/,
		why: "a warning sentence shown for a moment, not a hint row",
	},
	{
		file: "packages/workflows/src/tui/node-card.ts",
		text: /enter to respond/,
		why: "drawn inside a stage's card in the graph: a click on the card selects and opens that card, as a row does",
	},
	{
		file: "packages/coding-agent/src/core/tools/ask-user-question/view/dialog-builder.ts",
		text: /^(?:↑↓ select|enter choose|enter\/space toggle|enter\/esc close notes|tab next question|tab questions|esc cancel)$/,
		why: "parts the question dialog joins into its hint row, which it draws through clickableHintText",
	},
	{
		file: "packages/workflows/src/tui/switcher.ts",
		text: /(?:select|stage chat|tool detail|close)/,
		why: "the switcher's hint rows, which it draws through clickableHintText",
	},
	{
		file: "packages/workflows/src/tui/run-outcome.ts",
		text: /^enter /,
		why: "a blocker's action line, drawn through clickableHintText under the selected blocker",
	},
	{
		file: "packages/workflows/src/extension/workflow-durable-resume-command.ts",
		text: /enter resume with the new definition/,
		why: "the changed-definition prompt's line, drawn through clickableHintText",
	},
	{
		file: "packages/subagents/src/tui/agent-browser.ts",
		text: /(?:scroll|select|details|close|back)/,
		why: "the agent browser's hint row, drawn through clickableHintText",
	},
	{
		file: "packages/coding-agent/src/main.ts",
		text: /ctrl\+p cycle/,
		why: "printed to the shell at startup, outside the fullscreen view",
	},
	{
		file: "packages/coding-agent/src/core/slash-commands.ts",
		text: /ctrl\+p cycling/,
		why: "a command's description in the / menu, which is a menu row",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/components/settings-selector-items.ts",
		text: /(?:enter while streaming|pressing esc twice|\$\{followUpKey\} queues follow-up messages)/,
		why: "a setting's description, which is prose",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/components/trust-decision-selector.ts",
		text: /with ↑↓ and Enter/,
		why: "a sentence explaining how to answer, not a hint row",
	},
	{
		file: "packages/coding-agent/src/core/provider-composer-internal.ts",
		text: /^Enter API key/,
		why: "a field's title asking for a key to be typed in",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/components/login-dialog.ts",
		text: /^Enter code:/,
		why: "an instruction to type a code in the browser",
	},
	{
		file: "packages/coding-agent/src/core/tasks/agent-panel-rules.ts",
		text: /^\/tasks to /,
		why: "worded here; the chats' hint rows draw it through slashCommandHint",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/components/task-heartbeat-message.ts",
		text: /^\/tasks to inspect$/,
		why: "a heartbeat notice's inspect hint, which the heartbeat block draws through slashCommandHint",
	},
	{
		file: "packages/coding-agent/src/modes/interactive/components/jump-to-latest.ts",
		text: /jump to bottom/,
		why: "the jump-to-latest pill, which the renderer already makes clickable: a click on it jumps to the latest",
	},
	{
		file: "packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts",
		text: /Esc interrupt · Ctrl\+C terminate/,
		why: "part of a diagnostic message that is also written to the log, which must stay plain text",
	},
	{
		file: "packages/workflows/src/tui/tool-detail.ts",
		text: /\$\{expandKey\} Expand\)$/,
		why: "the unstyled text of a tool's detail, which carries no escape sequences; the graph draws it with its theme, through clickableKeysHint",
	},
	{
		file: "packages/workflows/src/tui/stage-chat-view-footer-status.ts",
		text: /^ ?(?:· )?\$\{backKey\} graph$/,
		why: "the plain text of the return-to-graph hint, used to find and measure it; it is drawn through clickableKeysHint",
	},
	{
		file: "packages/workflows/src/tui/node-card.ts",
		text: /^↑ blocked$/,
		why: "↑ points at the stage that blocks this one; it is not a key",
	},
	{
		file: "packages/workflows/src/tui/run-detail.ts",
		text: /^↑ blocked$/,
		why: "↑ points at the stage that blocks this one; it is not a key",
	},
];

function sourceFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		if (statSync(path).isDirectory())
			return ["node_modules", "dist", "test", "tests"].includes(entry) ? [] : sourceFiles(path);
		return /\.ts$/.test(entry) && !/\.(?:test|d)\.ts$/.test(entry) ? [path] : [];
	});
}

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

test("every hint written as text in the shipped sources is drawn through a hint builder", () => {
	const unrouted: string[] = [];
	for (const file of SHIPPED_SOURCES.flatMap(sourceFiles)) {
		const path = relative(repositoryRoot, file).replaceAll("\\", "/");
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
			for (const literal of line.match(STRING_LITERAL) ?? []) {
				const content = literal.slice(1, -1);
				if (!HINT_TEXT.test(content)) continue;
				const nearby = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
				if (BUILDERS.test(nearby) || NAV_KEY_ENTRY.test(line)) continue;
				if (NOT_HINTS.some((entry) => entry.file === path && entry.text.test(content))) continue;
				unrouted.push(`${path}:${index + 1}: ${content}`);
			}
		});
	}
	assert.deepEqual(
		unrouted,
		[],
		"Draw these hints through clickableHintText, keyHint or another hint builder so a click runs them, or list " +
			"them in NOT_HINTS with the reason they are not hints:\n" +
			unrouted.join("\n"),
	);
});

/** Calls that return the text of a key, such as `esc/ctrl+c`, without the key a click on it presses. */
const KEY_TEXT_CALL = String.raw`(?:keyText|keyDisplayText|formatKeyText|formatKeys|navKeyText|navActionText|getKeys)\(`;
/** A variable that holds the text of a key, such as `key`, `keys` or `openKey`. */
const KEY_TEXT_NAME = String.raw`(?:[a-z]\w*(?:Key|Keys|KeyText|KeyLabel)|key|keys)`;
/** An interpolated expression that is the plain text of a key. */
const KEY_TEXT_EXPRESSION = new RegExp(
	String.raw`^(?:(?:[\w.]+\.)?${KEY_TEXT_CALL}.*\)|(?:[\w.]+\.)?${KEY_TEXT_NAME}(?:\(\))?)$`,
	"s",
);
/** What follows a key in a hint: what it does, such as ` Cancel`, ` to manage`, `: Send` or ` again`. */
const WHAT_IT_DOES = String.raw`:?\s+(?:to\s+(?:\$\{|[a-z])|[A-Za-z]{3,})`;
/** An interpolation in a template literal: `${...}`, with up to one level of braces inside it. */
const INTERPOLATION = /\$\{((?:[^{}]|\{[^{}]*\})*)\}/g;
/** Key text joined to what it does with `+`, such as `keyText("tui.select.cancel") + " cancel"`. */
const KEY_TEXT_CONCATENATION = new RegExp(
	String.raw`(?:\b${KEY_TEXT_CALL}[^;+]*\)|\b${KEY_TEXT_NAME})\s*\+\s*["'\`]${WHAT_IT_DOES}`,
);
/** A file that reads key bindings or builds hints, where a variable named for a key holds a key's text. */
const FORMATS_KEYS = new RegExp(String.raw`\b(?:${KEY_TEXT_CALL}|getKeybindings\(|clickable\w*Hint\(|hintKeyParts\()`);

/** The key text a template literal draws as a hint without a builder, by the `${...}` it interpolates. */
function interpolatedKeyHints(literal: string, keyNames: boolean): string[] {
	if (!literal.startsWith("`")) return [];
	const found: string[] = [];
	for (const match of literal.matchAll(INTERPOLATION)) {
		const expression = match[1]!.trim();
		if (!KEY_TEXT_EXPRESSION.test(expression)) continue;
		if (!keyNames && !new RegExp(String.raw`^(?:[\w.]+\.)?${KEY_TEXT_CALL}`).test(expression)) continue;
		const after = literal.slice(match.index + match[0].length);
		const before = literal.slice(0, match.index);
		// What the key does follows it, or the key stands alone in parentheses, as `(ctrl+o)` does.
		if (new RegExp(`^${WHAT_IT_DOES}`).test(after) || (before.endsWith("(") && after.startsWith(")")))
			found.push(match[0]);
	}
	return found;
}

test("key text interpolated or concatenated into a hint is drawn through a hint builder", () => {
	const unrouted: string[] = [];
	for (const file of SHIPPED_SOURCES.flatMap(sourceFiles)) {
		const path = relative(repositoryRoot, file).replaceAll("\\", "/");
		const source = readFileSync(file, "utf8");
		const keyNames = FORMATS_KEYS.test(source);
		source.split("\n").forEach((line, index) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
			const found: string[] = [];
			for (const match of line.matchAll(STRING_LITERAL)) {
				// A template literal passed to a builder on its line is drawn through it.
				if (BUILDERS.test(line.slice(0, match.index))) continue;
				if (interpolatedKeyHints(match[0], keyNames).length > 0) found.push(match[0].slice(1, -1));
			}
			const concatenated = KEY_TEXT_CONCATENATION.exec(line);
			if (concatenated && (keyNames || new RegExp(`^${KEY_TEXT_CALL}`).test(concatenated[0])))
				found.push(concatenated[0]);
			for (const content of found) {
				if (NOT_HINTS.some((entry) => entry.file === path && entry.text.test(content))) continue;
				unrouted.push(`${path}:${index + 1}: ${content}`);
			}
		});
	}
	assert.deepEqual(
		unrouted,
		[],
		"Draw these keys through clickableKeyTextHint, keyHint or another hint builder so a click presses them, " +
			"or list them in NOT_HINTS with the reason they are not hints:\n" +
			unrouted.join("\n"),
	);
});
