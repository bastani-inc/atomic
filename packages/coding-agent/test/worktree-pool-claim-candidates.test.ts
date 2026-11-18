import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { sleep } from "../../../test/helpers/runtime.js";
import { renameWithRetry } from "../src/core/rename-retry.ts";
import type { SessionManager } from "../src/core/session-manager.js";
import { releaseSessionWorktrees } from "../src/core/session-worktree-snapshots.js";
import {
	claimIdleWorktree,
	evictIdleWorktrees,
	holdRestoredWorktree,
	pooledWorktreeHolder,
	releaseRestoredWorktree,
	repositoryIdOf,
} from "../src/core/worktree-snapshot/pool.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";
import {
	capture,
	claimOptions,
	idleSlotOfX,
	recordFile,
	recordOf,
	resume,
	sandbox,
	sessionOf,
	settings,
	slot,
	store,
	storeDir,
	twoSnapshots,
	useWorktreePoolClaimSandbox,
	Y,
} from "./helpers/worktree-pool-claim-fixture.js";

useWorktreePoolClaimSandbox();

describe("claim candidates and failures (#4748)", () => {
	/** `count` sessions restored A into slots 0.. and released them, oldest slot first; returns their sessions. */
	async function idleSlots(a: WorktreeSnapshot, clone: string, count: number): Promise<SessionManager[]> {
		const sessions: SessionManager[] = [];
		for (let n = 0; n < count; n++) sessions.push((await resume(await sessionOf(clone, a))).sessionManager);
		for (const session of sessions) {
			await releaseSessionWorktrees(session);
			await sleep(5);
		}
		return sessions;
	}

	test("a claim prefers slots of the snapshot's environment, newest released first, and moves past one it cannot take (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlots(a, clone, 3);
		// Slot 2, the newest, was restored for another environment; slot 1, the newest of the rest, has uncaptured work.
		writeFileSync(recordFile(a, 2), JSON.stringify({ ...recordOf(a, 2), envHash: "another-environment" }));
		sandbox.write(join(slot(a, 1), "file.txt"), "uncaptured\n");

		const claim = await claimIdleWorktree(b, claimOptions());

		assert.equal(claim.claimed && claim.lease.path, slot(a, 0));
		if (claim.claimed) await releaseRestoredWorktree(claim.lease);
		assert.equal(readFileSync(join(slot(a, 1), "file.txt"), "utf8"), "uncaptured\n");
		assert.equal(readFileSync(join(slot(a, 2), "file.txt"), "utf8"), "A\n");
	});

	test("a claim whose slot another holder took while it reset records nothing and holds no slot (#4830)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);
		const z = { kind: "session" as const, id: "session-z" };
		let taken = "";
		// Another process takes the slot while the claim fetches the snapshot's content, as after a long stall.
		const blobs = {
			...store.snapshotBlobs,
			getBlob: async (hash: string) => {
				if (taken === "") {
					writeFileSync(recordFile(a, 0), JSON.stringify({ ...recordOf(a, 0), holder: z, tenancy: "taken-by-z" }));
					taken = readFileSync(recordFile(a, 0), "utf8");
				}
				return store.snapshotBlobs!.getBlob(hash);
			},
		};

		const claim = await claimIdleWorktree(b, { ...claimOptions(), blobs });

		assert.deepEqual(claim, { claimed: false, reason: "busy" });
		assert.notEqual(taken, "");
		assert.equal(readFileSync(recordFile(a, 0), "utf8"), taken);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner: z, held: false });
	});

	test("a claim of a snapshot with Git LFS files downloads what it can and reports what it cannot (#4748)", async () => {
		await sandbox.git(sandbox.root, "lfs", "install", "--skip-repo");
		const { clone } = await sandbox.remoteWithClone("repo", {
			".gitattributes": "*.bin filter=lfs -text\n",
			".gitignore": "node_modules/\n",
			"data.bin": "LFS-CONTENT-1\n",
			"model.bin": "LFS-MODEL-1\n",
		});
		await sandbox.git(clone, "lfs", "push", "--all", "origin");
		sandbox.write(join(clone, "file.txt"), "A\n");
		const a = await capture(clone);
		// B also changes model.bin, whose new content was never pushed.
		sandbox.write(join(clone, "file.txt"), "B\n");
		sandbox.write(join(clone, "model.bin"), "LFS-MODEL-2\n");
		const b = await capture(clone);
		await renameWithRetry(clone, sandbox.path("repo-away"));
		await idleSlotOfX(a, clone);
		assert.equal(readFileSync(join(slot(a, 0), "data.bin"), "utf8"), "LFS-CONTENT-1\n");

		const claim = await claimIdleWorktree(b, claimOptions());

		assert.equal(claim.claimed, true, JSON.stringify(claim));
		if (!claim.claimed) return;
		await releaseRestoredWorktree(claim.lease);
		assert.deepEqual(
			claim.warnings.map((warning) => warning.code),
			["lfs-objects-unavailable", "filters"],
		);
		assert.deepEqual(claim.warnings[0], { code: "lfs-objects-unavailable", paths: ["model.bin"] });
		assert.equal(readFileSync(join(slot(a, 0), "data.bin"), "utf8"), "LFS-CONTENT-1\n");
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "B\n");
	});

	test("a slot another process leases is busy (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);
		const lease = `${recordFile(a, 0)}.999-other.lease.lock`;
		mkdirSync(lease);

		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "busy" });

		rmSync(lease, { recursive: true });
		assert.equal((await claimIdleWorktree(b, claimOptions())).claimed, true);
	});

	test("a reset Git cannot write leaves the slot marked, and its record names the claim (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);
		const gitDir = await sandbox.git(slot(a, 0), "rev-parse", "--absolute-git-dir");
		writeFileSync(join(gitDir, "index.lock"), "");

		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "reset-failed" });

		assert.deepEqual(recordOf(a, 0).resetting, { snapshotId: b.id, head: b.head, tree: b.tree });
		assert.deepEqual(recordOf(a, 0).holder, Y);
	});

	test("a claim refuses a snapshot record that fails the security checks and leaves the slot as it was (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);
		const before = recordOf(a, 0);

		assert.deepEqual(await claimIdleWorktree({ ...b, id: "../not-a-snapshot-id" }, claimOptions()), {
			claimed: false,
			reason: "fetch-failed",
		});

		assert.deepEqual(recordOf(a, 0), before);
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "A\n");
	});

	test("a marked slot is never claimed, even unchanged, and eviction removes it without counting it (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const [, z] = await idleSlots(a, clone, 2);
		// A claim stopped right after marking slot 0, before its files changed.
		writeFileSync(
			recordFile(a, 0),
			JSON.stringify({ ...recordOf(a, 0), resetting: { snapshotId: b.id, head: b.head, tree: b.tree } }),
		);
		const held = await holdRestoredWorktree(storeDir(), slot(a, 1), { kind: "session", id: z!.getSessionId() });
		assert.ok(held);
		// Slot 1 is busy, and slot 0, though exactly in its recorded state, is marked.
		assert.equal((await claimIdleWorktree(b, claimOptions())).claimed, false);
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "A\n");
		await releaseRestoredWorktree(held);

		const removed = await evictIdleWorktrees(storeDir(), repositoryIdOf(a.remotes), { maxIdle: 1, settings });

		assert.deepEqual(removed, [slot(a, 0)]);
		assert.equal(existsSync(slot(a, 1)), true);
	});

	test("a claim resets with Git's stored content whatever the machine's conversion settings, as a restore does (#4748)", async () => {
		const attributes = sandbox.path("global-attributes");
		writeFileSync(attributes, "*.txt text eol=crlf\n");
		appendFileSync(
			sandbox.globalConfig,
			`[core]\n\tautocrlf = true\n\tattributesFile = ${attributes.replace(/\\/g, "/")}\n`,
		);
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);

		const claim = await claimIdleWorktree(b, claimOptions());

		assert.equal(claim.claimed, true);
		if (claim.claimed) await releaseRestoredWorktree(claim.lease);
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "B\n");
	});

	test("a claim rewrites only the files that differ, so unchanged ones keep their timestamps (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);
		// README.md is tracked; shared.txt is untracked and recorded by both snapshots; file.txt differs.
		const mtime = (file: string) => statSync(join(slot(a, 0), file)).mtimeMs;
		const before = { readme: mtime("README.md"), shared: mtime("shared.txt"), file: mtime("file.txt") };
		await sleep(50);

		const claim = await claimIdleWorktree(b, claimOptions());

		assert.equal(claim.claimed, true);
		if (claim.claimed) await releaseRestoredWorktree(claim.lease);
		assert.deepEqual(
			{ readme: mtime("README.md"), shared: mtime("shared.txt"), file: mtime("file.txt") === before.file },
			{ readme: before.readme, shared: before.shared, file: false },
		);
	});
});
