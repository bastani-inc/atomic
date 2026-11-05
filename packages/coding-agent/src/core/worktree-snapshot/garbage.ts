import { randomUUID } from "node:crypto";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";
import { StoreClosedError } from "../storage/errors.js";
import {
	BackgroundCollectionPace,
	runningSnapshotCollectionOf,
	type SnapshotCollectionOutcome,
	type SnapshotCollectionSkipReason,
	SqlSnapshotBlobStore,
	trackSnapshotCollection,
} from "./blob-store.ts";
import {
	type SnapshotCollectionPhase,
	WorkspaceCollectionError,
	WorkspaceConfigError,
	WorkspaceSnapshotError,
} from "./errors.ts";
import { resolveWorktreeSnapshotSettings } from "./settings.ts";
import type { SnapshotBlobStore, WorktreeSnapshotSettings } from "./types.ts";

/**
 * How long an unreferenced blob is kept by default: one hour.
 *
 * A capture stores its blobs, or restarts the age of the earlier blobs it reuses, before it publishes the session
 * entry or checkpoint that references them, so for that gap a fresh blob is unreferenced. The gap is one capture plus
 * one journal append, normally well under a second, but a stopped or starved process can stretch it to minutes. An
 * hour keeps every realistic gap safe, and the cost of keeping an unreferenced blob that long is a few kilobytes of
 * patch.
 */
export const DEFAULT_BLOB_GRACE_SECONDS: number = SETTINGS_DEFAULTS.snapshots.graceSeconds;

export interface CollectSnapshotGarbageOptions {
	/** Blobs stored or re-stored less than this many seconds ago are never deleted. A non-negative integer; 0 disables the protection. Default {@link DEFAULT_BLOB_GRACE_SECONDS}. */
	readonly graceSeconds?: number;
	/** Checked before each batch; an aborted collection rejects with the signal's reason and keeps what it deleted. */
	readonly signal?: AbortSignal;
}

/**
 * Deletes every blob in `store` that no retained snapshot references and that was last stored at least
 * `graceSeconds` ago, and resolves with the hashes it deleted. Retained snapshots are those of resumable root
 * workflow runs and the latest snapshot of each checkout in every session that shares the blob table, read from the
 * reference index that triggers keep as the journal and session store write, so the cost follows the number of blobs
 * and references, never the length of a journal. A database written before the index existed has its existing rows
 * indexed first, once, in short transactions, and nothing is deleted until that is done. Batches commit one at a
 * time; stopping part way leaves only garbage.
 *
 * Rejects before reading anything: with {@link WorkspaceSnapshotError} (`blob-store-unsupported`) when `store` is not a
 * {@link SqlSnapshotBlobStore}, which has no reference index to collect by, or is missing, as for storage that holds
 * no blobs; with {@link WorkspaceConfigError} when `graceSeconds` is not a non-negative integer.
 */
export async function collectSnapshotGarbage(
	store: SnapshotBlobStore | undefined,
	options: CollectSnapshotGarbageOptions = {},
): Promise<{ readonly deleted: readonly string[] }> {
	if (!(store instanceof SqlSnapshotBlobStore))
		throw new WorkspaceSnapshotError("blob-store-unsupported", "non-SQLite");
	const graceSeconds = options.graceSeconds ?? DEFAULT_BLOB_GRACE_SECONDS;
	if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0) {
		throw new WorkspaceConfigError("sdk", "graceSeconds", "a non-negative integer number of seconds");
	}
	return { deleted: await store.collectGarbage({ graceSeconds, signal: options.signal }) };
}

export type { SnapshotCollectionOutcome, SnapshotCollectionSkipReason };

export interface ScheduleSnapshotCollectionOptions {
	/**
	 * Called once per process for each blob table and error code. Default: `process.emitWarning`. A listener that
	 * throws does not change the outcome: its own error becomes a process warning.
	 */
	readonly onFailure?: (error: WorkspaceCollectionError) => void;
}

type CollectionSettings = Pick<WorktreeSnapshotSettings, "autoCollect" | "collectIntervalSeconds" | "graceSeconds">;

/** `performance.now()` when this process last asked the database, by blob table, whether a collection is due. */
const lastAskedAt = new Map<string, number>();
const reportedFailures = new Set<string>();

function skipped(reason: SnapshotCollectionSkipReason): Promise<SnapshotCollectionOutcome> {
	return Promise.resolve({ status: "skipped", reason });
}

/**
 * Starts an automatic collection of `store`'s blob table when one is due and resolves with its outcome; callers that
 * must not wait, such as a closing session or a finishing workflow run, ignore the promise. A collection is due when
 * `settings.autoCollect` is set, the store keeps a reference index, this process is not collecting the table already,
 * and no process sharing the database claimed a collection in the last `collectIntervalSeconds` on the database
 * clock. This process asks the database at most once per interval. A failure is recorded in the table's collection
 * row and reported once through `onFailure`.
 *
 * Collection timers do not keep an otherwise idle process alive. Storage close aborts collection at its next batch
 * boundary and waits for database cleanup, not the remaining collection. A remote connection or the batch already in
 * progress can keep the process alive until cleanup finishes. {@link runningSnapshotCollection} waits for completion.
 *
 * Throws {@link WorkspaceConfigError} before reading the store when a setting is invalid: `autoCollect` not a boolean,
 * `collectIntervalSeconds` not a positive integer, or `graceSeconds` not a non-negative integer. Everything else is an
 * outcome of the returned promise, which never rejects.
 */
export function scheduleSnapshotCollection(
	store: SnapshotBlobStore | undefined,
	settings: CollectionSettings,
	options: ScheduleSnapshotCollectionOptions = {},
): Promise<SnapshotCollectionOutcome> {
	const checked = resolveWorktreeSnapshotSettings(settings, "sdk", "settings");
	if (!checked.autoCollect) return skipped("disabled");
	if (!(store instanceof SqlSnapshotBlobStore)) return skipped("unsupported");
	if (runningSnapshotCollectionOf(store)) return skipped("in-progress");
	const now = performance.now();
	if (now - (lastAskedAt.get(store.identity) ?? Number.NEGATIVE_INFINITY) < checked.collectIntervalSeconds * 1000)
		return skipped("not-due");
	lastAskedAt.set(store.identity, now);
	const controller = new AbortController();
	const pace = new BackgroundCollectionPace(controller.signal);
	const running = collectIfDue(
		store,
		checked,
		pace,
		controller.signal,
		options.onFailure ?? ((error) => process.emitWarning(error)),
	);
	trackSnapshotCollection(store, { outcome: running, pace, abort: (reason) => controller.abort(reason) });
	void running.then((outcome) => {
		if (outcome.status === "interrupted") lastAskedAt.delete(store.identity);
	});
	return running;
}

/**
 * The automatic collection of `store`'s blob table that this process is running, if any, as a promise that settles
 * when it ends and never rejects. Asking for it makes the process wait for the collection, which otherwise lets the
 * process exit between batches. Close a database you opened yourself only after it settles, so the close does not
 * cut the collection short. Storage that Atomic opened aborts collection and waits for it to stop before closing.
 */
export function runningSnapshotCollection(
	store: SnapshotBlobStore | undefined,
): Promise<SnapshotCollectionOutcome> | undefined {
	const running = store instanceof SqlSnapshotBlobStore ? runningSnapshotCollectionOf(store) : undefined;
	running?.pace.keepProcessAlive();
	return running?.outcome;
}

async function collectIfDue(
	store: SqlSnapshotBlobStore,
	settings: CollectionSettings,
	pace: BackgroundCollectionPace,
	signal: AbortSignal,
	onFailure: (error: WorkspaceCollectionError) => void,
): Promise<SnapshotCollectionOutcome> {
	const holder = randomUUID();
	const deleted: string[] = [];
	let phase: SnapshotCollectionPhase = "claim";
	try {
		if (!(await store.claimCollection(settings.collectIntervalSeconds, holder, pace)))
			return { status: "skipped", reason: "not-due" };
		phase = "index";
		await store.completeIndex({ holder, pace, signal });
		phase = "sweep";
		await store.sweep({
			graceSeconds: settings.graceSeconds,
			holder,
			pace,
			signal,
			onBatch: (batch) => deleted.push(...batch),
		});
		phase = "record";
		await store.recordCollection(holder, { deleted: deleted.length, errorCode: null }, pace);
		return { status: "collected", deleted };
	} catch (cause) {
		if (cause instanceof StoreClosedError) return { status: "interrupted", deleted };
		const error = new WorkspaceCollectionError(
			{ table: store.table, phase, deleted: deleted.length },
			cause instanceof Error ? cause : undefined,
		);
		if (phase !== "claim") {
			try {
				await store.recordCollection(holder, { deleted: deleted.length, errorCode: error.code }, pace);
			} catch (cleanupCause) {
				Object.defineProperty(error, "cleanupCause", { value: cleanupCause });
			}
		}
		const key = `${store.identity}\0${error.code}`;
		if (!reportedFailures.has(key)) {
			reportedFailures.add(key);
			try {
				onFailure(error);
			} catch (listenerError) {
				process.emitWarning(listenerError instanceof Error ? listenerError : new Error(String(listenerError)));
			}
		}
		return { status: "failed", error };
	}
}

/** Test seam: forget which tables this process collected and which failures it reported. */
export function resetSnapshotCollectionScheduleForTesting(): void {
	lastAskedAt.clear();
	reportedFailures.clear();
}
