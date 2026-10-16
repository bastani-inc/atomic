import { dirname, isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@bastani/atomic";
import { MemoryRunJournal } from "./memory-run-journal.js";
import { openSqlRunJournal, workflowJournalPath } from "./sqlite-run-journal.js";
import { JournalConfigurationError, type RunJournal } from "./types.js";

export type RunJournalOption = { path: string } | { database: DatabaseSync } | { memory: true } | RunJournal;

export interface RunJournalSettings {
	workflows?: string[] | { journal?: { path?: string; memory?: boolean } };
}

/** Resolve configuration without opening storage, so callers can reuse an existing selection. */
export function selectRunJournal(
	options: { journal?: RunJournalOption; settings?: RunJournalSettings } = {},
): RunJournalOption {
	if (options.journal !== undefined) return options.journal;
	const environment = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	if (environment !== undefined && environment.length > 0) return { path: environment };
	const workflows = options.settings?.workflows;
	const settings = Array.isArray(workflows) ? undefined : workflows?.journal;
	const path = settings?.path;
	if (path !== undefined && path.length > 0) {
		if (settings?.memory === true)
			throw new JournalConfigurationError("settings", "workflows.journal", "path-and-memory");
		return { path: isAbsolute(path) ? path : join(dirname(getAgentDir()), path) };
	}
	if (settings?.memory === true) return { memory: true };
	return { path: workflowJournalPath() };
}

export async function resolveRunJournal(
	options: { journal?: RunJournalOption; settings?: RunJournalSettings } = {},
): Promise<RunJournal> {
	const selected = selectRunJournal(options);
	if ("createRun" in selected) return selected;
	if ("path" in selected) return await openSqlRunJournal(selected.path);
	if ("database" in selected) return await openSqlRunJournal(selected.database);
	return new MemoryRunJournal();
}
