import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
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

/** A `worktree_snapshot` session entry; pass `snapshot` for an entry that carries the record. */
export function snapshotEntry(root: string, snapshotId: string, snapshot?: WorktreeSnapshot): SessionEntry {
	entryCounter++;
	return {
		type: "worktree_snapshot",
		id: `entry-${entryCounter}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		root,
		snapshotId,
		...(snapshot === undefined ? {} : { snapshot }),
	} as SessionEntry;
}

/** A plain message entry, for padding sessions with entries that reference nothing. */
export function messageEntry(text: string): SessionEntry {
	entryCounter++;
	return {
		type: "message",
		id: `entry-${entryCounter}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

export async function createSession(
	sessions: SqlSessionStore,
	sessionId: string,
	entries: readonly SessionEntry[],
): Promise<{ readonly lastSeq: number }> {
	return sessions.create(
		{ id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: "2026-01-01T00:00:00.000Z", cwd: "/repo" },
		entries,
	);
}

/**
 * The blobs retention keeps, computed the way the full-scan retention functions did before the reference index:
 * every snapshot of each resumable root run, read event by event, and the latest snapshot of each checkout in every
 * session, read entry by entry. The reference index must keep exactly these.
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
		const records = new Map<string, WorktreeSnapshot>();
		const latest = new Map<string, string>();
		for (const entry of entries) {
			if (entry.type !== "worktree_snapshot") continue;
			if (entry.snapshot) records.set(entry.snapshotId, entry.snapshot);
			latest.set(entry.root, entry.snapshotId);
		}
		for (const snapshotId of latest.values()) {
			const snapshot = records.get(snapshotId);
			if (snapshot) for (const hash of snapshotBlobHashes(snapshot)) retained.add(hash);
		}
	}
	return retained;
}
