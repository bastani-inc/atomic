import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach } from "vitest";
import { setWorktreeSnapshotExcludedRootsForTest } from "../../packages/coding-agent/src/core/worktree-snapshot/excluded-roots.js";
import {
	failTestsThatOpenRealHomeStorage,
	installRealHomeStorageGuard,
	realHomeAtomicRoots,
} from "./real-home-storage-guard.js";

/**
 * Every vitest project loads this file, so no test captures, verifies or restores a worktree snapshot of the checkout
 * the suites run from (#4414). Snapshot Git treats the checkout as outside any repository, which is what a test sees
 * in a temporary directory: a workflow or session that runs with its cwd in the checkout records nothing, and a resume
 * never tries to fetch the checkout's commit from a remote. Snapshot tests use repositories under the temporary
 * directory, which this leaves alone.
 *
 * The excluded-roots module imports nothing, so loading it here evaluates none of the modules a test may mock.
 */
const checkout = fileURLToPath(new URL("../..", import.meta.url));

setWorktreeSnapshotExcludedRootsForTest([checkout]);
beforeEach(() => {
	setWorktreeSnapshotExcludedRootsForTest([checkout]);
});

/**
 * No test opens a SQLite database under the real home directory's `.atomic` root either (#4445). A store that falls
 * back to its default location, such as the session store `/workflow resume <unknown id>` opens, otherwise lands in
 * the user's own `~/.atomic/workflows/journal.sqlite`, where every test file of a shard shares it with the others and
 * with the user's sessions; on Windows its switch to the write-ahead log failed with a disk I/O error. The guard
 * rejects the open before SQLite creates the file and fails the test even when the code that opened it caught the
 * error; such a test needs its own agent directory (`useTemporaryAgentDir`). It covers this test process, not the
 * child processes a test starts. The guard module imports only Node built-ins.
 */
failTestsThatOpenRealHomeStorage(installRealHomeStorageGuard(realHomeAtomicRoots()), { afterEach, afterAll });
