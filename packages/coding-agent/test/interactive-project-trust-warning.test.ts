import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-render-chat.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const TRUST_WARNING = "This project is not trusted.";

let projectDir: string;

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "atomic-trust-warning-"));
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeProjectSettings(): void {
	mkdirSync(join(projectDir, ".atomic"));
	writeFileSync(join(projectDir, ".atomic", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
}

async function renderInitialChat(projectTrusted: boolean): Promise<string> {
	return (await renderLiveChat({ trusted: projectTrusted })).text();
}

/** Renders the initial messages, then repaints the chat on demand as the session's trust state changes. */
async function renderLiveChat(state: { trusted: boolean; pending?: boolean }): Promise<{ text(): string }> {
	const chatContainer = new Container();
	const mode = {
		chatContainer,
		session: {},
		ui: { requestRender: vi.fn() },
		attachStartupNoticesContainer: vi.fn(),
		renderSessionEntries: vi.fn(),
		runtimeHost: { isProjectTrustPending: () => state.pending === true },
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => [],
			getLeafId: () => null,
			getCwd: () => projectDir,
		},
		settingsManager: { isProjectTrusted: () => state.trusted },
	};
	InteractiveModeBase.prototype.renderInitialMessages.call(mode as never);
	await vi.waitFor(() =>
		expect(chatContainer.children.some((child) => child instanceof Container && child.children.length === 0)).toBe(
			false,
		),
	);
	return {
		text: () => {
			chatContainer.invalidate();
			return stripTerminalSequences(chatContainer.render(200).join("\n"));
		},
	};
}

test("warns that untrusted project settings are ignored", async () => {
	writeProjectSettings();

	const chat = await renderInitialChat(false);

	expect(chat).toContain(TRUST_WARNING);
	expect(chat).toContain("Project .atomic resources and packages are ignored. Use /trust");
});

test("does not warn once the project is trusted", async () => {
	writeProjectSettings();

	expect(await renderInitialChat(true)).not.toContain(TRUST_WARNING);
});

test("does not warn for a project without trust-gated resources", async () => {
	expect(await renderInitialChat(false)).not.toContain(TRUST_WARNING);
});

// The interactive host learns its engine's trust decision after it rendered the chat.
test("the warning follows the session's trust after the chat was rendered", async () => {
	writeProjectSettings();
	const state = { trusted: true };
	const chat = await renderLiveChat(state);
	expect(chat.text()).not.toContain(TRUST_WARNING);

	state.trusted = false;
	expect(chat.text()).toContain(TRUST_WARNING);

	state.trusted = true;
	expect(chat.text()).not.toContain(TRUST_WARNING);
});

test("does not warn while the session's trust decision is still to be made", async () => {
	writeProjectSettings();
	const state = { trusted: false, pending: true };
	const chat = await renderLiveChat(state);
	expect(chat.text()).not.toContain(TRUST_WARNING);

	state.pending = false;
	expect(chat.text()).toContain(TRUST_WARNING);
});
