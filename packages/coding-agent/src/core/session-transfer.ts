/**
 * Sessions as format-4 JSONL files for `atomic storage export` and `import` (#4720): each session is written to
 * `<dir>/<sessionId>.jsonl` in the format JSONL session storage keeps and `atomic --import` reads, with the tool outputs
 * and worktree snapshot content it references carried inline as `/export <file>.jsonl` carries them, and read back with
 * the same parser.
 */

import { mkdir } from "node:fs/promises";
import type { SessionEntry } from "./session-manager-types.ts";
import {
	assertSessionBlobStore,
	inlineToolOutput,
	type SessionBlobCopy,
	storeSessionBlobs,
	takeInlineToolOutput,
} from "./session-tool-output.ts";
import { adoptInlineSnapshotBlobs, inlineSnapshotBlobs, sessionSnapshotBlobs } from "./session-worktree-snapshots.ts";
import type { StorageFailureCause } from "./storage/errors.js";
import { SessionConflictError, SessionExistsError } from "./storage/session/errors.js";
import { JsonlSessionStore } from "./storage/session/jsonl-session-store.js";
import { isCurrentSessionHeader, type StoredSessionHeader } from "./storage/session/legacy-format.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
	type SessionSnapshot,
	type SessionStore,
	type SessionSummary,
} from "./storage/session/types.js";
import {
	readTransferDirectory,
	StorageImportIncompleteError,
	StorageTransferError,
	type TransferFileLines,
	transferFile,
	writeLinesAtomically,
} from "./storage/transfer-files.js";
import type { WorktreeSnapshot } from "./worktree-snapshot/types.ts";

export interface SessionExportOptions {
	/** At most this many sessions, most recently modified first. */
	readonly limit?: number;
	/** Only sessions modified at or after this time, in milliseconds since the epoch. */
	readonly since?: number;
}

export interface SessionExportReport {
	/** Sessions whose file was written. */
	readonly written: readonly string[];
	/** Sessions whose file already held exactly this export, left untouched. */
	readonly unchanged: readonly string[];
}

export interface SessionImportReport {
	/** Sessions the storage did not hold. */
	readonly added: readonly string[];
	/** Sessions the storage held an earlier part of, which now have the file's later entries. */
	readonly updated: readonly string[];
	/** Sessions the storage already held every entry of. */
	readonly unchanged: readonly string[];
}

function storeLocation(store: SessionStore): string {
	return store.descriptor.location;
}

function newestFirst(left: SessionSummary, right: SessionSummary): number {
	const modified = Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt);
	if (modified !== 0) return modified;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * A session's export file, line by line: the header, then every entry in append order, with the snapshot records,
 * snapshot content and tool outputs the store holds carried inline, each once. Tool outputs are read one at a time.
 */
async function* sessionExportLines(store: SessionStore, snapshot: SessionSnapshot): AsyncGenerator<string, void> {
	yield JSON.stringify({ type: "session", ...snapshot.header });
	const records = new Map<string, WorktreeSnapshot>();
	for (const entry of snapshot.entries)
		if (entry.type === "worktree_snapshot" && entry.snapshot !== undefined && !records.has(entry.snapshotId))
			records.set(entry.snapshotId, entry.snapshot);
	const entries = await inlineSnapshotBlobs(
		snapshot.entries,
		records,
		sessionSnapshotBlobs(store.snapshotBlobs, snapshot.entries),
	);
	for await (const entry of inlineToolOutput(entries, store, snapshot.header.id)) yield JSON.stringify(entry);
}

/**
 * Exports the sessions of `store`, every project's and workflow stage sessions included, to
 * `<directory>/<sessionId>.jsonl`, one file per session. Each file is written whole or not at all; the same session
 * gives the same bytes, and a file that already holds them is not rewritten.
 */
export async function exportSessions(
	store: SessionStore,
	directory: string,
	options: SessionExportOptions = {},
): Promise<SessionExportReport> {
	let summaries: SessionSummary[] = [];
	for await (const summary of store.list({ includeInternal: true })) summaries.push(summary);
	if (options.since !== undefined) {
		const since = options.since;
		summaries = summaries.filter((summary) => Date.parse(summary.modifiedAt) >= since);
	}
	summaries.sort(newestFirst);
	if (options.limit !== undefined) summaries = summaries.slice(0, options.limit);
	await mkdir(directory, { recursive: true });
	const written: string[] = [];
	const unchanged: string[] = [];
	for (const summary of summaries) {
		const snapshot = await store.load(summary.id);
		const outcome = await writeLinesAtomically(
			transferFile(directory, summary.id),
			sessionExportLines(store, snapshot),
		);
		(outcome === "written" ? written : unchanged).push(summary.id);
	}
	return { written, unchanged };
}

/** A session read from an export file and checked: everything an import writes for it. */
export interface ParsedSession {
	readonly file: string;
	readonly header: SessionRecordHeader;
	/** The entries without the tool outputs they carried inline, which are in `blobs`. */
	readonly entries: readonly SessionEntry[];
	readonly blobs: readonly SessionBlobCopy[];
}

type JsonLine = { readonly [key: string]: string | number | boolean | null | object };

/** Checks one export file with the parser JSONL session storage and `atomic --import` use. */
async function parseSessionFile(source: JsonlSessionStore, { file, lines }: TransferFileLines): Promise<ParsedSession> {
	const fail = (line: number | undefined, reason: string, cause?: StorageFailureCause): never => {
		throw new StorageTransferError({ path: file, ...(line === undefined ? {} : { line }), reason, cause });
	};
	if (lines.length === 0) return fail(1, "is empty; expected a session header");
	const parsed: JsonLine[] = [];
	for (const { line, text } of lines) {
		if (text.trim() === "") fail(line, "is empty");
		let value: JsonLine | string | number | boolean | null;
		try {
			value = JSON.parse(text) as JsonLine;
		} catch (error) {
			return fail(line, `is not valid JSON (${(error as Error).message})`);
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) fail(line, "is not a JSON object");
		parsed.push(value);
	}
	const first = parsed[0]!;
	if (first.type !== "session")
		fail(1, `is not an Atomic session export: its type is ${JSON.stringify(first.type ?? null)}, not "session"`);
	if (!isCurrentSessionHeader(first as StoredSessionHeader))
		fail(
			1,
			`has unsupported session format version ${JSON.stringify(first.version ?? null)}; this Atomic reads version ${SESSION_FORMAT_VERSION}`,
		);
	let loaded: SessionSnapshot;
	try {
		loaded = await source.loadFile(file);
	} catch (error) {
		return fail(undefined, `is not a valid session: ${(error as Error).message}`, error as StorageFailureCause);
	}
	try {
		const { entries, blobs } = takeInlineToolOutput(loaded.entries, loaded.header.id);
		// Checks the snapshot content carried inline against its hashes, writing nothing.
		await adoptInlineSnapshotBlobs(entries, undefined);
		return { file, header: loaded.header, entries, blobs };
	} catch (error) {
		return fail(undefined, `carries content that does not match its hash: ${(error as Error).message}`);
	}
}

/**
 * Reads and checks every `*.jsonl` session export file in `directory`; nothing is written. A directory that does not
 * exist holds no sessions. Throws `StorageTransferError` with the file, and the line where there is one, for the first
 * file that is not a valid format-4 session.
 */
export async function readSessionExports(directory: string): Promise<ParsedSession[]> {
	const files = await readTransferDirectory(directory);
	if (files.length === 0) return [];
	const source = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
	try {
		const parsed: ParsedSession[] = [];
		const seen = new Map<string, string>();
		for (const lines of files) {
			const session = await parseSessionFile(source, lines);
			const earlier = seen.get(session.header.id);
			if (earlier !== undefined)
				throw new StorageTransferError({
					path: session.file,
					line: 1,
					id: session.header.id,
					reason: `session ${session.header.id} is also in ${earlier}; keep one file per session`,
				});
			seen.set(session.header.id, session.file);
			parsed.push(session);
		}
		return parsed;
	} finally {
		await source.close();
	}
}

/** What an import does to one session. */
export type SessionImportAction = "add" | "update" | "unchanged";

interface PlannedSession {
	readonly session: ParsedSession;
	readonly action: SessionImportAction;
	/** How many entries the storage holds, and the sequence number a write must expect. */
	readonly storedEntries: number;
	readonly storedSeq: number;
}

/** What importing a set of session export files does to a session store, decided before anything is written. */
export interface SessionImportPlan {
	readonly store: SessionStore;
	readonly sessions: readonly PlannedSession[];
}

/** The sessions of a plan an import writes. */
export function pendingSessions(plan: SessionImportPlan): string[] {
	return plan.sessions.filter((session) => session.action !== "unchanged").map((session) => session.session.header.id);
}

/**
 * The fields import compares between an entry of a file and the stored entry at the same position: its ID, its
 * parent and its type, as `--import` and session storage identify entries. Everything else may differ, so a file a
 * tool redacted strings in imports as the session it came from.
 */
function sameEntry(stored: SessionEntry, exported: SessionEntry): boolean {
	return stored.id === exported.id && stored.parentId === exported.parentId && stored.type === exported.type;
}

/**
 * Compares every session of `sessions` with the store's copy, writing nothing. A session is identified by its header
 * ID, as `atomic --import` identifies it: one the store lacks is added; one whose entries the store holds the first
 * part of gets the rest; one the store holds every entry of is left alone. A session created at another time, or one
 * whose entries continued differently in the store, fails with the file and line.
 */
export async function planSessionImport(
	store: SessionStore,
	sessions: readonly ParsedSession[],
): Promise<SessionImportPlan> {
	const planned: PlannedSession[] = [];
	const location = storeLocation(store);
	for (const session of sessions) {
		const { header, entries, file } = session;
		const fail = (line: number, reason: string): never => {
			throw new StorageTransferError({ path: file, line, id: header.id, reason });
		};
		if ((await store.readHeader(header.id)) === undefined) {
			assertBlobs(store, session);
			planned.push({ session, action: "add", storedEntries: 0, storedSeq: 0 });
			continue;
		}
		const stored = await store.load(header.id);
		if (stored.header.createdAt !== header.createdAt)
			fail(
				1,
				`session ${header.id} in ${location} was created at another time; it is a different session with the same ID`,
			);
		const shared = Math.min(stored.entries.length, entries.length);
		for (let index = 0; index < shared; index++)
			if (!sameEntry(stored.entries[index]!, entries[index]!))
				fail(
					index + 2,
					`entry ${index + 1} differs from entry ${index + 1} of session ${header.id} in ${location}: the session continued differently there`,
				);
		const action = entries.length > stored.entries.length ? "update" : "unchanged";
		if (action === "update") assertBlobs(store, session);
		planned.push({ session, action, storedEntries: stored.entries.length, storedSeq: stored.lastSeq });
	}
	return { store, sessions: planned };
}

function assertBlobs(store: SessionStore, session: ParsedSession): void {
	try {
		assertSessionBlobStore(store, session.header.id, session.blobs.length);
	} catch (error) {
		throw new StorageTransferError({
			path: session.file,
			id: session.header.id,
			reason: (error as Error).message,
			cause: error as StorageFailureCause,
		});
	}
}

/**
 * Writes what `plan` decided, one session at a time. Each write expects the store to hold exactly what the plan
 * compared: a session another process created or added entries to since fails with the file, and nothing of it is
 * written. Session storage has no lock an import can hold across sessions, so when a write fails after earlier writes
 * (or after `workflowsWritten`, the runs the same import already wrote), `StorageImportIncompleteError` names what was
 * written and what was not; importing again writes only what is missing.
 */
export async function applySessionImport(
	plan: SessionImportPlan,
	workflowsWritten: readonly string[] = [],
): Promise<SessionImportReport> {
	const { store } = plan;
	const report = { added: [] as string[], updated: [] as string[], unchanged: [] as string[] };
	const pending = plan.sessions.filter((planned) => {
		if (planned.action === "unchanged") report.unchanged.push(planned.session.header.id);
		return planned.action !== "unchanged";
	});
	for (const [index, planned] of pending.entries()) {
		const { header, file, blobs } = planned.session;
		try {
			const entries = await adoptInlineSnapshotBlobs(planned.session.entries, store.snapshotBlobs);
			if (planned.action === "add") {
				await store.create(header, entries);
				await storeSessionBlobs(store, header.id, blobs);
			} else {
				for (const blob of blobs) await store.putBlob!(header.id, blob.read());
				await store.append(header.id, entries.slice(planned.storedEntries), { expectSeq: planned.storedSeq });
			}
		} catch (caught) {
			const error =
				caught instanceof SessionConflictError || caught instanceof SessionExistsError
					? new StorageTransferError({
							path: file,
							line: 1,
							id: header.id,
							reason: `session ${header.id} changed in ${storeLocation(store)} after the import compared it (another process wrote to it); it was not imported`,
							cause: caught,
						})
					: (caught as Error);
			const sessionsWritten = [...report.added, ...report.updated];
			if (sessionsWritten.length === 0 && workflowsWritten.length === 0) throw error;
			throw new StorageImportIncompleteError(error, {
				written: { sessions: sessionsWritten, workflows: workflowsWritten },
				notWritten: {
					sessions: pending.slice(index).map((rest) => rest.session.header.id),
					workflows: [],
				},
			});
		}
		(planned.action === "add" ? report.added : report.updated).push(header.id);
	}
	return report;
}
