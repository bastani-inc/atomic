import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	currentWorktreeSnapshots,
	formatWorktreeRestoreNotice,
	openSessionInWorktree,
	resumeSessionWorktree,
	worktreeRestoreNotices,
} from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import {
	GitUnavailableError,
	isWorkspaceConfigError,
	WorkspaceDriftError,
	WorkspaceRestoreError,
} from "../src/core/worktree-snapshot/errors.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { showSessionNotices } from "../src/modes/interactive/session-notices.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
beforeAll(() => initTheme("dark"));
beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	await store.close();
	await database.close();
	sandbox.dispose();
});

const ANSI = /\u001b\[[0-9;]*m/g;
const options = () => ({ settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, storeDir: sandbox.path("host") });

/** A session in `a` that recorded edits in two repositories, both edited again since, and a restore interrupted earlier on this host. */
async function twoDriftedRepositories() {
	const a = await sandbox.remoteWithClone("a");
	const b = await sandbox.remoteWithClone("b");
	const manager = await SessionManager.create(store, a.clone);
	for (const clone of [a.clone, b.clone]) {
		sandbox.write(join(clone, "file.txt"), "recorded\n");
		const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error(`no snapshot of ${clone}`);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		sandbox.write(join(clone, "file.txt"), "edited since\n");
	}
	const records = join(options().storeDir, "restores");
	mkdirSync(records, { recursive: true });
	const interrupted = join(records, `${randomUUID()}.json`);
	writeFileSync(interrupted, "{");
	return { a: a.clone, b: b.clone, manager, interrupted };
}

const leftoverWarning = (path: string) =>
	`Warning: A restore interrupted earlier left the crash record ${path}, which cannot be read; delete the file`;

/** A host whose statuses, warnings and errors render into a real chat container. */
function chatHost(sessionManager: SessionManager) {
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const chatContainer = new Container();
	return {
		sessionManager,
		chatContainer,
		ui: { requestRender() {} },
		lastStatusText: undefined,
		lastStatusSpacer: undefined,
		statusContainer: new Container(),
		settingsManager: { getClearOnShrink: () => false },
		firstRunNoticeVisible: false,
		fatal: [] as string[],
		showStatus: prototype.showStatus,
		showWarning: prototype.showWarning,
		showError: prototype.showError,
		getPathCommandArgument: prototype.getPathCommandArgument,
		ensureDeferredStartupComplete: async () => {},
		clearWorkingLoader() {},
		renderCurrentSessionState() {},
		startSessionRecovery() {},
		showExtensionConfirm: async () => true,
		async handleFatalRuntimeError(this: { fatal: string[] }, message: string) {
			this.fatal.push(message);
		},
		lines(): string[] {
			return chatContainer.children
				.flatMap((child) => child.render(2000))
				.map((line) => line.replace(ANSI, "").trim())
				.filter((line) => line.length > 0);
		},
	};
}

type ChatHost = ReturnType<typeof chatHost> & {
	runtimeHost: {
		switchSession?: () => Promise<{ cancelled: boolean }>;
		importFromJsonl?: () => Promise<{ cancelled: boolean }>;
	};
};

const handleResumeSession = (
	InteractiveMode.prototype as unknown as {
		handleResumeSession(this: ChatHost, id: string): Promise<{ cancelled: boolean }>;
	}
).handleResumeSession;
const handleImportCommand = (
	InteractiveMode.prototype as unknown as { handleImportCommand(this: ChatHost, text: string): Promise<void> }
).handleImportCommand;

function assertRestoreLines(lines: readonly string[], manager: SessionManager, interrupted: string): void {
	const mappings = manager.getWorktreeRootMappings();
	assert.equal(mappings.length, 2);
	for (const mapping of mappings) assert.ok(lines.includes(formatWorktreeRestoreNotice(mapping)), mapping.from);
	assert.equal(lines.filter((line) => line === leftoverWarning(interrupted)).length, 1);
}

describe("restore notices in the TUI (#4245)", () => {
	test("/resume keeps one line per restored worktree and the leftover a restore reported, once", async () => {
		const { manager, interrupted } = await twoDriftedRepositories();
		const host = chatHost(manager) as ChatHost;
		host.runtimeHost = {
			switchSession: async () => {
				await resumeSessionWorktree(manager, options());
				return { cancelled: false };
			},
		};
		assert.deepEqual(await handleResumeSession.call(host, manager.getSessionId()), { cancelled: false });
		const lines = host.lines();
		assert.equal(lines[0], "Resumed session");
		assertRestoreLines(lines, manager, interrupted);
	});

	test("/import shows the same lines as /resume for two restores and a leftover", async () => {
		const { manager, interrupted } = await twoDriftedRepositories();
		const host = chatHost(manager) as ChatHost;
		host.runtimeHost = {
			importFromJsonl: async () => {
				await resumeSessionWorktree(manager, options());
				return { cancelled: false };
			},
		};
		await handleImportCommand.call(host, "/import exported.jsonl");
		const lines = host.lines();
		assert.equal(lines[0], "Session imported from: exported.jsonl");
		assertRestoreLines(lines, manager, interrupted);
		assert.deepEqual(host.fatal, []);
	});

	test("/import that cannot restore its checkout shows the typed error and keeps the current session", async () => {
		const manager = await SessionManager.create(store, sandbox.root);
		const host = chatHost(manager) as ChatHost;
		const failure = new WorkspaceDriftError(
			{
				root: "/work/repo",
				expectedHead: "a".repeat(40),
				actualHead: null,
				expectedTree: "b".repeat(40),
				actualTree: null,
				snapshotId: "snap",
				reason: "restore-failed",
			},
			new WorkspaceRestoreError("blob-missing", {
				snapshotId: "snap",
				blob: "c".repeat(64),
				role: "patch",
				deltaIndex: 0,
			}),
		);
		host.runtimeHost = {
			importFromJsonl: async () => {
				throw failure;
			},
		};
		await handleImportCommand.call(host, "/import exported.jsonl");
		assert.deepEqual(host.lines(), [`Error: ${failure.message}`]);
		assert.deepEqual(host.fatal, []);
		assert.equal(host.sessionManager, manager);
	});

	test("/import keeps a missing Git on screen like a workspace failure, and treats any other failure as fatal", async () => {
		const manager = await SessionManager.create(store, sandbox.root);
		const missingGit = new GitUnavailableError({
			code: "not-installed",
			platform: process.platform,
			arch: process.arch,
			installDir: "/opt/git",
			systemGit: { path: "/opt/git/bin/git", problem: "probe-failed" },
		});
		const unexpected = new Error("the session file could not be parsed");
		for (const failure of [missingGit, unexpected]) {
			const host = chatHost(manager) as ChatHost;
			host.runtimeHost = {
				importFromJsonl: async () => {
					throw failure;
				},
			};
			await handleImportCommand.call(host, "/import exported.jsonl");
			if (failure === missingGit) {
				assert.deepEqual(host.lines(), [`Error: ${missingGit.message}`]);
				assert.deepEqual(host.fatal, []);
			} else {
				assert.deepEqual(host.lines(), []);
				assert.deepEqual(host.fatal, ["Failed to import session"]);
			}
		}
	});

	test("no startup notices render nothing", () => {
		const host = chatHost(undefined as never);
		showSessionNotices(host as never, undefined);
		assert.deepEqual(host.lines(), []);
	});

	test("startup notices each keep their own line when a later status arrives", () => {
		const host = chatHost(undefined as never);
		showSessionNotices(host as never, [
			{ type: "info", message: "Restored worktree snapshot 1 of /a into /x" },
			{ type: "info", message: "Restored worktree snapshot 2 of /b into /y" },
			{ type: "warning", message: "careful" },
			{ type: "error", message: "broken" },
		]);
		(host.showStatus as (message: string) => void).call(host, "Ready");
		assert.deepEqual(host.lines(), [
			"Restored worktree snapshot 1 of /a into /x",
			"Restored worktree snapshot 2 of /b into /y",
			"Warning: careful",
			"Error: broken",
			"Ready",
		]);
	});
});

describe("restore warnings recorded with their restore (#4245)", () => {
	test("a checkout whose latest snapshot record is missing is left out of the current snapshots", () => {
		const entry = (root: string, snapshotId: string) => ({
			type: "worktree_snapshot" as const,
			id: `${root}-${snapshotId}`,
			parentId: null,
			timestamp: "t",
			root,
			snapshotId,
		});
		const recorded = { id: "kept" } as WorktreeSnapshot;
		const current = currentWorktreeSnapshots({
			getBranch: () => [entry("/work/a", "kept"), entry("/work/b", "ghost")],
			getWorktreeRootMappings: () => [],
			getWorktreeSnapshotRecords: () => new Map([["kept", recorded]]),
		});
		assert.deepEqual([...current], [[resolve("/work/a"), recorded]]);
	});

	test("a reopened session still reports what each restore said, and startup shows it once", async () => {
		const { manager, interrupted } = await twoDriftedRepositories();
		const since = new Date().toISOString();
		const opened = await openSessionInWorktree(manager, options());
		const reopened = await SessionManager.open(store, manager.getSessionId());
		assert.deepEqual(worktreeRestoreNotices(reopened, since), opened.notices);
		const restores = reopened.getBranch().filter((entry) => entry.type === "worktree_snapshot" && entry.restore);
		assert.deepEqual(
			restores.map((entry) => entry.type === "worktree_snapshot" && entry.restoreWarnings),
			[[{ code: "stale-restore-retained", path: interrupted, kind: "record" }], undefined],
		);
		assert.equal(
			opened.notices.filter((notice) => notice.message === leftoverWarning(interrupted).slice("Warning: ".length))
				.length,
			1,
		);
	});

	test("warnings without the restore they belong to are refused before anything is written", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await SessionManager.create(store, clone);
		const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error("no snapshot");
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		const before = manager.getEntries().length;
		await assert.rejects(
			manager.appendWorktreeSnapshot(clone, capture.snapshot.id, undefined, undefined, [
				{ code: "lfs-objects-unavailable", paths: ["a.bin"] },
			]),
			(error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.equal(error.code, "invalid-setting");
				assert.equal(error.field, "restoreWarnings");
				assert.equal(error.source, "sdk");
				assert.equal(
					error.message,
					"Invalid worktree snapshot setting: restoreWarnings from sdk (invalid-setting). Set restoreWarnings to warnings recorded together with their restore.",
				);
				return true;
			},
		);
		assert.equal(manager.getEntries().length, before);
	});
});
