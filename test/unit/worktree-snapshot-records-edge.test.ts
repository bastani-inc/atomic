import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { MemorySnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	rehydrateWorkspaceError,
	WorkspaceDriftError,
	WorkspaceRestoreError,
} from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { snapshotRecordProblem } from "../../packages/coding-agent/src/core/worktree-snapshot/records.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";

const OID = "a".repeat(40);
const HASH = "b".repeat(64);

const record = (overrides: Partial<Record<keyof WorktreeSnapshot, unknown>> = {}): WorktreeSnapshot =>
	({
		version: 1,
		id: "0123abcd",
		root: "/r",
		remotes: ["https://example.com/r.git"],
		branch: null,
		head: OID,
		snapshot: OID,
		tree: OID,
		envHash: HASH,
		delta: { base: "head", patch: null, bytes: 0 },
		chain: [{ tree: OID, patch: HASH, bytes: 1 }],
		bundle: null,
		omitted: [],
		filters: null,
		capturedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}) as WorktreeSnapshot;

describe("which recorded values the record check refuses (#4245)", () => {
	test("a well-formed record has no problem, and omissions that are not commit lists are skipped", () => {
		assert.equal(snapshotRecordProblem(record()), undefined);
		assert.equal(
			snapshotRecordProblem(record({ omitted: [null, "x", 5, { reason: "denied", path: ".env" }] })),
			undefined,
		);
	});

	test("an id that only looks like hex after string conversion is refused", () => {
		assert.deepEqual(snapshotRecordProblem(record({ chain: [{ tree: [OID], patch: null, bytes: 0 }] })), {
			field: "chain[0].tree",
			reason: "invalid-object-id",
		});
		assert.deepEqual(snapshotRecordProblem(record({ chain: [{ tree: OID, patch: [HASH], bytes: 0 }] })), {
			field: "chain[0].patch",
			reason: "invalid-blob-hash",
		});
	});

	test("every omission is checked, after a valid bundle and after a valid omission", () => {
		const bundle = { blob: HASH, bytes: 1, commits: [OID] };
		assert.deepEqual(
			snapshotRecordProblem(
				record({ bundle, omitted: [{ reason: "bundle-over-cap", commits: ["main"], bytes: 1 }] }),
			),
			{ field: "omitted[0].commits[0]", reason: "invalid-object-id" },
		);
		assert.deepEqual(
			snapshotRecordProblem(
				record({
					omitted: [
						{ reason: "unpushed-history-denied", commits: [OID], paths: [".env"] },
						{ reason: "bundle-over-cap", commits: [OID, "HEAD~1"], bytes: 1 },
					],
				}),
			),
			{ field: "omitted[1].commits[1]", reason: "invalid-object-id" },
		);
	});

	test("a snapshot's own remotes are checked, not only those of the binding that selects it", () => {
		assert.deepEqual(snapshotRecordProblem(record({ remotes: ["-oProxyCommand=x"] })), {
			field: "remotes[0]",
			reason: "unsafe-remote",
		});
	});
});

describe("the denied-history fix without its path list (#4245)", () => {
	test("renders the commits to push without inventing paths", () => {
		const error = new WorkspaceRestoreError("commits-unavailable", {
			snapshotId: "s1",
			head: OID,
			commits: ["c1"],
			reason: "denied-history",
		});
		assert.equal(
			error.hint,
			`Push commit ${OID} (with its history) to a recorded remote, then retry. Commits c1 add or change denied paths, so pushing publishes those files.`,
		);
		assert.match(error.summary, /its unpushed history touches denied paths$/);
	});
});

describe("a drift whose cause is a workspace error from an unknown release (#4245)", () => {
	test("keeps the drift's own remedy, because that cause has no summary to show", () => {
		const cause = rehydrateWorkspaceError({
			name: "WorkspaceLeaseError",
			code: "lease-lost",
			message: "m",
			hint: "h",
		});
		const error = new WorkspaceDriftError(
			{
				root: "/r",
				expectedHead: OID,
				actualHead: null,
				expectedTree: OID,
				actualTree: null,
				snapshotId: null,
				reason: "restore-failed",
			},
			cause,
		);
		assert.equal(error.hint, "Restore the recorded snapshot into a new worktree, or undo the changes, then resume.");
		assert.equal(error.restoreCode, undefined);
		assert.equal(error.message.includes("automatic restore failed"), false);
	});
});

describe("the memory blob store's own clock (#4245)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("ages blobs in seconds of wall-clock time", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const store = new MemorySnapshotBlobStore();
		await store.putBlobs([{ hash: HASH, data: new Uint8Array([1]) }]);
		assert.deepEqual((await collectSnapshotGarbage(store, [], { graceSeconds: 3600 })).deleted, []);
		vi.setSystemTime(new Date("2026-01-01T00:16:40.000Z"));
		assert.deepEqual((await collectSnapshotGarbage(store, [], { graceSeconds: 3600 })).deleted, []);
		vi.setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
		assert.deepEqual((await collectSnapshotGarbage(store, [], { graceSeconds: 3600 })).deleted, [HASH]);
	});
});
