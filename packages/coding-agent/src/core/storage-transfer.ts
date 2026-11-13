/**
 * `atomic storage export` and `import` (#4716, #4720): sessions and workflow runs as JSONL files, one per session in
 * `<dir>/sessions` and one per run in `<dir>/workflows`. Import reads only those two subdirectories.
 */

import { join } from "node:path";
import {
	applySessionImport,
	pendingSessions,
	planSessionImport,
	readSessionExports,
	type SessionImportReport,
} from "./session-transfer.ts";
import {
	applyWorkflowRunImport,
	planWorkflowRunImport,
	readWorkflowRunExports,
	type WorkflowRunImportReport,
	type WorkflowRunTransferStorage,
} from "./storage/journal-transfer.js";
import type { SessionStore } from "./storage/session/types.js";
import {
	isStorageImportIncompleteError,
	SESSIONS_TRANSFER_DIRECTORY,
	StorageImportIncompleteError,
	WORKFLOWS_TRANSFER_DIRECTORY,
} from "./storage/transfer-files.js";

/** The directory of an export directory that holds its sessions. */
export function sessionsTransferDirectory(directory: string): string {
	return join(directory, SESSIONS_TRANSFER_DIRECTORY);
}

/** The directory of an export directory that holds its workflow runs. */
export function workflowsTransferDirectory(directory: string): string {
	return join(directory, WORKFLOWS_TRANSFER_DIRECTORY);
}

/** Where an import writes each kind it imports; a kind without a target is not read. */
export interface StorageImportTargets {
	readonly sessions?: SessionStore;
	readonly workflows?: WorkflowRunTransferStorage;
}

export interface StorageImportReport {
	readonly sessions?: SessionImportReport;
	readonly workflows?: WorkflowRunImportReport;
}

/**
 * Imports the sessions and workflow runs exported to `directory`. Every file of both kinds is read and checked, and
 * every session and run compared with the storage's copy, before anything is written: a malformed file, an unsupported
 * version, or a session or run that continued differently here fails the import with the file and line, and nothing
 * is written. Workflow runs are then written under the write locks of every journal file they go to, and sessions
 * after them. A failure after something was written throws `StorageImportIncompleteError`, which names exactly what was
 * written and what was not; importing again writes only what is missing.
 */
export async function importStorage(directory: string, targets: StorageImportTargets): Promise<StorageImportReport> {
	const sessionFiles =
		targets.sessions === undefined ? undefined : await readSessionExports(sessionsTransferDirectory(directory));
	const runFiles =
		targets.workflows === undefined ? undefined : await readWorkflowRunExports(workflowsTransferDirectory(directory));
	const sessionPlan =
		targets.sessions === undefined ? undefined : await planSessionImport(targets.sessions, sessionFiles!);
	const runPlan =
		targets.workflows === undefined ? undefined : await planWorkflowRunImport(targets.workflows, runFiles!);
	let workflows: WorkflowRunImportReport | undefined;
	if (runPlan !== undefined) {
		try {
			workflows = await applyWorkflowRunImport(runPlan);
		} catch (error) {
			if (!isStorageImportIncompleteError(error) || sessionPlan === undefined) throw error;
			throw new StorageImportIncompleteError(error.cause as Error, {
				written: error.written,
				notWritten: { ...error.notWritten, sessions: pendingSessions(sessionPlan) },
			});
		}
	}
	const sessions =
		sessionPlan === undefined
			? undefined
			: await applySessionImport(
					sessionPlan,
					workflows === undefined ? [] : [...workflows.added, ...workflows.updated],
				);
	return { ...(sessions === undefined ? {} : { sessions }), ...(workflows === undefined ? {} : { workflows }) };
}
