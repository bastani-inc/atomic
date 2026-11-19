import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getExtensionTranspileCacheDir } from "../../src/config.ts";

/**
 * The agent directory that owns the run's shared extension transpile cache, under the run's temporary
 * directory, which the orchestrator creates before the workers start and removes after they exit
 * (`test/global-setup-test-directory.ts`). `test/global-setup-warm-transpile-cache.ts` fills its cache once with a
 * real load of the builtin packages; `linkSharedTranspileCache` points tests at it.
 */
export function sharedTranspileAgentDir(runDirectory: string): string {
	return join(runDirectory, "shared-transpile-agent");
}

function sharedCacheDir(): string {
	const runDirectory = process.env.ATOMIC_TEST_RUN_DIR;
	if (runDirectory === undefined) throw new Error("ATOMIC_TEST_RUN_DIR is unset");
	const dir = getExtensionTranspileCacheDir(sharedTranspileAgentDir(runDirectory));
	mkdirSync(dir, { recursive: true });
	return dir;
}

let shared: string | undefined;

/**
 * Point a test's new agent directory at the extension transpile cache shared across the run, so the builtin packages'
 * TypeScript graph is compiled once per run, not once per test.
 *
 * The transpile cache lives under each load's agent directory (#4728), and a test that makes a new agent directory
 * starts with an empty one: its first transformed load compiles the whole builtin graph, 11-15 s on an idle machine and
 * past the 30 s budget under a full shard. Entries are keyed by source content and resolved siblings and are written by
 * rename, so tests and workers can share them. Only the cache is shared: the agent directory stays the test's own, and
 * its `cache/jiti/<version>` directory becomes a link (a junction on Windows) to the shared one, which removing the
 * agent directory unlinks without touching. Creates the agent directory if needed; call it before anything loads
 * extensions under it. Returns false where the link cannot be made (no symlink rights, another volume): the test then
 * keeps a private cache under its agent directory, as without this helper.
 *
 * Tests that assert transpile-cache behaviour themselves (`extensions-transpile-cache-agent-dir.test.ts`,
 * `blueprint-cache.test.ts`) must not use it.
 */
export function linkSharedTranspileCache(agentDir: string): boolean {
	const cacheDir = getExtensionTranspileCacheDir(agentDir);
	mkdirSync(dirname(cacheDir), { recursive: true });
	try {
		shared ??= sharedCacheDir();
		symlinkSync(shared, cacheDir, "junction");
		return true;
	} catch {
		return false;
	}
}
