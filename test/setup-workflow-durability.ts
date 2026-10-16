import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { getDurableBackendProcessOwner } from "../packages/workflows/src/durable/backend-process-owner.js";
import { bindStoreDurableBackend } from "../packages/workflows/src/durable/store-backend.js";
import type { Store } from "../packages/workflows/src/shared/store-public-types.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../packages/workflows/src/shared/workflow-artifact-env.js";
import { closeMemoryTestBackends, MemoryJournalBackend as InMemoryDurableBackend } from "./helpers/workflow-journal.js";

/**
 * Durable workflow artifacts (stage transcripts, ledgers, run notes) default to
 * the user's Atomic config root. Redirect them per test process so suites that
 * execute real builtin workflows cannot accumulate run directories in a
 * developer's home directory.
 *
 * The normal path sets nothing here: `test/global-setup-workflow-artifacts.ts`
 * creates one directory per run in the orchestrator, every worker inherits the
 * variable, and the orchestrator's teardown removes it. This block is the
 * fallback for invocations that bypass the repo config's globalSetup.
 *
 * When the fallback does create a directory, it removes it on process exit —
 * under the isolated forks pool that is one directory per test file, and
 * leaking them is how 330k accumulated in the OS temp dir. The SIGTERM
 * handler is load-bearing: tinypool ends pool forks with SIGTERM, whose
 * default disposition skips `exit` listeners, so it is converted to a normal
 * exit first. Workers that lose tinypool's 500 ms SIGTERM-to-SIGKILL race
 * still leak, which is why the orchestrator-owned path above is the primary.
 */
if (process.env[ENV_WORKFLOW_ARTIFACT_DIR] === undefined) {
	const artifactDir = mkdtempSync(join(tmpdir(), "atomic-test-workflow-artifacts-"));
	process.env[ENV_WORKFLOW_ARTIFACT_DIR] = artifactDir;
	process.on("exit", () => {
		try {
			rmSync(artifactDir, { recursive: true, force: true });
		} catch {
			// Never let cleanup turn a green exit into a crash; a survivor is
			// only a leaked temp dir.
		}
	});
	process.once("SIGTERM", () => {
		process.exit();
	});
}

// Do not import the store factory here: its host barrel would run before test-local mocks.
// Reset only the already-constructed singleton fixture, never independently constructed stores.
function resetConstructedStoreFixture(backend: InMemoryDurableBackend): void {
	type Registry = { readonly byKey: Map<string, { readonly local: Store; readonly instance?: Store }> };
	const registry = (globalThis as typeof globalThis & Record<symbol, Registry | undefined>)[
		Symbol.for("atomic-workflows/session-scoped-singleton-pre-adoption@1")
	];
	const slot = registry?.byKey.get("workflows:store:v1");
	if (slot !== undefined) bindStoreDurableBackend(slot.instance ?? slot.local, backend);
}

/** Tests inject an isolated backend unless they explicitly open a journal. */
beforeEach(() => {
	const backend = new InMemoryDurableBackend();
	getDurableBackendProcessOwner().injectedBackend = backend;
	resetConstructedStoreFixture(backend);
});

afterEach(closeMemoryTestBackends);
