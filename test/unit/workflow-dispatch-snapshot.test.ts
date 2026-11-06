import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
	type CaptureWorktreeSnapshotOptions,
	captureWorktreeSnapshot,
	isWorkspaceGitError,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	type SnapshotBlobStore,
	snapshotBlobHashes,
	WorkspaceGitError,
	WorkspaceSnapshotError,
	type WorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/index.js";
import {
	CARRIED_SNAPSHOT_REFRESH_MS,
	DispatchSnapshots,
} from "../../packages/workflows/src/workers/dispatch-snapshot.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/** What the root captures of a bound worktree as it dispatches its work, and keeps from collection while it waits (#4492). */
useTemporaryAgentDir();

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

function snapshots(
	blobs: SnapshotBlobStore | undefined,
	options: Partial<ConstructorParameters<typeof DispatchSnapshots>[0]> = {},
) {
	const reasons: Error[] = [];
	const dispatch = new DispatchSnapshots({ blobs, unavailable: (reason) => reasons.push(reason), ...options });
	return { dispatch, reasons };
}

/** A snapshot record carrying only what blob refreshes read: its id and the blob hashes of its chain and bundle. */
function carried(id: string, patches: readonly (string | null)[], bundle?: string): WorktreeSnapshot {
	return {
		id,
		chain: patches.map((patch) => ({ tree: "t", patch, bytes: 0 })),
		bundle: bundle === undefined ? null : { blob: bundle, bytes: 0, commits: [] },
	} as unknown as WorktreeSnapshot;
}

/** A blob store whose refreshes are recorded. */
function refreshing(): SnapshotBlobStore & { readonly refreshed: string[][] } {
	const refreshed: string[][] = [];
	return {
		refreshed,
		async putBlobs() {},
		async getBlob() {
			return undefined;
		},
		async refreshBlobs(hashes) {
			refreshed.push([...hashes].sort());
			return true;
		},
		async listBlobHashes() {
			return [];
		},
	};
}

test("a dirty worktree is captured with its blobs stored, and captured again unchanged reuses its snapshot (#4492)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
	sandbox.write(join(clone, "a.txt"), "uncommitted\n");
	sandbox.write(join(clone, "notes", "new.txt"), "untracked\n");
	const blobs = new MemorySnapshotBlobStore();
	const { dispatch, reasons } = snapshots(blobs);
	const first = await dispatch.capture(clone, undefined);
	assert.ok(first, "the dirty clone was captured");
	assert.equal(first.root, clone);
	assert.equal(first.head, await sandbox.git(clone, "rev-parse", "HEAD"));
	const hashes = snapshotBlobHashes(first);
	assert.ok(hashes.length > 0, "its uncommitted content is a patch blob");
	for (const hash of hashes)
		assert.ok(await blobs.getBlob(hash), `blob ${hash} was stored before the capture resolved`);
	const again = await dispatch.capture(clone, undefined);
	assert.equal(again, first, "nothing changed: the same snapshot, with the same capture time");
	sandbox.write(join(clone, "a.txt"), "edited again\n");
	const changed = await dispatch.capture(clone, undefined);
	assert.ok(changed && changed.id !== first.id && changed.tree !== first.tree, "an edit is captured anew");
	assert.equal(changed.delta.base, first.id, "on the last capture of that worktree as its base");
	assert.deepEqual(reasons, []);
});

test("concurrent captures of one worktree run one at a time, each based on the one before (#4492)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "committed\n" });
	sandbox.write(join(clone, "a.txt"), "uncommitted\n");
	const previous: (WorktreeSnapshot | undefined)[] = [];
	let running = 0;
	let overlapped = false;
	let late: Promise<WorktreeSnapshot | undefined> | undefined;
	const { dispatch } = snapshots(new MemorySnapshotBlobStore(), {
		capture: async (dir: string, options?: CaptureWorktreeSnapshotOptions): Promise<WorktreeSnapshotCapture> => {
			running++;
			overlapped ||= running > 1;
			previous.push(options?.previous);
			try {
				// A capture asked for while the second runs waits for the third, queued before it.
				if (previous.length === 2) late = dispatch.capture(clone, undefined);
				await sleep(20);
				return await captureWorktreeSnapshot(dir, options);
			} finally {
				running--;
			}
		},
	});
	const [a, b, c] = await Promise.all([1, 2, 3].map(() => dispatch.capture(clone, undefined)));
	const d = await late;
	assert.equal(overlapped, false, "no two captures of one worktree ran at once");
	assert.equal(previous.length, 4);
	assert.equal(previous[0], undefined, "the first capture has no base");
	assert.equal(previous[1], a, "the second is based on the first");
	assert.equal(previous[2], a);
	assert.ok(a !== undefined && b === a && c === a && d === a, "and found nothing changed");
});

test("a capture of another worktree is based on its own last snapshot, and a bounded number of worktrees is remembered (#4492)", async () => {
	const seen: string[] = [];
	const { dispatch } = snapshots(new MemorySnapshotBlobStore(), {
		capture: async (dir: string, options?: CaptureWorktreeSnapshotOptions): Promise<WorktreeSnapshotCapture> => {
			seen.push(`${dir}<-${options?.previous?.id ?? "none"}`);
			const snapshot = carried(`${dir}#${seen.length}`, []);
			return {
				status: "captured",
				snapshot,
				binding: { remotes: [], head: "h", tree: "t", envHash: "e" },
				blobs: [],
			};
		},
	});
	await dispatch.capture("/w/1", undefined);
	await dispatch.capture("/w/2", undefined);
	await dispatch.capture("/w/1", undefined);
	assert.deepEqual(seen, ["/w/1<-none", "/w/2<-none", "/w/1<-/w/1#1"]);
	for (let index = 3; index <= 256; index++) await dispatch.capture(`/w/${index}`, undefined);
	seen.length = 0;
	await dispatch.capture("/w/1", undefined);
	await dispatch.capture("/w/256", undefined);
	assert.deepEqual(
		seen.map((line) => line.split("<-")[1] !== "none"),
		[true, true],
		"256 worktrees are remembered",
	);
	await dispatch.capture("/w/257", undefined);
	seen.length = 0;
	await dispatch.capture("/w/1", undefined);
	await dispatch.capture("/w/257", undefined);
	assert.deepEqual(
		seen.map((line) => line.split("<-")[1] !== "none"),
		[false, true],
		"the 257th made it forget the others, and remember itself",
	);
});

test("a capture that finds nothing to snapshot keeps the worktree's last snapshot as the next capture's base (#4492)", async () => {
	const reason = new WorkspaceSnapshotError("unreadable-path", "/w/locked");
	const first = carried("first", []);
	const outcomes: WorktreeSnapshotCapture[] = [
		{ status: "captured", snapshot: first, binding: { remotes: [], head: "h", tree: "t", envHash: "e" }, blobs: [] },
		{ status: "unavailable", reason },
		{ status: "disabled" },
		{ status: "unchanged", snapshot: first, binding: { remotes: [], head: "h", tree: "t", envHash: "e" } },
	];
	const bases: (string | undefined)[] = [];
	const { dispatch, reasons } = snapshots(new MemorySnapshotBlobStore(), {
		capture: async (_dir: string, options?: CaptureWorktreeSnapshotOptions) => {
			bases.push(options?.previous?.id);
			return outcomes.shift()!;
		},
	});
	const captured = [];
	for (let index = 0; index < 4; index++) captured.push(await dispatch.capture("/w", undefined));
	assert.deepEqual(captured, [first, undefined, undefined, first]);
	assert.deepEqual(bases, [undefined, "first", "first", "first"]);
	assert.deepEqual(reasons, [reason]);
});

test("a worktree with snapshots disabled is not captured and nothing is reported (#4492)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const blobs = new MemorySnapshotBlobStore();
	const { dispatch, reasons } = snapshots(blobs);
	assert.equal(await dispatch.capture(clone, { enabled: false }), undefined);
	assert.deepEqual(await blobs.listBlobHashes(), []);
	assert.deepEqual(reasons, []);
	const bare = snapshots(undefined);
	assert.equal(await bare.dispatch.capture(clone, { enabled: false }), undefined);
	assert.deepEqual(bare.reasons, [], "a disabled capture does not complain about its journal");
});

test("a worktree that cannot be captured is reported once per capture with its typed reason, and dispatched without a snapshot (#4492)", async () => {
	const plain = sandbox.path("not-a-repository");
	mkdirSync(plain);
	const { dispatch, reasons } = snapshots(new MemorySnapshotBlobStore());
	assert.equal(await dispatch.capture(plain, undefined), undefined);
	const [reason] = reasons;
	assert.ok(isWorkspaceSnapshotError(reason), String(reason));
	assert.deepEqual([reason.code, reason.subject], ["not-a-repository", plain]);
	assert.equal(reasons.length, 1);
	const { clone } = await sandbox.remoteWithClone();
	const bare = snapshots(undefined);
	assert.equal(await bare.dispatch.capture(clone, undefined), undefined, "a journal without snapshot blobs");
	const [unsupported] = bare.reasons;
	assert.ok(isWorkspaceSnapshotError(unsupported), String(unsupported));
	assert.deepEqual([unsupported.code, unsupported.subject], ["blob-store-unsupported", "workflow journal"]);
	assert.equal(bare.reasons.length, 1);
});

test("a git failure during a capture is reported as its reason; any other failure rejects the dispatch (#4492)", async () => {
	const failed = new WorkspaceGitError({ operation: "write-tree", cwd: "/w", exitCode: 128, detail: "corrupt" });
	const broken = new TypeError("not a workspace failure");
	let fail: Error = failed;
	const { dispatch, reasons } = snapshots(new MemorySnapshotBlobStore(), {
		capture: async () => {
			throw fail;
		},
	});
	assert.equal(await dispatch.capture("/w", undefined), undefined);
	assert.deepEqual(reasons, [failed]);
	assert.ok(isWorkspaceGitError(reasons[0]));
	fail = broken;
	await assert.rejects(dispatch.capture("/w", undefined), (error) => error === broken);
	assert.equal(reasons.length, 1, "a failure that is not a workspace one is not a degrade reason");
});

test("a cancelled capture rejects with its signal's reason, never a degrade reason (#4492)", async () => {
	const cancelled = new Error("cancelled");
	const controller = new AbortController();
	let captures = 0;
	const { dispatch, reasons } = snapshots(new MemorySnapshotBlobStore(), {
		capture: async () => {
			captures++;
			controller.abort(cancelled);
			throw new WorkspaceGitError({ operation: "add", cwd: "/w", exitCode: null, detail: "" });
		},
	});
	await assert.rejects(dispatch.capture("/w", undefined, controller.signal), (error) => error === cancelled);
	await assert.rejects(dispatch.capture("/w", undefined, controller.signal), (error) => error === cancelled);
	assert.equal(captures, 1, "a capture whose signal had aborted already never started");
	assert.deepEqual(reasons, []);
});

test("the blobs of carried snapshots are refreshed once per interval while their work waits, and no longer once it is done (#4492)", async () => {
	const blobs = refreshing();
	const { dispatch } = snapshots(blobs, { refreshMs: 1_000 });
	const start = Date.now();
	await dispatch.refresh(start + 5_000);
	assert.deepEqual(blobs.refreshed, [], "nothing is carried");
	const first = dispatch.carry(carried("s1", ["p1", null, "p2"], "b1"));
	const second = dispatch.carry(carried("s2", ["p2"], "b2"));
	const again = dispatch.carry(carried("s1", ["p1", null, "p2"], "b1"));
	const none = dispatch.carry(undefined);
	await dispatch.refresh(start + 5_999);
	assert.deepEqual(blobs.refreshed, [], "the interval has not passed since the last refresh");
	await dispatch.refresh(start + 6_000);
	assert.deepEqual(blobs.refreshed, [["b1", "b2", "p1", "p2"]], "every blob a carried snapshot references, once");
	await dispatch.refresh(start + 6_999);
	assert.equal(blobs.refreshed.length, 1);
	second();
	none();
	await dispatch.refresh(start + 7_000);
	assert.deepEqual(blobs.refreshed.at(-1), ["b1", "p1", "p2"], "a finished child's snapshot is let go");
	first();
	await dispatch.refresh(start + 8_000);
	assert.deepEqual(blobs.refreshed.at(-1), ["b1", "p1", "p2"], "until every child that carries it is done");
	assert.equal(blobs.refreshed.length, 3);
	again();
	await dispatch.refresh(start + 9_000);
	assert.equal(blobs.refreshed.length, 3, "nothing is carried any more");
	const clean = dispatch.carry(carried("s3", [null]));
	await dispatch.refresh(start + 10_000);
	assert.equal(blobs.refreshed.length, 3, "a snapshot of a clean checkout references no blob");
	clean();
	const bare = snapshots(undefined, { refreshMs: 0 }).dispatch;
	bare.carry(carried("s4", ["p4"]));
	await bare.refresh(start + 10_000);
	assert.equal(blobs.refreshed.length, 3, "a journal without snapshot blobs has nothing to refresh");
});

test("carried snapshots are refreshed every third of a grace window shorter than five minutes (#4492)", async () => {
	const blobs = refreshing();
	const { dispatch } = snapshots(blobs, { graceSeconds: 60 });
	dispatch.carry(carried("s1", ["p1"], "b1"));
	const first = Date.now() + 20_000;
	await dispatch.refresh(first);
	assert.deepEqual(blobs.refreshed, [["b1", "p1"]], "a third of the 60 s grace window after the last refresh");
	await dispatch.refresh(first + 19_999);
	assert.equal(blobs.refreshed.length, 1);
	await dispatch.refresh(first + 20_000);
	assert.equal(blobs.refreshed.length, 2, "again within the grace window, never past it");
});

test("carried snapshots are refreshed every five minutes by default (#4492)", async () => {
	assert.equal(CARRIED_SNAPSHOT_REFRESH_MS, 300_000);
	const blobs = refreshing();
	const { dispatch } = snapshots(blobs);
	const start = Date.now();
	const release = dispatch.carry(carried("s1", ["p1"]));
	await dispatch.refresh(start + CARRIED_SNAPSHOT_REFRESH_MS - 1_000);
	assert.deepEqual(blobs.refreshed, []);
	await dispatch.refresh(start + CARRIED_SNAPSHOT_REFRESH_MS + 1_000);
	assert.deepEqual(blobs.refreshed, [["p1"]]);
	release();
});
