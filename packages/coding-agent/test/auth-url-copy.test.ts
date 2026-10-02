import assert from "node:assert/strict";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { McpManagerView } from "../src/extensions/mcp/ui.js";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const { copyToClipboard } = vi.hoisted(() => ({ copyToClipboard: vi.fn(async (_text: string) => {}) }));
vi.mock("../src/utils/clipboard.js", () => ({ copyToClipboard }));
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

const AUTH_URL = `https://auth.example.invalid/authorize?${"x".repeat(300)}`;
const CTRL_X = "\x18";
const tui = { requestRender: vi.fn() } as TUI;

function rendered(component: { render(width: number): string[] }): string {
	return stripAnsi(component.render(80).join("\n"));
}

describe("sign-in URL copy key", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		copyToClipboard.mockReset();
	});

	test("login dialog copies the auth URL without changing the code input", async () => {
		const dialog = new LoginDialogComponent(tui, "test", () => {});
		dialog.showAuth(AUTH_URL);
		const input = dialog.showManualInput("Paste the code:");
		assert.match(rendered(dialog), /ctrl\+x to copy/);
		dialog.handleInput("code");
		dialog.handleInput(CTRL_X);
		await vi.waitFor(() => assert.match(rendered(dialog), /Copied URL to clipboard/));
		assert.deepEqual(copyToClipboard.mock.calls, [[AUTH_URL]]);
		dialog.handleInput("\r");
		assert.equal(await input, "code");
	});

	test("login dialog clears the copy target for device codes and details", () => {
		const dialog = new LoginDialogComponent(tui, "test", () => {});
		dialog.showAuth(AUTH_URL);
		dialog.showDeviceCode({ userCode: "ABCD", verificationUri: "https://example.invalid/device" });
		dialog.handleInput(CTRL_X);
		dialog.showAuth(AUTH_URL);
		dialog.showDetails(["Finished"]);
		dialog.handleInput(CTRL_X);
		assert.equal(copyToClipboard.mock.calls.length, 0);
	});

	test("MCP sign-in copies the authorization URL and preserves redirect input", async () => {
		const view = new McpManagerView(tui, theme, new KeybindingsManager());
		const result = view.redirectUrl("Sign in to issues", AUTH_URL, new AbortController().signal);
		assert.match(rendered(view), /ctrl\+x to copy/);
		view.handleInput(CTRL_X);
		await vi.waitFor(() => assert.match(rendered(view), /Copied URL to clipboard/));
		assert.deepEqual(copyToClipboard.mock.calls, [[AUTH_URL]]);
		view.handleInput("http://localhost/callback?code=abc");
		view.handleInput("\r");
		assert.equal(await result, "http://localhost/callback?code=abc");
	});

	test("copy key respects custom bindings and reports clipboard failure", async () => {
		setKeybindings(new KeybindingsManager({ "app.auth.copyUrl": "ctrl+y" }));
		copyToClipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"));
		const dialog = new LoginDialogComponent(tui, "test", () => {});
		dialog.showAuth(AUTH_URL);
		assert.match(rendered(dialog), /ctrl\+y to copy/);
		dialog.handleInput(CTRL_X);
		assert.equal(copyToClipboard.mock.calls.length, 0);
		dialog.handleInput("\x19");
		await vi.waitFor(() => assert.match(rendered(dialog), /Clipboard unavailable/));
	});
});
