import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../packages/workflows/src/shared/workflow-artifact-env.js";
import { removeLeftoverTestDirectories } from "./helpers/test-directory-removal.js";

const LEFTOVER_REMOVAL_RETRIES = { retries: 28, retryDelayMs: 50 };

/**
 * One workflow-artifact directory per vitest run, owned by the orchestrator.
 *
 * `test/setup-workflow-durability.ts` needs `ENV_WORKFLOW_ARTIFACT_DIR` set in
 * every worker so real builtin workflows cannot write run directories into the
 * developer's home. Creating the directory in the workers themselves cannot be
 * leak-free: under the default isolated forks pool each test file gets a fresh
 * process, and tinypool tears workers down with SIGTERM followed by SIGKILL
 * after 500 ms, so any worker that loses that race leaks its directory. That
 * is how 330k `atomic-test-workflow-artifacts-*` directories accumulated in
 * the OS temp dir, which made every `mkdtemp` under `tmpdir()` machine-wide
 * take seconds.
 *
 * This global setup runs once in the orchestrator, which forks every worker,
 * so workers inherit the variable and create nothing. The teardown runs after
 * the pool is gone. An inherited value is respected: the parent owns it, and
 * with several projects in one invocation only the first project's setup
 * creates the directory while the rest see it already present.
 */
export default function setup(): (() => Promise<void>) | undefined {
	if (process.env[ENV_WORKFLOW_ARTIFACT_DIR] !== undefined) return undefined;
	const artifactDir = mkdtempSync(join(tmpdir(), "atomic-test-workflow-artifacts-"));
	process.env[ENV_WORKFLOW_ARTIFACT_DIR] = artifactDir;
	return async () => {
		delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		const kept = await removeLeftoverTestDirectories(artifactDir, LEFTOVER_REMOVAL_RETRIES);
		if (kept.length > 0)
			console.warn(`Could not remove ${kept.length} test directories Windows still holds: ${kept.join(", ")}`);
		try {
			rmSync(artifactDir, { recursive: true, force: true });
		} catch {
			// A failed removal is only a leaked temp dir; never fail the run for it.
		}
	};
}
