import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifact-env.js";

const AGENT_DIR_ENV = "ATOMIC_CODING_AGENT_DIR";

/**
 * A new agent directory, `.atomic/agent` under a fresh `agent-home-*` directory inside the run's workflow-artifact
 * directory. The orchestrator removes that directory once every test process has exited: code under test may hold a
 * store it opened there until its process ends, and Windows cannot delete a database file that is still open.
 */
export function temporaryAgentDir(runDirectory: string | undefined): string {
	if (runDirectory === undefined) {
		throw new Error(
			`${ENV_WORKFLOW_ARTIFACT_DIR} is unset: load test/setup-workflow-durability.ts before this helper`,
		);
	}
	return join(mkdtempSync(join(runDirectory, "agent-home-")), ".atomic", "agent");
}

/**
 * Set an environment variable and return what puts its previous value, or its absence, back. Not `vi.stubEnv`: a
 * test's `vi.unstubAllEnvs()` would drop it for the rest of the file.
 */
export function replaceEnvironmentVariable(name: string, value: string): () => void {
	const previous = process.env[name];
	process.env[name] = value;
	return () => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	};
}

/**
 * Give the calling test file an agent directory of its own (#4445), so a store that falls back to its default
 * location, such as the session store at `<agent dir>/../workflows/journal.sqlite`, opens under a temporary home
 * instead of the user's. `ATOMIC_CODING_AGENT_DIR` is restored after the file's last test. Returns the agent directory.
 */
export function useTemporaryAgentDir(): string {
	const agentDir = temporaryAgentDir(process.env[ENV_WORKFLOW_ARTIFACT_DIR]);
	afterAll(replaceEnvironmentVariable(AGENT_DIR_ENV, agentDir));
	return agentDir;
}
