import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, selectProcessStorage } from "@bastani/atomic";
import {
	type RunJournalOption,
	StorageConfigError,
	StorageProvider,
	type StorageSelection,
	type StorageSettingsSelection,
	selectStorage,
} from "@bastani/atomic/storage";
import { MemoryRunJournal } from "./memory-run-journal.js";
import { SqlRunJournal } from "./sql-run-journal.js";
import type { RunJournal } from "./types.js";

export type { RunJournalOption };
export interface RunJournalSettings {
	workflows?:
		| string[]
		| {
				journal?: StorageSettingsSelection;
				localWorkers?: import("../../workers/public-options.js").LocalWorkerOptions;
				admission?: import("../../workers/public-options.js").WorkflowAdmissionOptions;
		  };
	storage?: StorageSettingsSelection;
}

let hostModules: Readonly<Record<string, object>> = {};

/** Sets the live modules a journal adapter imports by specifier; the workflows entry modules provide themselves. */
export function provideRunJournalHostModules(modules: Readonly<Record<string, object>>): void {
	hostModules = modules;
}

const provider = new StorageProvider({
	memory: (descriptor) => new MemoryRunJournal(descriptor),
	sql: SqlRunJournal.open,
	get hostModules() {
		return hostModules;
	},
});
const origins = new WeakMap<StorageSelection, { source: "settings" | "cli" | "env"; field?: string }>();

export interface RunJournalResolutionOptions {
	journal?: RunJournalOption;
	settings?: RunJournalSettings;
	/** The agent directory the owning session resolved its storage against; defaults to `getAgentDir()`. */
	agentDir?: string;
}

export function selectRunJournal(options: RunJournalResolutionOptions = {}): StorageSelection | RunJournal {
	const agentDir = options.agentDir ?? getAgentDir();
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
	const processChoice = selectProcessStorage("journal", agentDir);
	if (processChoice !== undefined) {
		origins.set(processChoice.selection, { source: processChoice.source, field: processChoice.field });
		return processChoice.selection;
	}
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
	const resolved =
		selection.kind === "sqlite" && !isAbsolute(selection.path)
			? { ...selection, path: join(dirname(agentDir), selection.path) }
			: selection;
	origins.set(resolved, { source: "settings" });
	return resolved;
}

export async function resolveRunJournal(options: RunJournalResolutionOptions = {}): Promise<RunJournal> {
	return openSelectedRunJournal(selectRunJournal(options), options.agentDir);
}

/** The storage selection a journal was opened from, so another process can open the same journal. */
export interface RunJournalOrigin {
	readonly selection: StorageSelection;
	readonly agentDir: string;
}
const journalOrigins = new WeakMap<RunJournal, RunJournalOrigin>();

/** Where a journal came from; undefined for a journal an SDK caller passed as an object, which no other process can open. */
export function runJournalOrigin(journal: RunJournal): RunJournalOrigin | undefined {
	return journalOrigins.get(journal);
}

export async function openSelectedRunJournal(
	selection: StorageSelection | RunJournal,
	agentDir: string = getAgentDir(),
): Promise<RunJournal> {
	if ("createRun" in selection) return selection;
	const journal = await withRunJournalConfigSource(selection, () =>
		provider.openRunJournal(selection, { agentDir, domain: "journal" }),
	);
	if (!journalOrigins.has(journal)) journalOrigins.set(journal, { selection, agentDir });
	return journal;
}

export async function withRunJournalConfigSource<T>(
	selection: StorageSelection | RunJournal,
	open: () => Promise<T>,
): Promise<T> {
	if ("createRun" in selection) return open();
	try {
		return await open();
	} catch (error) {
		if (error instanceof StorageConfigError) {
			const origin = origins.get(selection);
			const source = origin?.source ?? "sdk";
			const field = origin?.field ?? error.field;
			if (error.source !== source || error.field !== field)
				throw new StorageConfigError(source, field, error.reason);
		}
		throw error;
	}
}
