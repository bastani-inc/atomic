import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../../workflows/src/shared/workflow-artifact-env.js";
import { getExtensionTranspileCacheDir } from "../../src/config.ts";

/**
 * The extension transpile cache every test agent directory linked by `linkSharedTranspileCache` uses: one per vitest
 * run, under the run's workflow-artifact directory, which the orchestrator creates before the workers start and removes
 * after they exit (`test/global-setup-workflow-artifacts.ts`).
 */
function sharedCacheDir(): string {
	const runDirectory = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	if (runDirectory === undefined) throw new Error(`${ENV_WORKFLOW_ARTIFACT_DIR} is unset`);
	const dir = join(runDirectory, "shared-extension-transpile-cache");
	mkdirSync(dir, { recursive: true });
	return dir;
}

let shared: string | undefined;

/**
 * Point a test's new agent directory at one extension transpile cache shared across the run, so the builtin packages'
 * TypeScript graph is compiled once, not once per test.
 *
 * The transpile cache lives under each load's agent directory (#4728), and a test that makes a new agent directory
 * starts with an empty one: its first transformed load compiles the whole builtin graph, 11-15 s on an idle machine and
 * past the 30 s budget under a full shard. Entries are keyed by source content and resolved siblings and are written by
 * rename, so tests and workers can share them. Only the cache is shared: the agent directory stays the test's own, and
 * its `cache/jiti/<version>` directory becomes a link (a junction on Windows) to the shared one, which removing the
 * agent directory unlinks without touching. Creates the agent directory if needed; call it before anything loads
 * extensions under it. Where the link cannot be made, the test keeps a private cache, as without this helper.
 */
export function linkSharedTranspileCache(agentDir: string): void {
	const cacheDir = getExtensionTranspileCacheDir(agentDir);
	mkdirSync(dirname(cacheDir), { recursive: true });
	try {
		shared ??= sharedCacheDir();
		symlinkSync(shared, cacheDir, "junction");
	} catch {
		// No link (no symlink rights, another volume): the loader creates a private cache under the agent directory.
	}
}
