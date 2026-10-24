import type { SqliteExecutor } from "@bastani/atomic/storage";
import type { PendingStageMessage, PendingStageMessageDelivery } from "../../shared/store-types.js";
import { type JournalEntry, RUN_EVENT_TYPES, type RunJournal } from "./types.js";

export const JOURNAL_READ_PAGE_SIZE = 256;

/** Event types the durable backend folds without replacing the run's handle; every other event carries it. */
export const NON_SNAPSHOT_EVENT_TYPES = [
	RUN_EVENT_TYPES.checkpointRecorded,
	RUN_EVENT_TYPES.messageSettled,
	RUN_EVENT_TYPES.messageDelivered,
] as const;

/** A run's latest event. A run whose history was deleted and recorded again ends with a different event. */
export interface RunVersion {
	readonly seq: number;
	readonly at: number;
}

/**
 * A run's latest snapshot event (one carrying the run's handle) and the checkpoints recorded after it: enough to
 * list the run in a catalog without reading its history.
 */
export interface RunSnapshotTail {
	/** The run's latest event of any type. */
	readonly version: RunVersion;
	readonly snapshot: JournalEntry;
	readonly laterCheckpoints: number;
	/** `completedAt` of the last of `laterCheckpoints`. */
	readonly lastCheckpointAt?: number;
}

/** Lets a durable backend re-read only the runs that changed; kept off the public journal shape. */
export interface RunJournalVersions {
	/** Moves whenever any connection, in this process or another, commits a change to the journal's store. */
	changeToken(): Promise<string>;
	/** Every listed run with its latest event; a run with no events has version `{ seq: 0, at: 0 }`. */
	runVersions(): Promise<ReadonlyMap<string, RunVersion>>;
	/** Undefined for a run with no snapshot event. */
	snapshotTail(runId: string): Promise<RunSnapshotTail | undefined>;
}

const versionReaders = new WeakMap<RunJournal, RunJournalVersions>();

export function registerRunJournalVersions(journal: RunJournal, versions: RunJournalVersions): void {
	versionReaders.set(journal, versions);
}

/** Change tracking for a journal that registered it; other journals are re-read in full. */
export function runJournalVersions(journal: RunJournal): RunJournalVersions | undefined {
	return versionReaders.get(journal);
}

export type JournalAppendGuard = (tx: SqliteExecutor, runId: string) => Promise<void>;

export interface SqlPoolStorage {
	transaction<T>(body: (tx: SqliteExecutor) => Promise<T>): Promise<T>;
	withAppendGuard<T>(guard: JournalAppendGuard, action: () => Promise<T>): Promise<T>;
	readonly tables: Readonly<{ runs: string; events: string; leases: string }>;
}

const poolStorage = new WeakMap<RunJournal, SqlPoolStorage>();

export function registerSqlPoolStorage(journal: RunJournal, storage: SqlPoolStorage): void {
	poolStorage.set(journal, storage);
}

export function sqlPoolStorage(journal: RunJournal): SqlPoolStorage | undefined {
	return poolStorage.get(journal);
}

/**
 * A sticky entry's deliveries written as a change to the same entry in the run's previous event: drop these
 * indexes of the previous deliveries, then append `add`. Recording a delivery then costs the delivery, not
 * every live delivery again (#3920).
 */
interface PendingStageDeliveryDelta {
	readonly drop?: readonly number[];
	readonly add: readonly PendingStageMessageDelivery[];
}
type DeltaEncodedMessage = Omit<PendingStageMessage, "deliveries"> & {
	readonly deliveryDelta: PendingStageDeliveryDelta;
};
export type JournalPendingStageMessage = PendingStageMessage | DeltaEncodedMessage;

function identity(message: Pick<PendingStageMessage, "runId" | "id">): string {
	return JSON.stringify([message.runId, message.id]);
}

/** Entries whose identity occurs once; a duplicated identity cannot name its base unambiguously. */
function uniqueByIdentity<Message extends Pick<PendingStageMessage, "runId" | "id">>(
	messages: readonly Message[],
): Map<string, Message> {
	const result = new Map<string, Message>();
	const repeated = new Set<string>();
	for (const message of messages) {
		const key = identity(message);
		if (result.has(key)) repeated.add(key);
		result.set(key, message);
	}
	for (const key of repeated) result.delete(key);
	return result;
}

function isDeltaEncoded(message: JournalPendingStageMessage): message is DeltaEncodedMessage {
	return (message as Partial<DeltaEncodedMessage>).deliveryDelta !== undefined;
}

/**
 * Encode `next` against `previous`, the pending entries the run's journal holds before this event. Returns
 * undefined when no entry is smaller as a change, so the event keeps the full entries.
 */
export function encodePendingStageDeliveries(
	previous: readonly PendingStageMessage[],
	next: readonly PendingStageMessage[],
): readonly JournalPendingStageMessage[] | undefined {
	const bases = uniqueByIdentity(previous);
	const nextIdentities = uniqueByIdentity(next);
	let encodedAny = false;
	const encoded = next.map((message): JournalPendingStageMessage => {
		const base = bases.get(identity(message))?.deliveries;
		const deliveries = message.deliveries;
		if (base === undefined || deliveries === undefined || !nextIdentities.has(identity(message))) return message;
		const drop: number[] = [];
		let kept = 0;
		base.forEach((delivery, index) => {
			if (kept < deliveries.length && JSON.stringify(delivery) === JSON.stringify(deliveries[kept])) kept++;
			else drop.push(index);
		});
		const add = deliveries.slice(kept);
		if (drop.length + add.length >= deliveries.length) return message;
		encodedAny = true;
		const { deliveries: _full, ...rest } = message;
		return { ...rest, deliveryDelta: drop.length === 0 ? { add } : { drop, add } };
	});
	return encodedAny ? encoded : undefined;
}

/** Rebuild full entries from an event's entries and the run's entries before that event. */
export function decodePendingStageDeliveries(
	previous: readonly PendingStageMessage[],
	messages: readonly JournalPendingStageMessage[],
): readonly PendingStageMessage[] {
	if (!messages.some(isDeltaEncoded)) return messages as readonly PendingStageMessage[];
	const bases = uniqueByIdentity(previous);
	return messages.map((message) => {
		if (!isDeltaEncoded(message)) return message;
		const base = bases.get(identity(message))?.deliveries;
		if (base === undefined)
			throw new Error(`atomic-workflows: journal delivery change for ${identity(message)} has no base entry`);
		const { deliveryDelta, ...rest } = message;
		const dropped = new Set(deliveryDelta.drop ?? []);
		return { ...rest, deliveries: [...base.filter((_, index) => !dropped.has(index)), ...deliveryDelta.add] };
	});
}

/** Whether an event's entries need the run's earlier events to be read. */
export function hasPendingStageDeliveryDelta(messages: readonly JournalPendingStageMessage[] | undefined): boolean {
	return messages?.some(isDeltaEncoded) === true;
}
