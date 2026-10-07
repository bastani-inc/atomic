import assert from "node:assert/strict";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { McpManagerView } from "../src/extensions/mcp/ui.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ESCAPE = "\x1b";
const tui = { requestRender: vi.fn() } as TUI;

function rendered(view: McpManagerView): string {
	return stripAnsi(view.render(80).join("\n"));
}

describe("MCP manager status screen", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("cancels the running operation with the cancel key", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const onCancel = vi.fn();
		view.status("Sign in to issues", "Contacting the authorization server…", onCancel);
		assert.match(rendered(view), /cancel/);
		view.handleInput(ESCAPE);
		assert.equal(onCancel.mock.calls.length, 1);
	});

	test("ignores the cancel key for operations that cannot be cancelled", () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		view.status("Sign in to issues", "Connecting…");
		assert.doesNotMatch(rendered(view), /cancel/);
		view.handleInput(ESCAPE);
	});
});
