import {
	JournalCatalogError,
	type SerializedJournalStoreError,
	type StorageSelection,
	serializeJournalStoreError,
} from "@bastani/atomic/storage";
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
	if (journal === undefined) return runNotFound(runId, "", undefined);
	const location = isShardedRunJournal(journal)
		? journal.catalogPath
		: ((journal as { readonly path?: string }).path ?? "");
	return runNotFound(runId, location, runJournalOrigin(journal)?.selection);
}

function runNotFound(runId: string, catalogPath: string, selection: StorageSelection | undefined): JournalCatalogError {
	return new JournalCatalogError({
		code: "run-not-found",
		catalogPath,
		runId,
		selection: selection === undefined ? "this session's workflow store" : describe(selection),
		localOnly: selection?.kind !== "adapter",
	});
}

/** A run-not-found error as the CLI and TUI show it: the message, then what to do. */
export function formatRunNotFound(error: JournalCatalogError): string {
	return `${error.message}\n${error.hint}`;
}

/**
 * The `resume` result of the workflow tool for a run this machine's storage does not hold: the message and hint as the
 * CLI shows them, and the typed error serialized so an SDK caller receives it as the cause of its failure.
 */
export function runNotFoundResumeResult(
	backend: DurableWorkflowBackend,
	runId: string,
): {
	readonly action: "resume";
	readonly runId: string;
	readonly status: "noop";
	readonly message: string;
	readonly code: "run_not_found";
	readonly failure: SerializedJournalStoreError;
} {
	const error = durableRunNotFoundError(backend, runId);
	return {
		action: "resume",
		runId,
		status: "noop",
		message: formatRunNotFound(error),
		code: "run_not_found",
		failure: serializeJournalStoreError(error),
	};
}
