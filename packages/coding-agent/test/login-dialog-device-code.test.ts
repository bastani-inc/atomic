import assert from "node:assert/strict";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { copyToClipboard } from "../src/utils/clipboard.js";
import { openBrowser } from "../src/utils/open-browser.js";

vi.mock("../src/utils/clipboard.js", () => ({ copyToClipboard: vi.fn() }));
vi.mock("../src/utils/open-browser.js", () => ({ openBrowser: vi.fn() }));

const device = { userCode: "ABCD-EFGH", verificationUri: "https://example.com/device" };

function createDialog() {
	const onComplete = vi.fn();
	const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "custom-provider", onComplete);
	dialog.focused = true;
	return { dialog, onComplete };
}

function render(dialog: LoginDialogComponent): string {
	return stripAnsi(dialog.render(120).join("\n"));
}

describe("device-code login (pi #9282)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(copyToClipboard).mockResolvedValue(undefined);
		setKeybindings(new KeybindingsManager());
	});

	it("opens the verification page and copies the code once after confirmation", async () => {
		const { dialog } = createDialog();
		const domain = dialog.showPrompt("GitHub Enterprise URL/domain (blank for github.com)");
		dialog.handleInput("\r");
		assert.equal(await domain, "");
		dialog.showDeviceCode(device);
		dialog.showWaiting("Waiting for authentication...");
		assert.ok(render(dialog).includes("to open browser and copy code"));
		assert.equal(vi.mocked(openBrowser).mock.calls.length, 0);
		assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);

		dialog.handleInput("\r");
		await Promise.resolve();
		dialog.handleInput("\r");
		assert.deepEqual(vi.mocked(openBrowser).mock.calls, [[device.verificationUri]]);
		assert.deepEqual(vi.mocked(copyToClipboard).mock.calls, [[device.userCode]]);
		assert.ok(render(dialog).includes("Code copied to clipboard"));
		assert.ok(render(dialog).includes(`Enter code: ${device.userCode}`));
		assert.ok(render(dialog).includes("Waiting for authentication..."));
		assert.ok(!render(dialog).includes("to open browser and copy code"));
	});

	for (const [openBrowserOnConfirm, copyCodeOnConfirm] of [
		[false, false],
		[true, false],
		[false, true],
	] as const) {
		it(`honors browser=${openBrowserOnConfirm} / clipboard=${copyCodeOnConfirm} provider overrides`, async () => {
			const { dialog } = createDialog();
			dialog.showDeviceCode({ ...device, openBrowserOnConfirm, copyCodeOnConfirm });
			dialog.handleInput("\r");
			await Promise.resolve();
			assert.equal(vi.mocked(openBrowser).mock.calls.length, openBrowserOnConfirm ? 1 : 0);
			assert.equal(vi.mocked(copyToClipboard).mock.calls.length, copyCodeOnConfirm ? 1 : 0);
			assert.equal(dialog.signal.aborted, false);
		});
	}

	it("clears the previous auth URL copy action when showing a device code", () => {
		const { dialog } = createDialog();
		dialog.showAuth("https://example.com/authorize");
		vi.mocked(openBrowser).mockClear();
		dialog.showDeviceCode(device);
		dialog.handleInput("\x18");
		assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
		assert.equal(vi.mocked(openBrowser).mock.calls.length, 0);
		dialog.handleInput("\r");
		assert.deepEqual(vi.mocked(copyToClipboard).mock.calls, [[device.userCode]]);
	});

	it("clears device actions when switching to browser authentication", () => {
		const { dialog } = createDialog();
		dialog.showDeviceCode(device);
		dialog.showAuth("https://example.com/authorize");
		vi.mocked(openBrowser).mockClear();
		dialog.handleInput("\r");
		assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
		assert.equal(vi.mocked(openBrowser).mock.calls.length, 0);
		dialog.handleInput("\x18");
		assert.deepEqual(vi.mocked(copyToClipboard).mock.calls, [["https://example.com/authorize"]]);
	});

	it("clears both action types when showing details", () => {
		const { dialog } = createDialog();
		dialog.showAuth("https://example.com/authorize");
		dialog.showDetails(["Choose a login method"]);
		dialog.handleInput("\x18");
		assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
		dialog.showDeviceCode(device);
		dialog.showDetails(["Choose a login method"]);
		vi.mocked(openBrowser).mockClear();
		dialog.handleInput("\r");
		assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
		assert.equal(vi.mocked(openBrowser).mock.calls.length, 0);
	});

	it("cancels without opening a browser or changing the clipboard", () => {
		const { dialog, onComplete } = createDialog();
		dialog.showDeviceCode(device);
		dialog.handleInput("\x1b");
		dialog.handleInput("\r");
		assert.equal(dialog.signal.aborted, true);
		assert.deepEqual(vi.mocked(onComplete).mock.calls, [[false, "Login cancelled"]]);
		assert.equal(vi.mocked(openBrowser).mock.calls.length, 0);
		assert.equal(vi.mocked(copyToClipboard).mock.calls.length, 0);
	});

	it("keeps manual login available when browser and clipboard access fail", async () => {
		vi.mocked(openBrowser).mockImplementation(() => {
			throw new Error("Browser unavailable");
		});
		vi.mocked(copyToClipboard).mockRejectedValue(new Error("Clipboard unavailable"));
		const { dialog, onComplete } = createDialog();
		dialog.showDeviceCode(device);
		dialog.showWaiting("Waiting for authentication...");
		assert.doesNotThrow(() => dialog.handleInput("\r"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(vi.mocked(openBrowser).mock.calls, [[device.verificationUri]]);
		assert.deepEqual(vi.mocked(copyToClipboard).mock.calls, [[device.userCode]]);
		assert.ok(render(dialog).includes(device.verificationUri));
		assert.ok(render(dialog).includes(`Enter code: ${device.userCode}`));
		assert.ok(render(dialog).includes("Copy code manually"));
		assert.ok(render(dialog).includes("Waiting for authentication..."));
		assert.equal(dialog.signal.aborted, false);
		assert.equal(vi.mocked(onComplete).mock.calls.length, 0);
	});
});

describe("login URLs (pi 89c921d8)", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.resetAllMocks();
		setKeybindings(new KeybindingsManager());
	});

	it("opens only http(s) sign-in URLs", () => {
		const { dialog } = createDialog();
		dialog.showAuth("file:///Users/victim/Downloads/payload.app");
		assert.equal(vi.mocked(openBrowser).mock.calls.length, 0);

		dialog.showAuth("https://example.com/authorize");
		assert.deepEqual(vi.mocked(openBrowser).mock.calls, [["https://example.com/authorize"]]);
	});

	it("keeps control characters in URLs from ending terminal hyperlinks", () => {
		const { dialog } = createDialog();
		dialog.showDeviceCode({ ...device, verificationUri: "https://example.com/device\x07\x1b]52;c;Zm9v\x07" });
		dialog.showInfo("Docs", [{ label: "Help", url: "https://example.com/help\x07\x1b]52;c;Zm9v\x07" }]);
		const output = dialog.render(120).join("\n");

		assert.ok(!output.includes("\x1b]52"));
		assert.ok(render(dialog).includes("https://example.com/device%07%1B]52;c;Zm9v"));
		assert.ok(render(dialog).includes("Help: https://example.com/help%07%1B]52;c;Zm9v"));
	});

	it("replaces control characters in URLs that are not web URLs", () => {
		const injected = "x\x07\x1b]52;c;Zm9v\x07";
		const { dialog } = createDialog();
		dialog.showAuth(`file:///tmp/${injected}`);
		assert.ok(!dialog.render(120).join("\n").includes("\x1b]52"));

		dialog.showDeviceCode({ ...device, verificationUri: injected });
		assert.ok(!dialog.render(120).join("\n").includes("\x1b]52"));
		assert.ok(render(dialog).includes("x ]52;c;Zm9v"));

		dialog.showInfo("Docs", [{ label: "Help", url: injected }]);
		assert.ok(!dialog.render(120).join("\n").includes("\x1b]52"));
		assert.ok(render(dialog).includes("Help: x ]52;c;Zm9v"));
		assert.equal(vi.mocked(openBrowser).mock.calls.length, 0);
	});
});
