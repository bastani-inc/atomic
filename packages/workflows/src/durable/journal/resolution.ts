import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@bastani/atomic";
import {
	type AdapterOptions,
	type SecretRef,
	type SqliteDatabase,
	StorageConfigError,
	StorageProvider,
	type StorageSelection,
	type StorageSettingsSelection,
	selectStorage,
} from "@bastani/atomic/storage";
import { MemoryRunJournal } from "./memory-run-journal.js";
import { SqlRunJournal } from "./sql-run-journal.js";
import type { RunJournal } from "./types.js";

export type RunJournalOption =
	| { path: string; prefix?: string }
	| { database: SqliteDatabase; prefix?: string }
	| { memory: true }
	| { adapter: string; options?: AdapterOptions; secrets?: Readonly<Record<string, SecretRef>>; prefix?: string }
	| RunJournal;
export interface RunJournalSettings {
	workflows?: string[] | { journal?: StorageSettingsSelection };
	storage?: StorageSettingsSelection;
}

const provider = new StorageProvider({
	memory: (descriptor) => new MemoryRunJournal(descriptor),
	sql: SqlRunJournal.open,
});

export function selectRunJournal(
	options: { journal?: RunJournalOption; settings?: RunJournalSettings } = {},
): StorageSelection | RunJournal {
	const agentDir = getAgentDir();
	const defaultPath = join(dirname(agentDir), "workflows", "journal.sqlite");
	if (options.journal !== undefined) {
		if (options.journal !== null && typeof options.journal === "object" && "createRun" in options.journal) {
			const journal = options.journal;
			if (
				[
					journal.createRun,
					journal.getRun,
					journal.listRuns,
					journal.acquire,
					journal.takeover,
					journal.takeoverExpired,
					journal.leaseState,
					journal.renew,
					journal.release,
					journal.append,
					journal.read,
					journal.readKey,
					journal.deleteOwnedRun,
					journal.deleteRun,
					journal.close,
				].some((hook) => typeof hook !== "function")
			) {
				throw new StorageConfigError("sdk", "journal", "invalid-journal");
			}
			return journal;
		}
		return selectStorage(options.journal, "sdk", "journal", defaultPath);
	}
	const environment = process.env.ATOMIC_WORKFLOW_JOURNAL_PATH;
	if (environment !== undefined && environment.length > 0) return { kind: "sqlite", path: environment };
	const workflows = options.settings?.workflows;
	const journal = Array.isArray(workflows) ? undefined : workflows?.journal;
	const value = journal !== undefined ? journal : options.settings?.storage;
	if (value === undefined) return { kind: "sqlite", path: defaultPath };
	const selection = selectStorage(
		value,
		"settings",
		journal !== undefined ? "workflows.journal" : "storage",
		journal !== undefined ? defaultPath : join(dirname(agentDir), "storage.sqlite"),
	);
	if (selection.kind === "sqlite" && !isAbsolute(selection.path)) {
		return { ...selection, path: join(dirname(agentDir), selection.path) };
	}
	return selection;
}

export async function resolveRunJournal(
	options: { journal?: RunJournalOption; settings?: RunJournalSettings } = {},
): Promise<RunJournal> {
	return openSelectedRunJournal(selectRunJournal(options));
}

export async function openSelectedRunJournal(selection: StorageSelection | RunJournal): Promise<RunJournal> {
	if ("createRun" in selection) return selection;
	return provider.openRunJournal(selection, { agentDir: getAgentDir(), domain: "journal" });
}
