import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach } from "vitest";
import { setWorktreeSnapshotExcludedRootsForTest } from "../../packages/coding-agent/src/core/worktree-snapshot/excluded-roots.js";
import { installRealHomeSettingsGuard, realHomeSettingsFiles } from "./real-home-settings-guard.js";
import {
	failTestsThatTouchRealHome,
	installRealHomeStorageGuard,
	realHomeAtomicRoots,
} from "./real-home-storage-guard.js";
import { installTemporaryAgentDirDefault } from "./temporary-agent-dir.js";

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
 * Every test file runs with an agent directory of its own (#4473): `ATOMIC_CODING_AGENT_DIR` points at a new
 * directory under the run's workflow-artifact directory before the file's modules load, and child processes that
 * inherit the environment use it too. A test opts out only by setting or unsetting the variable itself.
 *
 * No test opens a SQLite database under the real home directory's `.atomic` root (#4445), or reads the agent
 * `settings.json` there or under `.pi` (#4473). A store that falls back to its default location otherwise lands in the
 * user's own `~/.atomic/workflows/journal.sqlite`, shared with every other test file and the user's sessions, and a
 * settings load reads the user's own settings, which fail the test when they hold a renamed key. Each guard refuses
 * before the file is opened and fails the test even when the code that was refused caught the error, as the settings
 * manager does. They cover this test process; children are covered by the inherited agent directory. The guard
 * modules import only Node built-ins.
 */
installTemporaryAgentDirDefault();
failTestsThatTouchRealHome(installRealHomeStorageGuard(realHomeAtomicRoots()), { afterEach, afterAll });
failTestsThatTouchRealHome(installRealHomeSettingsGuard(realHomeSettingsFiles()), { afterEach, afterAll });
