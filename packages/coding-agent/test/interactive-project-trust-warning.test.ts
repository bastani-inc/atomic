import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-deferred-startup.ts";
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

/**
 * Renders the initial messages. `refresh` is what the interactive host does when it learns a new trust state for the
 * session, and `rebuild` redraws the chat from its messages, as deferred startup and /reload do.
 */
async function renderLiveChat(state: {
	trusted: boolean;
	pending?: boolean;
}): Promise<{ text(): string; refresh(): Promise<void>; rebuild(): Promise<void> }> {
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
	const settled = () =>
		vi.waitFor(() =>
			expect(chatContainer.children.some((child) => child instanceof Container && child.children.length === 0)).toBe(
				false,
			),
		);
	InteractiveModeBase.prototype.renderInitialMessages.call(mode as never);
	await settled();
	return {
		text: () => {
			chatContainer.invalidate();
			return stripTerminalSequences(chatContainer.render(200).join("\n"));
		},
		refresh: async () => {
			InteractiveModeBase.prototype.refreshProjectTrustWarning.call(mode as never);
			await settled();
		},
		rebuild: async () => {
			InteractiveModeBase.prototype.rebuildChatFromMessages.call(mode as never);
			await settled();
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
	await chat.refresh();
	expect(chat.text()).toContain(TRUST_WARNING);

	state.trusted = true;
	await chat.refresh();
	expect(chat.text()).not.toContain(TRUST_WARNING);
});

test("does not warn while the session's trust decision is still to be made", async () => {
	writeProjectSettings();
	const state = { trusted: false, pending: true };
	const chat = await renderLiveChat(state);
	expect(chat.text()).not.toContain(TRUST_WARNING);

	state.pending = false;
	await chat.refresh();
	expect(chat.text()).toContain(TRUST_WARNING);
});

// Startup that asked whether to trust the project redraws the chat once it has the answer, and so does /reload.
test("a chat redrawn from its messages keeps the warning", async () => {
	writeProjectSettings();
	const chat = await renderLiveChat({ trusted: false });

	await chat.rebuild();

	expect(chat.text()).toContain(TRUST_WARNING);
});

/**
 * Runs the deferred startup of a session that runs in the interactive host itself, as for a folder with no saved
 * decision: the chat is drawn while the decision is still to be made, then extensions start, then the decision is made.
 * The runtime reports the decision pending until it is made, fails, or startup gives it up.
 */
async function runFailedDeferredStartup(failure: {
	bind?: Error;
	decision?: Error;
}): Promise<{ text(): string; errors: string[] }> {
	let pending = true;
	const chatContainer = new Container();
	const errors: string[] = [];
	const mode = {
		options: {},
		chatContainer,
		resourceDisclosureContainer: new Container(),
		startupNoticesContainer: new Container(),
		ui: { requestRender: vi.fn() },
		deferredStartupPending: true,
		attachStartupNoticesContainer: vi.fn(),
		renderSessionEntries: vi.fn(),
		bindCurrentSessionExtensions: async () => {
			if (failure.bind) throw failure.bind;
		},
		stopWorkingLoader() {},
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		startSessionRecovery() {},
		showError: (message: string) => errors.push(message),
		refreshProjectTrustWarning: InteractiveModeBase.prototype.refreshProjectTrustWarning,
		runtimeHost: {
			isProjectTrustPending: () => pending,
			abandonStartupTrust: () => {
				pending = false;
			},
			completeStartup: async () => {
				pending = false;
				if (failure.decision) throw failure.decision;
				return true;
			},
		},
		session: { _getToolStatusWithoutGit: () => ({ missing: [] }) },
		sessionManager: {
			getSessionId: () => "session-1",
			getEntries: () => [],
			getLeafId: () => null,
			getCwd: () => projectDir,
			buildSessionContext: () => ({ messages: [] }),
		},
		settingsManager: { isProjectTrusted: () => false },
	};
	InteractiveModeBase.prototype.renderInitialMessages.call(mode as never);
	await InteractiveModeBase.prototype.completeDeferredStartup.call(mode as never);
	return {
		errors,
		text: () => {
			chatContainer.invalidate();
			return stripTerminalSequences(chatContainer.render(200).join("\n"));
		},
	};
}

// Startup fails without redrawing the chat, and the session stays untrusted.
test("a startup whose trust answer cannot be saved shows the warning", async () => {
	writeProjectSettings();

	const chat = await runFailedDeferredStartup({
		decision: new Error("EISDIR: illegal operation on a directory, read"),
	});

	expect(chat.errors).toEqual([expect.stringContaining("Extension loading failed: EISDIR")]);
	await vi.waitFor(() => expect(chat.text()).toContain(TRUST_WARNING));
});

// Extensions start before the decision is made. When one fails, no decision comes, and the session stays untrusted.
test("a startup whose extensions fail before the trust decision shows the warning", async () => {
	writeProjectSettings();

	const chat = await runFailedDeferredStartup({ bind: new Error("Extension startup failed: broken.ts: boom") });

	expect(chat.errors).toEqual([expect.stringContaining("Extension loading failed: Extension startup failed")]);
	await vi.waitFor(() => expect(chat.text()).toContain(TRUST_WARNING));
});
