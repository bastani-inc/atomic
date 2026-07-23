import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, type KeyId } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.ts";
import { renderSubagentNotification } from "../../packages/subagents/src/extension/index.ts";
import { renderWebSearchResult } from "../../packages/web-access/result-renderers.ts";

const originalKeybindings = getKeybindings();

function installExpandBinding(binding?: KeyId | KeyId[]): void {
	setKeybindings(binding === undefined
		? new KeybindingsManager()
		: new KeybindingsManager({ "app.tools.expand": binding }));
}

function renderNotification(): string {
	const component = renderSubagentNotification({
		content: "",
		details: { agent: "scout", status: "completed", resultPreview: "one\ntwo" },
	}, { expanded: false }, theme);
	return stripAnsi(component.render(100).join("\n"));
}

function renderWebSearch(): string {
	const component = renderWebSearchResult({
		content: [{ type: "text", text: "one\ntwo\nthree\nfour" }],
		details: { queryCount: 1, successfulQueries: 1, totalResults: 4 },
	}, { expanded: false, isPartial: false }, theme);
	return stripAnsi(component.render(100).join("\n"));
}

beforeEach(() => {
	initTheme("dark");
	installExpandBinding();
});
afterEach(() => setKeybindings(originalKeybindings));

describe("subagent notification expand affordance", () => {
	test("uses the default effective expand key", () => {
		assert.match(renderNotification(), /ctrl\+o full notification/);
	});

	test("uses a custom effective expand key", () => {
		installExpandBinding("ctrl+x");
		const rendered = renderNotification();
		assert.match(rendered, /ctrl\+x full notification/);
		assert.doesNotMatch(rendered, /ctrl\+o/);
	});

	test("omits only the unavailable affordance when expansion is unbound", () => {
		installExpandBinding([]);
		const rendered = renderNotification();
		assert.match(rendered, /✓ scout completed/);
		assert.match(rendered, /⎿  one/);
		assert.doesNotMatch(rendered, /full notification|ctrl\+o|\(\s*\)/);
	});
});

describe("web-search collapsed line-count affordance", () => {
	test("uses the default effective expand key", () => {
		assert.match(renderWebSearch(), /\.\.\. \(3 more lines, 5 total, ctrl\+o Expand\)/);
	});

	test("uses a custom effective expand key", () => {
		installExpandBinding("ctrl+x");
		const rendered = renderWebSearch();
		assert.match(rendered, /\.\.\. \(3 more lines, 5 total, ctrl\+x Expand\)/);
		assert.doesNotMatch(rendered, /CTRL\+O|ctrl\+o/);
	});

	test("keeps exact line counts while omitting an unbound affordance", () => {
		installExpandBinding([]);
		const rendered = renderWebSearch();
		assert.match(rendered, /\.\.\. \(3 more lines, 5 total\)/);
		assert.doesNotMatch(rendered, /Expand|CTRL\+O|,\s*\)/);
	});
});
