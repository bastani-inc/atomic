import { getBranchPath } from "../../packages/coding-agent/src/core/session-manager-history.ts";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import { currentWorktreeSnapshots } from "../../packages/coding-agent/src/core/session-worktree-snapshots.ts";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	SESSION_FORMAT_VERSION,
	type SessionStore,
} from "../../packages/coding-agent/src/core/storage/session/types.ts";
import { snapshotBlobHashes } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { snapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/env-hash.ts";
import type { SnapshotBlob, WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	type Lease,
	RUN_EVENT_TYPES,
	type RunEvent,
	type RunJournal,
} from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableResumeCandidate } from "../../packages/workflows/src/durable/resume-eligibility.js";
import { isDurableWorkflowResumable } from "../../packages/workflows/src/durable/resume-eligibility.js";

/** A blob whose bytes are `text`. */
export function textBlob(text: string): SnapshotBlob {
	return snapshotBlob(new TextEncoder().encode(text));
}

/** A snapshot record whose chain names `patches` (null for a link without change) and whose bundle is `bundle`. */
export function syntheticSnapshot(
	id: string,
	patches: readonly (string | null)[],
	options: { readonly bundle?: string; readonly root?: string } = {},
): WorktreeSnapshot {
	return {
		version: 1,
		id,
		root: options.root ?? "/repo",
		remotes: [],
		branch: "main",
		head: "a".repeat(40),
		snapshot: "b".repeat(40),
		tree: "c".repeat(40),
		envHash: "env",
		delta: { base: "head", patch: patches.at(-1) ?? null, bytes: 1 },
		chain: patches.map((patch, index) => ({ tree: `${index}`.padStart(40, "d"), patch, bytes: 1 })),
		bundle: options.bundle === undefined ? null : { blob: options.bundle, bytes: 1, commits: ["e".repeat(40)] },
		omitted: [],
		filters: null,
		capturedAt: "2026-01-01T00:00:00.000Z",
	};
}

/** A session store and a run journal on one SQLite file, sharing one blob table as they do by default. */
export interface SharedSnapshotDatabase {
	readonly database: SqliteDatabase;
	readonly sessions: SqlSessionStore;
	readonly journal: SqlRunJournal;
	close(): Promise<void>;
}

export async function openSharedSnapshotDatabase(
	path: string,
	options: { readonly database?: SqliteDatabase; readonly prefix?: string } = {},
): Promise<SharedSnapshotDatabase> {
	const database = options.database ?? (await openNodeSqliteDatabase(path));
	const sessions = await SqlSessionStore.open(database, { prefix: options.prefix });
	const journal = await SqlRunJournal.open(database, { prefix: options.prefix });
	return {
		database,
		sessions,
		journal,
		async close() {
			await journal.close();
			await sessions.close();
			await database.close();
		},
	};
}

/** Moves every stored blob's age back by `seconds` on the database clock. */
export async function ageBlobs(database: SqliteDatabase, table: string, seconds: number): Promise<void> {
	await database.run(`UPDATE ${table} SET created_at = created_at - ?`, seconds);
}

export interface RunStatusPayload {
	readonly status: string;
	readonly completedCheckpoints?: number;
	readonly pendingPrompts?: number;
	readonly resumable?: boolean;
	readonly rootWorkflowId?: string | null;
}

export function statusEvent(
	runId: string,
	payload: RunStatusPayload,
	type: "RunStarted" | "StatusChanged" = "StatusChanged",
): RunEvent {
	return {
		type,
		payload: { workflowId: runId, completedCheckpoints: 1, pendingPrompts: 0, ...payload },
	} as unknown as RunEvent;
}

export function checkpointEvent(
	snapshots: readonly WorktreeSnapshot[],
	kind: "tool" | "stage" | "ui" | "task" | "boundary" = "tool",
): RunEvent {
	return {
		type: RUN_EVENT_TYPES.checkpointRecorded,
		payload: { kind, checkpointId: `cp-${Math.random().toString(36).slice(2)}`, worktreeSnapshots: snapshots },
	} as unknown as RunEvent;
}

/** Creates `runId` and holds its lease, so events can be appended to it. */
export async function startRun(journal: SqlRunJournal, runId: string, status = "running"): Promise<Lease> {
	await journal.createRun({ runId, name: "synthetic", cwd: "/repo", createdAt: 1, status });
	const outcome = await journal.acquire(runId, `holder-${runId}`);
	if (outcome.status !== "acquired") throw new Error(`lease for ${runId} is held`);
	return outcome.lease;
}

let entryCounter = 0;

/**
 * A `worktree_snapshot` session entry; pass `snapshot` for an entry that carries the record, and `parentId` for the
 * entry it follows (`createSession` chains entries that name none).
 */
export function snapshotEntry(
	root: string,
	snapshotId: string,
	snapshot?: WorktreeSnapshot,
	parentId: string | null = null,
): SessionEntry {
	entryCounter++;
	return {
		type: "worktree_snapshot",
		id: `entry-${entryCounter}`,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		root,
		snapshotId,
		...(snapshot === undefined ? {} : { snapshot }),
	} as SessionEntry;
}

/** A plain message entry, for padding sessions with entries that reference nothing. */
export function messageEntry(text: string, parentId: string | null = null): SessionEntry {
	entryCounter++;
	return {
		type: "message",
		id: `entry-${entryCounter}`,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

/** Entries that name no parent follow the entry before them, as a session records them; the first one is the root. */
export function chained(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) =>
		entry.parentId === null && index > 0 ? ({ ...entry, parentId: entries[index - 1]!.id } as SessionEntry) : entry,
	);
}

export async function createSession(
	sessions: SqlSessionStore,
	sessionId: string,
	entries: readonly SessionEntry[],
): Promise<{ readonly lastSeq: number }> {
	return sessions.create(
		{ id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo" },
		chained(entries),
	);
}

/**
 * The blobs retention keeps, computed the way the full-scan retention functions did before the reference index:
 * every snapshot of each resumable root run, read event by event, and, for every leaf of every session tree, the
 * latest snapshot of each checkout on the leaf's branch, read entry by entry as retention first did (the rule resume
 * itself follows). The reference index keeps these and, for a checkout reached under two roots, possibly one more.
 */
export async function fullScanRetainedHashes(journal: RunJournal, sessions: SessionStore): Promise<Set<string>> {
	const retained = new Set<string>();
	for (const run of await journal.listRuns()) {
		let candidate: DurableResumeCandidate | undefined;
		let checkpointCount = 0;
		const snapshots: WorktreeSnapshot[] = [];
		for await (const entry of journal.read(run.runId)) {
			if (entry.event.type === RUN_EVENT_TYPES.runStarted || entry.event.type === RUN_EVENT_TYPES.statusChanged) {
				const payload = entry.event.payload as unknown as Partial<DurableResumeCandidate>;
				if (
					typeof payload.workflowId === "string" &&
					typeof payload.status === "string" &&
					typeof payload.completedCheckpoints === "number" &&
					typeof payload.pendingPrompts === "number"
				)
					candidate = payload as DurableResumeCandidate;
			}
			if (entry.event.type !== RUN_EVENT_TYPES.checkpointRecorded) continue;
			checkpointCount++;
			const checkpoint = entry.event.payload as unknown as {
				kind: string;
				worktreeSnapshots?: WorktreeSnapshot[];
			};
			if (checkpoint.kind === "tool" || checkpoint.kind === "stage")
				snapshots.push(...(checkpoint.worktreeSnapshots ?? []));
		}
		const keep =
			candidate !== undefined
				? isDurableWorkflowResumable({
						...candidate,
						completedCheckpoints: Math.max(candidate.completedCheckpoints, checkpointCount),
					})
				: run.status !== "completed" && run.status !== "cancelled";
		if (keep) for (const snapshot of snapshots) for (const hash of snapshotBlobHashes(snapshot)) retained.add(hash);
	}
	for await (const summary of sessions.list({ includeInternal: true })) {
		const { entries } = await sessions.load(summary.id);
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const parents = new Set(entries.map((entry) => entry.parentId));
		const records = new Map<string, WorktreeSnapshot>();
		for (const entry of entries) {
			if (entry.type === "worktree_snapshot" && entry.snapshot) records.set(entry.snapshotId, entry.snapshot);
		}
		for (const leaf of entries.filter((entry) => !parents.has(entry.id))) {
			const branch = getBranchPath(leaf.id, byId);
			const current = currentWorktreeSnapshots({
				getBranch: () => branch,
				getWorktreeRootMappings: () =>
					branch.flatMap((entry) => (entry.type === "worktree_snapshot" && entry.restore ? [entry.restore] : [])),
				getWorktreeSnapshotRecords: () => records,
			});
			for (const snapshot of current.values()) for (const hash of snapshotBlobHashes(snapshot)) retained.add(hash);
		}
	}
	return retained;
}

/**
 * Strips `database` back to what a build without the reference index left: every index trigger and index table is
 * dropped, while the blob table, journal and session tables stay as they were written. Reopening the stores then
 * meets a database whose existing references the index has never seen.
 */
export async function dropSnapshotIndex(database: SqliteDatabase, prefix = ""): Promise<void> {
	const triggers = await database.all<{ name: string }>(
		"SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%snapshot%'",
	);
	for (const { name } of triggers) await database.exec(`DROP TRIGGER ${name}`);
	for (const table of [
		"snapshot_run_refs",
		"snapshot_run_state",
		"snapshot_session_refs",
		"snapshot_session_links",
		"snapshot_session_records",
		"snapshot_carried_refs",
		"snapshot_collection",
		"snapshot_index_sources",
	])
		await database.exec(`DROP TABLE IF EXISTS ${prefix}${table}`);
}
