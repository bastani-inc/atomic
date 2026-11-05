import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	captureWorktreeSnapshot,
	isGitUnavailableError,
	isWorkspaceDriftError,
	isWorkspaceRestoreError,
	restoreWorktreeSnapshot,
	setWorktreeSnapshotGit,
	type WorktreeRestoreWarning,
	type WorktreeRootMapping,
	type WorktreeSnapshot,
} from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { RUN_EVENT_TYPES, type RunEvent, type RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { resolveWorkflowSnapshotFrontier } from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { openSqlSnapshotJournal, type SqlSnapshotJournal } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
let fixture: SqlSnapshotJournal;
beforeEach(async () => {
	sandbox = new GitSandbox();
	fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
});
afterEach(async () => {
	await fixture.close();
	sandbox.dispose();
});

async function startRun() {
	const { journal } = fixture;
	await journal.createRun({ runId: "run", name: "run", cwd: "/", status: "running", createdAt: 1 });
	const acquired = await journal.acquire("run", "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") throw new Error("lease not acquired");
	let count = 0;
	return {
		/** Changes `file` in `dir`, records the checkout in the journal, and returns the snapshot. */
		async record(dir: string, content: string, settings?: Parameters<typeof captureWorktreeSnapshot>[1]) {
			sandbox.write(join(dir, "state.txt"), content);
			const capture = await captureWorktreeSnapshot(dir, { blobs: journal.snapshotBlobs, ...settings });
			assert.equal(capture.status, "captured");
			if (capture.status !== "captured") throw new Error("capture failed");
			await journal.append(acquired.lease, {
				type: RUN_EVENT_TYPES.checkpointRecorded,
				payload: { kind: "tool", checkpointId: `tool-${++count}`, worktreeSnapshots: [capture.snapshot] },
			} as unknown as RunEvent);
			return capture.snapshot;
		},
	};
}

const worktreesIn = (storeDir: string): string[] => {
	try {
		return readdirSync(join(storeDir, "worktrees"));
	} catch {
		return [];
	}
};

test("verification applies the settings the snapshots were captured with (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const run = await startRun();
	sandbox.write(join(clone, "scratch.txt"), "untracked and excluded\n");
	await run.record(clone, "recorded\n", { settings: { includeUntracked: false } });
	assert.deepEqual(
		await resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
			settings: { includeUntracked: false },
			storeDir: sandbox.path("matching"),
		}),
		[],
	);
	assert.deepEqual(worktreesIn(sandbox.path("matching")), []);
	const defaults = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
		storeDir: sandbox.path("defaults"),
	});
	assert.equal(defaults.length, 1, "with default settings the untracked file counts as drift");
});

test("a checkout that is gone is restored from the journal's blobs into a fresh worktree under the store (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const run = await startRun();
	const snapshot = await run.record(clone, "recorded\n");
	rmSync(clone, { recursive: true, force: true });
	const storeDir = sandbox.path("host");
	const [mapping] = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", { storeDir });
	assert.ok(mapping);
	assert.equal(mapping.from, clone);
	assert.equal(mapping.snapshotId, snapshot.id);
	assert.equal(mapping.tree, snapshot.tree);
	assert.deepEqual(
		worktreesIn(storeDir).map((name) => join(storeDir, "worktrees", name)),
		[mapping.to],
	);
	assert.equal(readFileSync(join(mapping.to, "state.txt"), "utf8"), "recorded\n");
});

test("a checkout that is gone and cannot be rebuilt fails with a drift error naming it, with the restore failure as cause (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const run = await startRun();
	const snapshot = await run.record(clone, "recorded\n");
	await fixture.journal.snapshotBlobs.deleteBlobs([snapshot.chain[0]!.patch!]);
	rmSync(clone, { recursive: true, force: true });
	await assert.rejects(
		resolveWorkflowSnapshotFrontier(fixture.journal, "run", { storeDir: sandbox.path("host") }),
		(error: unknown) => {
			assert.ok(isWorkspaceDriftError(error));
			assert.equal(error.root, clone);
			assert.equal(error.expectedHead, snapshot.head);
			assert.equal(error.expectedTree, snapshot.tree);
			assert.equal(error.actualHead, null);
			assert.equal(error.actualTree, null);
			assert.equal(error.snapshotId, snapshot.id);
			assert.ok(isWorkspaceRestoreError(error.cause));
			assert.equal(error.cause.code, "blob-missing");
			return true;
		},
	);
	assert.deepEqual(worktreesIn(sandbox.path("host")), []);
});

test("a failure that is not drift, such as missing Git, surfaces as itself and restores nothing (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const run = await startRun();
	await run.record(clone, "recorded\n");
	sandbox.write(join(clone, "state.txt"), "drift\n");
	setWorktreeSnapshotGit(async () => ({ path: sandbox.path("missing-git"), env: {} }));
	await assert.rejects(
		resolveWorkflowSnapshotFrontier(fixture.journal, "run", { storeDir: sandbox.path("host") }),
		(error: unknown) => isGitUnavailableError(error) && error.executable === sandbox.path("missing-git"),
	);
	assert.deepEqual(worktreesIn(sandbox.path("host")), []);
});

test("restore notices and warnings reach the callbacks after every root is restored, and are optional (#4245)", async () => {
	const first = await sandbox.remoteWithClone("one");
	const second = await sandbox.remoteWithClone("two");
	const run = await startRun();
	sandbox.write(join(first.clone, ".env.local"), "secret\n");
	await run.record(first.clone, "first\n");
	await run.record(second.clone, "second\n");
	sandbox.write(join(first.clone, "state.txt"), "drift\n");
	sandbox.write(join(second.clone, "state.txt"), "drift\n");

	const events: string[] = [];
	const warnings: WorktreeRestoreWarning[] = [];
	const restored = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
		storeDir: sandbox.path("with-callbacks"),
		onRestore: (mapping) => events.push(`restore ${mapping.from}`),
		onWarning: (warning) => {
			events.push(`warning ${warning.code}`);
			warnings.push(warning);
		},
	});
	assert.equal(restored.length, 2);
	assert.deepEqual(events, [`restore ${first.clone}`, "warning omitted-content", `restore ${second.clone}`]);
	assert.deepEqual(warnings[0]?.code === "omitted-content" && warnings[0].omitted, [
		{ reason: "denied", path: ".env.local" },
	]);

	const silent = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
		storeDir: sandbox.path("without-callbacks"),
	});
	assert.equal(silent.length, 2, "restoring with omitted content needs no callback");
});

interface Sabotage {
	readonly journal: RunJournal;
	/** Worktrees broken by the sabotage, in the order they were restored. */
	readonly restoredInOrder: readonly string[];
	/** Breaks every worktree restored so far when the blob of `failing` is read. */
	readonly arm: (failing: WorktreeSnapshot, storeDir: string) => void;
}

function sabotagingJournal(): Sabotage {
	let target: { readonly hash: string; readonly storeDir: string } | undefined;
	const restoredInOrder: string[] = [];
	const real = fixture.journal.snapshotBlobs;
	const blobs = {
		putBlobs: (items: Parameters<typeof real.putBlobs>[0]) => real.putBlobs(items),
		listBlobHashes: () => real.listBlobHashes(),
		deleteBlobs: (hashes: readonly string[]) => real.deleteBlobs(hashes),
		async getBlob(hash: string) {
			if (target?.hash !== hash) return real.getBlob(hash);
			const root = join(target.storeDir, "worktrees");
			const names = worktreesIn(target.storeDir).sort(
				(left, right) => statSync(join(root, left)).birthtimeMs - statSync(join(root, right)).birthtimeMs,
			);
			for (const name of names) {
				restoredInOrder.push(join(root, name));
				rmSync(join(root, name, ".git"), { force: true });
			}
			return undefined;
		},
	};
	const journal = new Proxy(fixture.journal, {
		get(source, key) {
			if (key === "snapshotBlobs") return blobs;
			const value = Reflect.get(source, key, source);
			return typeof value === "function" ? value.bind(source) : value;
		},
	}) as RunJournal;
	return {
		journal,
		restoredInOrder,
		arm: (failing, storeDir) => {
			target = { hash: failing.chain[0]!.patch!, storeDir };
		},
	};
}

test("a failed pass removes the worktrees it created and records no mapping; callbacks never fire (#4245)", async () => {
	const clones = [await sandbox.remoteWithClone("a"), await sandbox.remoteWithClone("b")];
	const run = await startRun();
	const snapshots = [await run.record(clones[0]!.clone, "a\n"), await run.record(clones[1]!.clone, "b\n")];
	for (const { clone } of clones) sandbox.write(join(clone, "state.txt"), "drift\n");
	await fixture.journal.snapshotBlobs.deleteBlobs([snapshots[1]!.chain[0]!.patch!]);
	const storeDir = sandbox.path("host");
	const events: string[] = [];
	await assert.rejects(
		resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
			storeDir,
			onRestore: () => events.push("restore"),
			onWarning: () => events.push("warning"),
		}),
		(error: unknown) => {
			assert.ok(isWorkspaceDriftError(error));
			assert.equal(error.root, clones[1]!.clone);
			assert.equal("cleanupCause" in error, false, "a clean rollback reports no cleanup failure");
			return true;
		},
	);
	assert.deepEqual(events, []);
	assert.deepEqual(worktreesIn(storeDir), []);
});

test("a rollback that cannot remove a worktree keeps the original error and attaches the cleanup failure (#4245)", async () => {
	const clones = [await sandbox.remoteWithClone("a"), await sandbox.remoteWithClone("b")];
	const run = await startRun();
	await run.record(clones[0]!.clone, "a\n");
	const failing = await run.record(clones[1]!.clone, "b\n");
	for (const { clone } of clones) sandbox.write(join(clone, "state.txt"), "drift\n");
	const storeDir = sandbox.path("host");
	const sabotage = sabotagingJournal();
	sabotage.arm(failing, storeDir);
	await assert.rejects(resolveWorkflowSnapshotFrontier(sabotage.journal, "run", { storeDir }), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.root, clones[1]!.clone);
		assert.ok(isWorkspaceRestoreError(error.cause) && error.cause.code === "blob-missing");
		const cleanup = (error as { cleanupCause?: unknown }).cleanupCause;
		assert.ok(isWorkspaceRestoreError(cleanup));
		assert.equal(cleanup.code, "unsafe-target");
		assert.equal(cleanup.reason, "not-restored");
		assert.doesNotThrow(
			() => Object.defineProperty(error, "cleanupCause", { value: cleanup, configurable: true }),
			"a later cleanup layer can attach its own failure without throwing over the primary error",
		);
		return true;
	});
});

test("several cleanup failures are attached together (#4245)", async () => {
	const clones = [
		await sandbox.remoteWithClone("a"),
		await sandbox.remoteWithClone("b"),
		await sandbox.remoteWithClone("c"),
	];
	const run = await startRun();
	await run.record(clones[0]!.clone, "a\n");
	await run.record(clones[1]!.clone, "b\n");
	const failing = await run.record(clones[2]!.clone, "c\n");
	for (const { clone } of clones) sandbox.write(join(clone, "state.txt"), "drift\n");
	const storeDir = sandbox.path("host");
	const sabotage = sabotagingJournal();
	sabotage.arm(failing, storeDir);
	await assert.rejects(resolveWorkflowSnapshotFrontier(sabotage.journal, "run", { storeDir }), (error: unknown) => {
		assert.ok(isWorkspaceDriftError(error));
		assert.equal(error.root, clones[2]!.clone);
		const cleanup = (error as { cleanupCause?: unknown }).cleanupCause;
		assert.ok(cleanup instanceof AggregateError);
		assert.equal(cleanup.errors.length, 2);
		assert.ok(cleanup.errors.every((entry) => isWorkspaceRestoreError(entry) && entry.code === "unsafe-target"));
		assert.equal(sabotage.restoredInOrder.length, 2);
		assert.deepEqual(
			cleanup.errors.map((entry) => (entry as { target?: string }).target),
			[...sabotage.restoredInOrder].reverse(),
			"cleanup failures are reported newest worktree first, the order the rollback removed them in",
		);
		return true;
	});
});

test("boundaries recorded in a restored worktree continue the root they replaced and are verified there (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const run = await startRun();
	const original = await run.record(clone, "T1\n");
	const restored = await restoreWorktreeSnapshot(original, {
		blobs: fixture.journal.snapshotBlobs,
		storeDir: sandbox.path("host"),
	});
	await run.record(restored, "T2\n");
	sandbox.write(join(clone, "state.txt"), "drift\n");
	const mapping = (from: string, to: string): WorktreeRootMapping => ({
		from,
		to,
		snapshotId: original.id,
		tree: original.tree,
		restoredAt: "2026-01-01T00:00:00Z",
	});
	const unrelated = mapping(sandbox.path("elsewhere"), sandbox.path("nowhere"));
	assert.deepEqual(
		await resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
			mappings: [mapping(clone, restored), unrelated],
			storeDir: sandbox.path("again"),
		}),
		[],
		"the latest boundary, taken in the restored root, matches it",
	);
	assert.deepEqual(worktreesIn(sandbox.path("again")), []);
	sandbox.write(join(restored, "state.txt"), "drift in the restored worktree\n");
	const [again] = await resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
		mappings: [unrelated, mapping(clone, restored)],
		storeDir: sandbox.path("again"),
	});
	assert.equal(again?.from, clone, "a root restored again keeps its original identity");
});

test("an abort while a checkout is being rebuilt surfaces as the abort, not as drift, and leaves nothing behind (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const run = await startRun();
	const snapshot = await run.record(clone, "recorded\n");
	sandbox.write(join(clone, "state.txt"), "drift\n");
	const controller = new AbortController();
	const reason = new Error("run stopped");
	const real = fixture.journal.snapshotBlobs;
	const journal = new Proxy(fixture.journal, {
		get(source, key) {
			if (key === "snapshotBlobs")
				return {
					putBlobs: (items: Parameters<typeof real.putBlobs>[0]) => real.putBlobs(items),
					listBlobHashes: () => real.listBlobHashes(),
					deleteBlobs: (hashes: readonly string[]) => real.deleteBlobs(hashes),
					async getBlob(hash: string) {
						if (hash === snapshot.chain[0]!.patch) controller.abort(reason);
						return undefined;
					},
				};
			const value = Reflect.get(source, key, source);
			return typeof value === "function" ? value.bind(source) : value;
		},
	}) as RunJournal;
	const storeDir = sandbox.path("host");
	await assert.rejects(
		resolveWorkflowSnapshotFrontier(journal, "run", { storeDir, signal: controller.signal }),
		(error: unknown) => error === reason,
	);
	assert.deepEqual(worktreesIn(storeDir), []);
});

test("a pass that is already aborted restores nothing (#4245)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const run = await startRun();
	await run.record(clone, "recorded\n");
	sandbox.write(join(clone, "state.txt"), "drift\n");
	const reason = new Error("not started");
	await assert.rejects(
		resolveWorkflowSnapshotFrontier(fixture.journal, "run", {
			storeDir: sandbox.path("host"),
			signal: AbortSignal.abort(reason),
		}),
		(error: unknown) => error === reason,
	);
	assert.deepEqual(worktreesIn(sandbox.path("host")), []);
});
