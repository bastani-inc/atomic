/**
 * `atomic storage export` and `import` (#4716, #4720): sessions as JSONL files, one per session in `<dir>/sessions`.
 * Import reads only that subdirectory; the `workflows` subdirectory an export of an earlier release wrote is left unread.
 */

import { join } from "node:path";
import {
	applySessionImport,
	planSessionImport,
	readSessionExports,
	type SessionImportReport,
} from "./session-transfer.ts";
import type { SessionStore } from "./storage/session/types.js";
import { SESSIONS_TRANSFER_DIRECTORY } from "./storage/transfer-files.js";

/** The directory of an export directory that holds its sessions. */
export function sessionsTransferDirectory(directory: string): string {
	return join(directory, SESSIONS_TRANSFER_DIRECTORY);
}

/** Where an import writes the sessions it imports. */
export interface StorageImportTargets {
	readonly sessions: SessionStore;
}

export interface StorageImportReport {
	readonly sessions: SessionImportReport;
}

/**
 * Imports the sessions exported to `directory`. Every file is read and checked, and every session compared with the
 * storage's copy, before anything is written: a malformed file, an unsupported version, or a session that continued
 * differently here fails the import with the file and line, and nothing is written. A failure after something was
 * written throws `StorageImportIncompleteError`, which names exactly what was written and what was not; importing
 * again writes only what is missing.
 */
export async function importStorage(directory: string, targets: StorageImportTargets): Promise<StorageImportReport> {
	const files = await readSessionExports(sessionsTransferDirectory(directory));
	const plan = await planSessionImport(targets.sessions, files);
	return { sessions: await applySessionImport(plan) };
}
