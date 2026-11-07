import assert from "node:assert/strict";
import { Container } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { showResumeNotices } from "../src/modes/interactive/interactive-startup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { missingGit } from "./helpers/missing-git.ts";

useTemporaryAgentDir();

initTheme("dark");

function rendered(container: Container): string {
	return container
		.render(200)
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

test("resume notices stay on screen after the chat rebuild that follows deferred startup (#4329)", () => {
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, {
		chatContainer: new Container(),
		resourceDisclosureContainer: new Container(),
		startupNoticesContainer: new Container(),
		ui: { requestRender() {} },
		renderSessionEntries() {},
	});
	Object.defineProperty(mode, "sessionManager", { value: { getEntries: () => [], getLeafId: () => null } });
	mode.attachStartupNoticesContainer();
	mode.showStatus("transient status written to the chat");
	showResumeNotices(mode, [
		{ type: "info", message: "Restored worktree snapshot 0123456789ab of /node-a/repo into /node-b/wt" },
		{ type: "warning", message: "The restored snapshot left out 1 item(s): .env (denied)" },
	]);

	mode.rebuildChatFromMessages();

	const screen = rendered(mode.chatContainer);
	assert.match(screen, /Restored worktree snapshot 0123456789ab of \/node-a\/repo into \/node-b\/wt/);
	assert.match(screen, /Warning: The restored snapshot left out 1 item\(s\): \.env \(denied\)/);
	assert.doesNotMatch(screen, /Warning: Restored worktree/);
	assert.doesNotMatch(screen, /transient status written to the chat/);
});

test("a startup without resume notices shows none (#4329)", () => {
	const startupNoticesContainer = new Container();
	const warnings: string[] = [];
	showResumeNotices({ startupNoticesContainer, showWarning: (message: string) => warnings.push(message) }, undefined);
	assert.equal(startupNoticesContainer.children.length, 0);
	assert.deepEqual(warnings, []);
});

test("/resume shows a resume failure and stays open, but hands any other failure to the fatal-error path (#4329)", async () => {
	const errors: string[] = [];
	const fatal: [string, unknown][] = [];
	let failure: Error = new Error("not a resume failure");
	const host = {
		statusContainer: new Container(),
		settingsManager: { getClearOnShrink: () => false },
		ensureDeferredStartupComplete: async () => {},
		clearWorkingLoader() {},
		showError: (message: string) => errors.push(message),
		handleFatalRuntimeError: async (title: string, error: unknown) => {
			fatal.push([title, error]);
			return { cancelled: true };
		},
		runtimeHost: {
			switchSession: async () => {
				throw failure;
			},
		},
	};
	const handleResumeSession = (
		InteractiveMode.prototype as unknown as {
			handleResumeSession(this: typeof host, id: string): Promise<{ cancelled: boolean }>;
		}
	).handleResumeSession;

	await handleResumeSession.call(host, "abc");
	assert.deepEqual(fatal, [["Failed to resume session", failure]]);
	assert.deepEqual(errors, []);

	failure = missingGit();
	assert.deepEqual(await handleResumeSession.call(host, "abc"), { cancelled: true });
	assert.deepEqual(errors, [failure.message]);
	assert.equal(fatal.length, 1);
});
