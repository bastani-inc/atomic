import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, test } from "vitest";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { recordResumeTimings } from "../src/core/resume/timings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openSessionInWorktree } from "../src/core/session-worktree-snapshots.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import {
	serializeWorkspaceError,
	WorkspaceDriftError,
	WorkspaceSnapshotError,
} from "../src/core/worktree-snapshot/errors.ts";
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

const ANSI = /\u001b\[[0-9;]*m/g;
const rendered = (container: Container): string =>
	container.children
		.flatMap((child) => child.render(200))
		.join("\n")
		.replace(ANSI, "");

async function store(): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const opened = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await opened.close();
		await database.close();
	});
	return opened;
}

async function recordedSession() {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
	writeFileSync(join(clone, "a.txt"), "recorded\n");
	const sessions = await store();
	const manager = await SessionManager.create(sessions, clone);
	const capture = await captureWorktreeSnapshot(clone, { blobs: sessions.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	return { clone, manager, snapshot: capture.snapshot };
}

type SnapshotCommandHost = {
	sessionManager: SessionManager;
	settingsManager: { getWorktreeSnapshotSettings(): typeof DEFAULT_WORKTREE_SNAPSHOT_SETTINGS };
	chatContainer: Container;
	ui: { requestRender(): void };
	statuses: string[];
	showStatus(message: string): void;
};

function snapshotCommandHost(sessionManager: SessionManager): SnapshotCommandHost {
	const statuses: string[] = [];
	return {
		sessionManager,
		settingsManager: { getWorktreeSnapshotSettings: () => DEFAULT_WORKTREE_SNAPSHOT_SETTINGS },
		chatContainer: new Container(),
		ui: { requestRender() {} },
		statuses,
		showStatus: (message) => statuses.push(message),
	};
}

const handleSessionSnapshotCommand = (
	InteractiveMode.prototype as unknown as { handleSessionSnapshotCommand(this: SnapshotCommandHost): Promise<void> }
).handleSessionSnapshotCommand;

describe("/session snapshot", () => {
	test("says so when the session recorded no snapshot", async () => {
		const host = snapshotCommandHost(await SessionManager.create(await store(), sandbox.root));
		await handleSessionSnapshotCommand.call(host);
		assert.deepEqual(host.statuses, ["No worktree snapshots recorded in this session"]);
		assert.equal(host.chatContainer.children.length, 0);
	});

	test("shows the latest snapshot and that it matches the current tree", async () => {
		const { clone, manager, snapshot } = await recordedSession();
		const host = snapshotCommandHost(manager);
		await handleSessionSnapshotCommand.call(host);
		const text = rendered(host.chatContainer);
		assert.match(text, /Worktree Snapshots/);
		assert.ok(text.includes(clone));
		assert.ok(text.includes(`snapshot ${snapshot.id}`));
		assert.ok(text.includes(`main at ${snapshot.head.slice(0, 12)}, tree ${snapshot.tree.slice(0, 12)}`));
		assert.match(text, /delta chain 1 link\(s\)/);
		assert.match(text, /no unpushed commits bundled/);
		assert.match(text, /matches the current tree/);
		assert.doesNotMatch(text, /last capture|undefined|Last resume/, "nothing recorded either (#4748)");
	});

	test("diffs the snapshot against a drifted tree", async () => {
		const { clone, manager } = await recordedSession();
		writeFileSync(join(clone, "a.txt"), "changed after the snapshot\n");
		const host = snapshotCommandHost(manager);
		await handleSessionSnapshotCommand.call(host);
		const text = rendered(host.chatContainer);
		assert.match(text, /differs from the current tree [0-9a-f]{12} at [0-9a-f]{12}/);
		assert.match(text, /a\.txt \| 2 \+-/);
		assert.match(text, /1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);
	});

	test("lists a restored checkout once, under the worktree it was restored into (#4245)", async () => {
		const { clone, manager } = await recordedSession();
		writeFileSync(join(clone, "a.txt"), "drifted\n");
		const opened = await openSessionInWorktree(manager, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			storeDir: sandbox.path("host"),
		});
		const [mapping] = opened.sessionManager.getWorktreeRootMappings();
		assert.ok(mapping);
		const host = snapshotCommandHost(opened.sessionManager);
		await handleSessionSnapshotCommand.call(host);
		const lines = rendered(host.chatContainer)
			.split("\n")
			.map((line) => line.trim());
		assert.deepEqual(
			lines.filter((line) => line === clone || line === mapping.to),
			[mapping.to],
		);
		assert.ok(lines.includes("matches the current tree"));
	});

	test("shows how long the last capture took and where the last resume's time went (#4748)", async () => {
		const { clone, manager, snapshot } = await recordedSession();
		await manager.appendWorktreeSnapshot(clone, snapshot.id, undefined, undefined, [], undefined, 420);
		await recordResumeTimings(manager, {
			version: 1,
			startedAt: "2026-11-14T10:00:00.000Z",
			restores: [{ root: clone, mode: "fresh", fetch: "full", ms: 2_000, phases: { fetch: 1_500, verify: 200 } }],
			blueprint: [{ section: "maintenance", name: "npm install", ms: 3_000, exit: "ok" }],
			firstPromptReadyMs: 5_500,
			blueprintReadyMs: 5_400,
		});
		const host = snapshotCommandHost(manager);
		await handleSessionSnapshotCommand.call(host);
		const lines = rendered(host.chatContainer)
			.split("\n")
			.map((line) => line.trim());
		assert.ok(lines.includes("last capture took 0.4 s"));
		const block = lines.slice(lines.indexOf("Last resume"));
		assert.deepEqual(block.filter(Boolean), [
			"Last resume",
			`restored ${clone} in 2.0 s (fetch 1.5 full, verify 0.2)`,
			"blueprint 3.0 s (npm install 3.0)",
			"ready after 5.5 s",
		]);
	});

	test("reports a checkout that no longer exists", async () => {
		const { clone, manager } = await recordedSession();
		const host = snapshotCommandHost(manager);
		sandbox.write(join(clone, ".git", "HEAD"), "not a ref\n");
		await handleSessionSnapshotCommand.call(host);
		assert.match(rendered(host.chatContainer), /not-a-repository/);
	});
});

describe("resume notices", () => {
	test("opening a drifted session restores it and returns one info line plus the snapshot's warnings", async () => {
		const { clone, manager } = await recordedSession();
		writeFileSync(join(clone, "a.txt"), "drifted\n");
		const opened = await openSessionInWorktree(manager, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			storeDir: sandbox.path("host"),
		});
		const [mapping] = opened.sessionManager.getWorktreeRootMappings();
		assert.ok(mapping);
		assert.equal(opened.sessionManager.getCwd(), mapping.to);
		assert.deepEqual(opened.notices, [
			{
				type: "info",
				message: `Restored worktree snapshot ${mapping.snapshotId.slice(0, 12)} of ${clone} into ${mapping.to}`,
			},
		]);
		const again = await openSessionInWorktree(opened.sessionManager, {
			settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
			storeDir: sandbox.path("host"),
		});
		assert.deepEqual(again.notices, []);
		assert.equal(again.sessionManager.getCwd(), mapping.to);
	});

	test("a session without snapshots opens unchanged and silently", async () => {
		const manager = await SessionManager.create(await store(), sandbox.root);
		const opened = await openSessionInWorktree(manager, { settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS });
		assert.equal(opened.sessionManager, manager);
		assert.deepEqual(opened.notices, []);
	});

	test("/resume shows the restore line and the omissions, and a failed restore keeps the current session", async () => {
		const { clone, manager } = await recordedSession();
		sandbox.write(join(clone, ".env.local"), "secret\n");
		const warnings: string[] = [];
		const statuses: string[] = [];
		const errors: string[] = [];
		let switchSession: () => Promise<{ cancelled: boolean }> = async () => ({ cancelled: false });
		const host = {
			sessionManager: manager,
			statusContainer: new Container(),
			settingsManager: { getClearOnShrink: () => false },
			firstRunNoticeVisible: false,
			ensureDeferredStartupComplete: async () => {},
			clearWorkingLoader() {},
			renderCurrentSessionState() {},
			startSessionRecovery() {},
			showStatus: (message: string) => statuses.push(message),
			showWarning: (message: string) => warnings.push(message),
			showError: (message: string) => errors.push(message),
			runtimeHost: { switchSession: () => switchSession(), takeResumeNotices: () => [] },
		};
		const handleResumeSession = (
			InteractiveMode.prototype as unknown as {
				handleResumeSession(this: typeof host, id: string): Promise<{ cancelled: boolean }>;
			}
		).handleResumeSession;
		switchSession = async () => {
			const capture = await captureWorktreeSnapshot(clone, { blobs: manager.getSessionStore().snapshotBlobs });
			if (capture.status !== "captured") throw new Error("expected a new snapshot");
			await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
			await manager.appendWorktreeSnapshot(sandbox.path("restored"), capture.snapshot.id, undefined, {
				from: clone,
				to: sandbox.path("restored"),
				snapshotId: capture.snapshot.id,
				tree: capture.snapshot.tree,
				restoredAt: new Date().toISOString(),
			});
			return { cancelled: false };
		};
		assert.deepEqual(await handleResumeSession.call(host, manager.getSessionId()), { cancelled: false });
		assert.equal(statuses[0], "Resumed session");
		assert.match(
			statuses[1] ?? "",
			new RegExp(
				`^Restored worktree snapshot [0-9a-f]{12} of ${clone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} into `,
			),
		);
		assert.deepEqual(warnings, ["The restored snapshot left out 1 item(s): .env.local (denied)"]);

		const drift = new WorkspaceDriftError(
			{ root: clone, expectedHead: "h", actualHead: null, expectedTree: "t", actualTree: null, snapshotId: null },
			new WorkspaceSnapshotError("not-a-repository", clone),
		);
		switchSession = async () => {
			throw drift;
		};
		assert.deepEqual(await handleResumeSession.call(host, manager.getSessionId()), { cancelled: true });
		assert.deepEqual(errors, [drift.message]);
	});
});

describe("snapshot-unavailable events in the TUI", () => {
	type EventHost = { warnings: string[]; showWarning(message: string): void };
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: object,
		event: object,
	) => Promise<void>;
	const eventHost = (): EventHost & object => {
		const warnings: string[] = [];
		return {
			warnings,
			showWarning: (message: string) => warnings.push(message),
			isInitialized: true,
			footer: { invalidate() {} },
			programStatus: { handleEvent() {} },
		};
	};

	test("absence of Git or a repository stays silent; other reasons show their message", async () => {
		const host = eventHost();
		for (const reason of [
			new WorkspaceSnapshotError("not-a-repository", "/tmp"),
			new WorkspaceSnapshotError("unborn-head", "/tmp"),
		]) {
			await handleEvent.call(host, {
				type: "worktree_snapshot_unavailable",
				reason: serializeWorkspaceError(reason),
			});
		}
		assert.deepEqual(host.warnings, []);
		const unsupported = new WorkspaceSnapshotError("blob-store-unsupported", "jsonl");
		await handleEvent.call(host, {
			type: "worktree_snapshot_unavailable",
			reason: serializeWorkspaceError(unsupported),
		});
		assert.deepEqual(host.warnings, [unsupported.message]);
	});
});
