import { resolve } from "node:path";
import { SettingsManager } from "@bastani/atomic";
import type { DurableWorkflowBackend } from "./backend.js";
import {
	getDurableBackendProcessOwner,
	resetDurableBackendProcessOwner,
	type SelectedDurableBackend,
} from "./backend-process-owner.js";
import { JournalDurableBackend } from "./journal/journal-backend.js";
import { type RunJournalOption, type RunJournalSettings, resolveRunJournal } from "./journal/resolution.js";
import { SqliteRunJournal } from "./journal/sqlite-run-journal.js";
import { JournalError } from "./journal/types.js";

const DEFAULT_MEMORY_JOURNAL = "memory";

export class DurableBackendNotInitializedError extends JournalError {
	constructor() {
		super("Workflow journal has not been initialized");
		this.name = "DurableBackendNotInitializedError";
	}
}

export function getDurableBackend(): DurableWorkflowBackend {
	const backend = getAvailableDurableBackend();
	if (backend === undefined) throw new DurableBackendNotInitializedError();
	return backend;
}

export function getAvailableDurableBackend(): DurableWorkflowBackend | undefined {
	const owner = getDurableBackendProcessOwner();
	return owner.injectedBackend ?? owner.initializedBackend;
}

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
	if (choice === undefined && owner.injectedBackend !== undefined) return owner.injectedBackend;
	const journal = resolveRunJournal({
		journal: choice,
		settings:
			choice === undefined
				? (options.settings ?? SettingsManager.create(options.cwd ?? process.cwd()).getSettings())
				: undefined,
	});
	const key =
		choice === undefined
			? journal instanceof SqliteRunJournal
				? resolve(journal.path)
				: DEFAULT_MEMORY_JOURNAL
			: "createRun" in choice
				? choice
				: "path" in choice
					? resolve(choice.path)
					: "database" in choice
						? choice.database
						: choice;
	const ownsJournal = choice === undefined || !("createRun" in choice);
	owner.selectedBackends ??= new Map();
	const selected = owner.selectedBackends;
	const existing = selected.get(key);
	let backend: DurableWorkflowBackend;
	if (existing !== undefined) {
		if (ownsJournal) await journal.close();
		backend = await existing.ready;
	} else {
		const ready = JournalDurableBackend.open(journal, { ownsJournal })
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
	if (choice === undefined) owner.initializedBackend = backend;
	return backend;
}
