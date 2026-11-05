import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { GitUnavailableError, WorkspaceSnapshotError } from "../src/core/worktree-snapshot/errors.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

const plain = (container: Container): string[] =>
	container.children.flatMap((child) => child.render(200)).map((line) => stripVTControlCharacters(line).trimEnd());

describe("editor submit routing", () => {
	test("another slash command is not taken for /session snapshot", async () => {
		const calls: string[] = [];
		const host = {
			firstSubmitRecorded: true,
			startupReplayActiveInput: undefined,
			startupReplayInputs: [] as string[],
			runtimeHost: {},
			defaultEditor: {} as { onSubmit?: (text: string) => Promise<void> },
			editor: {
				setText: (text: string) => calls.push(`setText(${JSON.stringify(text)})`),
				addToHistory() {},
			},
			handleToolsCommand: async () => {
				calls.push("tools");
			},
			handleSessionSnapshotCommand: async () => {
				calls.push("snapshot");
			},
		};
		(
			InteractiveMode.prototype as unknown as { setupEditorSubmitHandler(this: typeof host): void }
		).setupEditorSubmitHandler.call(host);
		await host.defaultEditor.onSubmit?.("/tools");
		assert.deepEqual(calls, ['setText("")', "tools"]);
	});
});

describe("resuming from the TUI", () => {
	type ResumeHost = {
		sessionManager: object;
		statusContainer: Container;
		settingsManager: { getClearOnShrink(): boolean };
		firstRunNoticeVisible: boolean;
		ensureDeferredStartupComplete(): Promise<void>;
		clearWorkingLoader(): void;
		renderCurrentSessionState(): void;
		startSessionRecovery(): void;
		showStatus(message: string): void;
		showWarning(message: string): void;
		showError(message: string): void;
		handleFatalRuntimeError(message: string, error: unknown): Promise<{ cancelled: boolean }>;
		runtimeHost: { switchSession(): Promise<{ cancelled: boolean }> };
	};
	const handleResumeSession = (
		InteractiveMode.prototype as unknown as {
			handleResumeSession(this: ResumeHost, id: string): Promise<{ cancelled: boolean }>;
		}
	).handleResumeSession;

	function resumeHost(failure: Error) {
		const errors: string[] = [];
		const fatal: Array<[string, unknown]> = [];
		const host: ResumeHost = {
			sessionManager: { getBranch: () => [], getWorktreeSnapshotRecords: () => new Map() },
			statusContainer: new Container(),
			settingsManager: { getClearOnShrink: () => false },
			firstRunNoticeVisible: false,
			ensureDeferredStartupComplete: async () => {},
			clearWorkingLoader() {},
			renderCurrentSessionState() {},
			startSessionRecovery() {},
			showStatus() {},
			showWarning() {},
			showError: (message) => errors.push(message),
			handleFatalRuntimeError: async (message, error) => {
				fatal.push([message, error]);
				return { cancelled: true };
			},
			runtimeHost: {
				switchSession: async () => {
					throw failure;
				},
			},
		};
		return { host, errors, fatal };
	}

	test("an error that is not about the workspace is a fatal resume error, not a message on the session", async () => {
		const failure = new Error("the session file is unreadable");
		const { host, errors, fatal } = resumeHost(failure);
		await handleResumeSession.call(host, "any-session");
		assert.deepEqual(errors, []);
		assert.deepEqual(fatal, [["Failed to resume session", failure]]);
	});

	test("a workspace failure and an unavailable Git are shown as messages and keep the current session", async () => {
		for (const failure of [
			new WorkspaceSnapshotError("not-a-repository", "/tmp/gone"),
			new GitUnavailableError("not-installed", "git"),
		]) {
			const { host, errors, fatal } = resumeHost(failure);
			assert.deepEqual(await handleResumeSession.call(host, "any-session"), { cancelled: true });
			assert.deepEqual(errors, [failure.message]);
			assert.deepEqual(fatal, []);
		}
	});
});

describe("/session snapshot for a checkout that does not hold the snapshot's tree", () => {
	type SnapshotHost = {
		sessionManager: SessionManager;
		settingsManager: { getWorktreeSnapshotSettings(): typeof DEFAULT_WORKTREE_SNAPSHOT_SETTINGS };
		chatContainer: Container;
		ui: { requestRender(): void };
		showStatus(message: string): void;
	};
	const snapshotCommand = (
		InteractiveMode.prototype as unknown as { handleSessionSnapshotCommand(this: SnapshotHost): Promise<void> }
	).handleSessionSnapshotCommand;

	test("says that it differs and shows no diff, while the checkout that holds the tree still gets its own", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
		const stranger = await sandbox.remoteWithClone("stranger", { "a.txt": "unrelated\n" });
		writeFileSync(join(clone, "a.txt"), "twelve\n");
		const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
		const store = await SqlSessionStore.open(database);
		cleanups.push(async () => {
			await store.close();
			await database.close();
		});
		const manager = await SessionManager.create(store, clone);
		const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") throw new Error("unreachable");
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		await manager.appendWorktreeSnapshot(stranger.clone, capture.snapshot.id);
		writeFileSync(join(clone, "a.txt"), "changed since\n");

		const host: SnapshotHost = {
			sessionManager: manager,
			settingsManager: { getWorktreeSnapshotSettings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS },
			chatContainer: new Container(),
			ui: { requestRender() {} },
			showStatus() {},
		};
		await snapshotCommand.call(host);
		const lines = plain(host.chatContainer);
		const strangerAt = lines.indexOf(` ${stranger.clone}`);
		assert.ok(strangerAt >= 0, "the second checkout is listed");
		const strangerBlock = lines.slice(strangerAt);
		const differs = strangerBlock.findIndex((line) => line.startsWith("   differs from the current tree"));
		assert.ok(differs > 0);
		assert.equal(strangerBlock.slice(differs + 1).length, 0, "nothing follows the verdict: no diff can be shown");
		const cloneBlock = lines.slice(lines.indexOf(` ${clone}`), strangerAt);
		assert.ok(cloneBlock.some((line) => /a\.txt \| 2 \+-/.test(line)));
	});
});
