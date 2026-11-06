import { fileURLToPath } from "node:url";
import { beforeEach } from "vitest";
import { setWorktreeSnapshotExcludedRootsForTest } from "../../packages/coding-agent/src/core/worktree-snapshot/excluded-roots.js";

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
