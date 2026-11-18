import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import { lockShared } from "../src/core/worktree-snapshot/shared-clock.js";

const administration = vi.hoisted(() => ({ enabled: false, failCheckout: false, commands: new Set<string>() }));
vi.mock("../src/core/worktree-snapshot/git.ts", async (original) => {
	const actual = await original<typeof import("../src/core/worktree-snapshot/git.js")>();
	return {
		...actual,
		runGit: async (
			args: readonly string[],
			options: import("../src/core/worktree-snapshot/git.js").GitRunOptions,
		) => {
			if (administration.enabled && args[0] === "worktree") {
				const store = options.env?.GIT_DIR;
				assert.ok(store);
				let competingWriter = false;
				try {
					const release = await lockShared(store, { realpath: false, retries: 0 });
					await release();
					competingWriter = true;
				} catch (error) {
					assert.equal((error as NodeJS.ErrnoException).code, "ELOCKED");
				}
				assert.equal(competingWriter, false, `${args.join(" ")} admitted a competing repository writer`);
				administration.commands.add(args[1]!);
			}
			if (
				administration.enabled &&
				administration.failCheckout &&
				args.includes("--reset") &&
				args.includes("read-tree")
			) {
				administration.failCheckout = false;
				throw new Error("fixture checkout failed");
			}
			return actual.runGit(args, options);
		},
	};
});
vi.resetModules();
const { removeRestoredWorktree, restoreWorktree } = await import("../src/core/worktree-snapshot/restore.js");
const { withWorktreeSnapshotGit } = await import("../src/core/worktree-snapshot/git.js");

useTemporaryAgentDir();
let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
	administration.enabled = false;
	administration.failCheckout = false;
	administration.commands.clear();
});
afterEach(() => {
	administration.enabled = false;
	sandbox.dispose();
});

async function snapshot() {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "state.txt"), "saved\n");
	await sandbox.commitAll(clone, "saved");
	await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
	const captured = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: new MemorySnapshotBlobStore(),
	});
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") throw new Error(captured.status);
	return captured.snapshot;
}

test("restoring and removing worktrees excludes competing shared-repository administration (#4951)", async () => {
	const saved = await snapshot();
	const storeDir = sandbox.path("store");
	administration.enabled = true;
	const outcomes = await Promise.allSettled([
		restoreWorktree(saved, { storeDir, git: sandbox.executable }),
		restoreWorktree(saved, { storeDir, git: sandbox.executable }),
	]);
	const restored = outcomes.map((outcome) => {
		if (outcome.status === "rejected") throw outcome.reason;
		return outcome.value;
	});
	for (const worktree of restored) {
		assert.equal(await sandbox.git(worktree.path, "rev-parse", "HEAD"), saved.head);
		await withWorktreeSnapshotGit(sandbox.executable, () => removeRestoredWorktree(worktree.path, { storeDir }));
	}
	assert.deepEqual([...administration.commands].sort(), ["add", "list", "move", "prune", "remove"]);
});

test("failed checkout cleanup also excludes competing shared-repository administration (#4951)", async () => {
	const saved = await snapshot();
	administration.enabled = true;
	administration.failCheckout = true;
	await assert.rejects(
		restoreWorktree(saved, { storeDir: sandbox.path("store"), git: sandbox.executable }),
		(error: Error) => {
			assert.equal(error.message, "fixture checkout failed");
			assert.equal(Object.hasOwn(error, "cleanupCause"), false);
			return true;
		},
	);
	for (const command of ["add", "list", "unlock", "prune"]) assert.ok(administration.commands.has(command), command);
	// Git never deletes a restore's worktree: cleanup sets it aside and deletes only what it checked (#4748).
	assert.equal(administration.commands.has("remove"), false);
});
