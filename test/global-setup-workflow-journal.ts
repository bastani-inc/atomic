import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_WORKFLOW_JOURNAL_PATH = "ATOMIC_WORKFLOW_JOURNAL_PATH";

/**
 * One workflow run journal per vitest run, owned by the orchestrator.
 *
 * SDK suites run real workflows through `createAgentSession({ agentDir })`, but the
 * run journal resolves its default from the process-wide agent directory, so those
 * runs landed in the developer's `~/.atomic/workflows/journal.sqlite`. Pointing
 * `ATOMIC_WORKFLOW_JOURNAL_PATH` at a temporary file before the pool forks keeps
 * every worker's runs out of it, following `global-setup-workflow-artifacts.ts`.
 * An inherited value is respected, and tests that exercise the default path stub
 * the variable themselves.
 */
export default function setup(): (() => void) | undefined {
	if (process.env[ENV_WORKFLOW_JOURNAL_PATH] !== undefined) return undefined;
	const journalDir = mkdtempSync(join(tmpdir(), "atomic-test-workflow-journal-"));
	process.env[ENV_WORKFLOW_JOURNAL_PATH] = join(journalDir, "journal.sqlite");
	return () => {
		delete process.env[ENV_WORKFLOW_JOURNAL_PATH];
		try {
			rmSync(journalDir, { recursive: true, force: true });
		} catch {
			// A failed removal is only a leaked temp dir; never fail the run for it.
		}
	};
}
