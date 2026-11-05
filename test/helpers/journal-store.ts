import { join } from "node:path";

/** The environment of a process launched with no journal setting at all, in its own Atomic home `directory`. */
export function journalStoreEnvironment(directory: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		HOME: directory,
		ATOMIC_CODING_AGENT_DIR: join(directory, "agent"),
	};
	for (const name of ["ATOMIC_WORKFLOW_JOURNAL_PATH", "ATOMIC_WORKFLOWS_JOURNAL", "ATOMIC_STORAGE"])
		delete environment[name];
	return environment;
}

/** The journal store a process launched with `journalStoreEnvironment(directory)` uses. */
export function journalStoreDirectory(directory: string): string {
	return join(directory, "workflows", "journal");
}
