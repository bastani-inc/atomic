import { JournalCatalogError, type StorageSelection } from "@bastani/atomic/storage";
import type { DurableWorkflowBackend } from "./backend.js";
import { JournalDurableBackend } from "./journal/journal-backend.js";
import { runJournalOrigin } from "./journal/resolution.js";
import { isShardedRunJournal } from "./journal/sharded-run-journal.js";

function describe(selection: StorageSelection): string {
	switch (selection.kind) {
		case "sharded":
			return `journal store ${selection.dir}`;
		case "sqlite":
			return `SQLite journal ${selection.path}`;
		case "adapter":
			return `storage adapter ${selection.module}`;
		case "database":
			return `caller-owned database ${selection.database.descriptor.adapter}`;
		default:
			return `${selection.kind} journal`;
	}
}

/**
 * The typed error for a run this machine's workflow storage does not hold. Storage other than a shared adapter is
 * local only, so the error names the command that joins shared storage, where a run started on another machine is.
 */
export function durableRunNotFoundError(backend: DurableWorkflowBackend, runId: string): JournalCatalogError {
	const journal = backend instanceof JournalDurableBackend ? backend.journal : undefined;
	const selection = journal === undefined ? undefined : runJournalOrigin(journal)?.selection;
	const location =
		journal !== undefined && isShardedRunJournal(journal)
			? journal.catalogPath
			: (journal as { readonly path?: string } | undefined)?.path;
	return new JournalCatalogError({
		code: "run-not-found",
		catalogPath: location ?? "",
		runId,
		selection: selection === undefined ? "this session's workflow store" : describe(selection),
		localOnly: selection?.kind !== "adapter",
	});
}

/** A run-not-found error as the CLI and TUI show it: the message, then what to do. */
export function formatRunNotFound(error: JournalCatalogError): string {
	return `${error.message}\n${error.hint}`;
}
