import { dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@bastani/atomic";
import { MemoryRunJournal } from "./memory-run-journal.js";
import { SqliteRunJournal, workflowJournalPath } from "./sqlite-run-journal.js";
import { JournalConfigurationError, type RunJournal } from "./types.js";

export type RunJournalOption = { path: string } | { database: DatabaseSync } | { memory: true } | RunJournal;

export interface RunJournalSettings {
	workflows?: string[] | { journal?: { path?: string; memory?: boolean } };
}

export function resolveRunJournal(
	options: { journal?: RunJournalOption; settings?: RunJournalSettings } = {},
): RunJournal {
	const explicit = options.journal;
	if (explicit !== undefined) {
		if ("createRun" in explicit) return explicit;
		if ("path" in explicit) return new SqliteRunJournal(explicit.path);
		if ("database" in explicit) return new SqliteRunJournal(explicit.database);
		return new MemoryRunJournal();
	}
	const environment = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	if (environment !== undefined && environment.length > 0) return new SqliteRunJournal(environment);
	const workflows = options.settings?.workflows;
	const settings = Array.isArray(workflows) ? undefined : workflows?.journal;
	const path = settings?.path;
	if (path !== undefined && path.length > 0) {
		if (settings?.memory === true)
			throw new JournalConfigurationError("settings", "workflows.journal", "path-and-memory");
		return new SqliteRunJournal(isAbsolute(path) ? path : join(dirname(getAgentDir()), path));
	}
	if (settings?.memory === true) return new MemoryRunJournal();
	return new SqliteRunJournal(workflowJournalPath());
}
