import { getAgentDir, SettingsManager } from "@bastani/atomic";
import { storageSelectionKey } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "./backend.js";
import {
	getDurableBackendProcessOwner,
	resetDurableBackendProcessOwner,
	type SelectedDurableBackend,
} from "./backend-process-owner.js";
import { JournalDurableBackend } from "./journal/journal-backend.js";
import {
	openSelectedRunJournal,
	type RunJournalOption,
	type RunJournalSettings,
	selectRunJournal,
	withRunJournalConfigSource,
} from "./journal/resolution.js";

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
	projectTrusted?: boolean;
	/** The agent directory the owning session resolved its storage against; defaults to `getAgentDir()`. */
	agentDir?: string;
	/**
	 * The session holding the selected backend. A settings-selected memory journal is scoped to it, and
	 * `releaseDurableBackendsHeldBy` closes the backend once no holder remains. Without one the backend is
	 * shared process-wide until exit.
	 */
	holder?: object;
}

export async function initializeDurableBackend(options: DurableBackendOptions = {}): Promise<DurableWorkflowBackend> {
	const owner = getDurableBackendProcessOwner();
	const choice = options.journal;
	const agentDir = options.agentDir ?? getAgentDir();
	const selection = selectRunJournal({
		agentDir,
		journal: choice,
		settings:
			choice === undefined
				? (options.settings ??
					SettingsManager.create(options.cwd ?? process.cwd(), agentDir, {
						projectTrusted: options.projectTrusted,
					}).getSettings())
				: undefined,
	});
	const holder = options.holder;
	const key =
		"createRun" in selection
			? selection
			: selection.kind === "memory" && choice !== undefined
				? choice
				: selection.kind === "memory" && holder !== undefined
					? holder
					: storageSelectionKey(selection, agentDir);
	const ownsJournal = choice === undefined || !("createRun" in choice);
	owner.selectedBackends ??= new Map();
	const selected = owner.selectedBackends;
	const existing = selected.get(key);
	const entry: SelectedDurableBackend = existing ?? {
		ready: openSelectedRunJournal(selection, agentDir)
			.then((journal) => JournalDurableBackend.open(journal, { ownsJournal }))
			.then((opened) => {
				if (ownsJournal) opened.closeOnProcessExit();
				entry.close = () => opened.close();
				return opened;
			})
			.catch((error: Error) => {
				if (selected.get(key) === entry) selected.delete(key);
				throw error;
			}),
		holders: new Set(),
		pinned: false,
	};
	if (existing === undefined) selected.set(key, entry);
	if (holder === undefined) entry.pinned = true;
	else entry.holders.add(holder);
	return withRunJournalConfigSource(selection, () => entry.ready);
}
