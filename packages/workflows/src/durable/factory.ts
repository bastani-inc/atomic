import { resolve } from "node:path";
import { SettingsManager } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "./backend.js";
import {
	getDurableBackendProcessOwner,
	resetDurableBackendProcessOwner,
	type SelectedDurableBackend,
} from "./backend-process-owner.js";
import { JournalDurableBackend } from "./journal/journal-backend.js";
import {
	type RunJournalOption,
	type RunJournalSettings,
	resolveRunJournal,
	selectRunJournal,
} from "./journal/resolution.js";

const DEFAULT_MEMORY_JOURNAL = "memory";

/** Internal test injection, captured only when an owning store is constructed. */

export function setDurableBackend(backend: DurableWorkflowBackend | undefined): void {
	if (backend === undefined) {
		resetDurableBackendProcessOwner();
		return;
	}
	getDurableBackendProcessOwner().injectedBackend = backend;
}

export interface DurableBackendOptions {
	journal?: RunJournalOption;
	settings?: RunJournalSettings;
	cwd?: string;
}

export async function initializeDurableBackend(options: DurableBackendOptions = {}): Promise<DurableWorkflowBackend> {
	const owner = getDurableBackendProcessOwner();
	const choice = options.journal;
	const selection = selectRunJournal({
		journal: choice,
		settings:
			choice === undefined
				? (options.settings ?? SettingsManager.create(options.cwd ?? process.cwd()).getSettings())
				: undefined,
	});
	const key =
		"createRun" in selection
			? selection
			: "path" in selection
				? resolve(selection.path)
				: "database" in selection
					? selection.database
					: choice === undefined
						? DEFAULT_MEMORY_JOURNAL
						: choice;
	const ownsJournal = choice === undefined || !("createRun" in choice);
	owner.selectedBackends ??= new Map();
	const selected = owner.selectedBackends;
	const existing = selected.get(key);
	let backend: DurableWorkflowBackend;
	if (existing !== undefined) {
		backend = await existing.ready;
	} else {
		const ready = resolveRunJournal({ journal: selection })
			.then((journal) => JournalDurableBackend.open(journal, { ownsJournal }))
			.then((opened) => {
				if (ownsJournal) opened.closeOnProcessExit();
				entry.close = () => opened.close();
				return opened;
			})
			.catch((error: Error) => {
				selected.delete(key);
				throw error;
			});
		const entry: SelectedDurableBackend = { ready };
		selected.set(key, entry);
		backend = await ready;
	}
	return backend;
}
