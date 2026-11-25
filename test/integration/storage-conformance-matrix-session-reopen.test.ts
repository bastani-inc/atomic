import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { backendLabel, runnerFor, withSqlSessionStore } from "./storage-conformance-matrix-helpers.js";

/**
 * Reopen session-store behavioural contract on every storage backend (#4793): a SQLite file, a libSQL server and
 * Postgres.
 */

useTemporaryAgentDir();

for (const backend of storageBackends) {
	const name = backendLabel(backend);
	registerSessionStoreConformance(
		runnerFor(backend, { includeSuite: (suite) => suite.endsWith(" (reopen)") }),
		`SqlSessionStore on ${name}`,
		withSqlSessionStore(backend),
	);
}
