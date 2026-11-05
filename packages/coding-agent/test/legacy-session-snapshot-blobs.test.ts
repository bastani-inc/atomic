import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { LegacySessionStore } from "../src/core/storage/session/legacy-session-store.js";
import { SESSION_FORMAT_VERSION } from "../src/core/storage/session/types.js";
import { SqlSnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.ts";
import { snapshotBlob } from "../src/core/worktree-snapshot/env-hash.ts";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";
import { createHarness } from "./suite/harness.js";

let root: string;
let agentDir: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "legacy-session-snapshot-blobs-"));
	agentDir = join(root, "agent");
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv(ENV_SESSION_DIR, "");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	while (cleanups.length > 0) await cleanups.pop()?.();
	rmSync(root, { recursive: true, force: true });
});

const blob = (text: string) => snapshotBlob(new TextEncoder().encode(text));

function snapshotOf(id: string, patch: string): WorktreeSnapshot {
	return {
		version: 1,
		id,
		root: "/repo",
		remotes: [],
		branch: "main",
		head: "a".repeat(40),
		snapshot: "b".repeat(40),
		tree: "c".repeat(40),
		envHash: "env",
		delta: { base: "head", patch, bytes: 1 },
		chain: [{ tree: "d".repeat(40), patch, bytes: 1 }],
		bundle: null,
		omitted: [],
		filters: null,
		capturedAt: "2026-01-01T00:00:00.000Z",
	};
}

function snapshotEntry(id: string, snapshot: WorktreeSnapshot): SessionEntry {
	return {
		type: "worktree_snapshot",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		root: snapshot.root,
		snapshotId: snapshot.id,
		snapshot,
	} as SessionEntry;
}

/** The default session store of `agentDir`, with one session that superseded its first snapshot, all blobs old. */
async function defaultStoreWithSupersededSnapshot() {
	const store = await resolveSessionStore(root, { agentDir, settings: {} });
	cleanups.push(() => store.close().catch(() => undefined));
	assert.ok(store instanceof LegacySessionStore);
	assert.ok(store.snapshotBlobs instanceof SqlSnapshotBlobStore);
	const [released, kept] = [blob("superseded patch"), blob("latest patch")];
	await store.snapshotBlobs.putBlobs([released, kept]);
	await store.create(
		{ id: "session-1", version: SESSION_FORMAT_VERSION, createdAt: "2026-01-01T00:00:00.000Z", cwd: root },
		[
			snapshotEntry("entry-1", snapshotOf("older", released.hash)),
			snapshotEntry("entry-2", snapshotOf("latest", kept.hash)),
		],
	);
	const databasePath = join(root, "workflows", "journal.sqlite");
	const database = await openNodeSqliteDatabase(databasePath);
	cleanups.push(() => database.close());
	await database.run("UPDATE snapshot_blobs SET created_at = created_at - 7200");
	const stored = async () =>
		(await database.all<{ hash: string }>("SELECT hash FROM snapshot_blobs ORDER BY hash")).map((row) => row.hash);
	return { store, released, kept, stored };
}

test("the default session storage exposes its blob table, so sessions on it record snapshots and can collect them (#4355)", async () => {
	const { store } = await defaultStoreWithSupersededSnapshot();

	assert.ok(store.snapshotBlobs instanceof SqlSnapshotBlobStore);
	assert.equal(store.snapshotBlobs.table, "snapshot_blobs");
});

test("closing a session on the default storage collects the blobs its superseded snapshot released (#4355)", async () => {
	const { store, released, kept, stored } = await defaultStoreWithSupersededSnapshot();
	const harness = await createHarness({ sessionManager: await SessionManager.create(store, root) });

	await harness.session.dispose();

	await vi.waitFor(async () => assert.deepEqual(await stored(), [kept.hash]));
	assert.ok(!(await stored()).includes(released.hash));
});
