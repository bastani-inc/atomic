import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { createInMemoryTestBackend, setDurableBackend } from "../packages/workflows/src/durable/factory.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../packages/workflows/src/shared/workflow-artifacts.js";

/**
 * Durable workflow artifacts (stage transcripts, ledgers, run notes) default to
 * the user's Atomic config root. Redirect them per test process so suites that
 * execute real builtin workflows cannot accumulate run directories in a
 * developer's home directory.
 */
process.env[ENV_WORKFLOW_ARTIFACT_DIR] ??= mkdtempSync(join(tmpdir(), "atomic-test-workflow-artifacts-"));

/**
 * Product runtime always uses DBOS. Unit and integration tests explicitly run
 * against an isolated current-interface backend unless a test installs its own
 * DBOS adapter.
 */
beforeEach(() => {
	setDurableBackend(createInMemoryTestBackend());
});
