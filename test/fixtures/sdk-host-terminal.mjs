import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, SettingsManager } from "@bastani/atomic";
import { Container, ProcessTerminal, TuiMainScreen } from "@bastani/atomic-tui";

// #3105: dedicated terminal probe, actual CLI dialog methods and keyboard/rendering.
assert.ok(process.stdin.isTTY && process.stdout.isTTY);
const built = new URL("./modes/interactive/", import.meta.resolve("@bastani/atomic"));
const { InteractiveModeBase } = await import(new URL("interactive-mode-base.js", built));
const { initTheme } = await import(new URL("theme/theme.js", built));
await import(new URL("interactive-extension-context.js", built));
await import(new URL("interactive-extension-dialogs.js", built));
await import(new URL("interactive-selectors.js", built));
initTheme("dark");
const ui = new TuiMainScreen(new ProcessTerminal());
const editor = new Container();
const editorContainer = new Container();
ui.addChild(editorContainer);
const mode = Object.assign(Object.create(InteractiveModeBase.prototype), { ui, editor, editorContainer });
const cwd = mkdtempSync(join(tmpdir(), "atomic-host-terminal-"));
const { session } = await createAgentSession({
	cwd, agentDir: join(cwd, "agent"),
	sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(),
	builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
	extensionBindings: { uiContext: mode.createExtensionUIContext() },
});
let receipt;
try {
	ui.start();
	const context = session.extensionRunner.createContext();
	const text = await context.ui.input("Slice D: enter terminal-proof");
	assert.equal(text, "terminal-proof");
	const approved = await context.ui.confirm("Slice D", "Approve this dedicated terminal dialog?");
	assert.equal(approved, true);
	const declined = await context.ui.confirm("Slice D", "Select No to verify refusal");
	assert.equal(declined, false);
	receipt = { host: "built-cli-terminal", text, approved, declined };
} finally {
	ui.stop();
	await session.dispose();
	rmSync(cwd, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt));
