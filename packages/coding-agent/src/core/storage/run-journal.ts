import type { StorageDescriptor } from "./database.js";

export const RUN_EVENT_TYPES = {
	runStarted: "RunStarted",
	runFinished: "RunFinished",
	statusChanged: "StatusChanged",
	checkpointRecorded: "CheckpointRecorded",
	promptAsked: "PromptAsked",
	promptReleased: "PromptReleased",
	controlRequested: "ControlRequested",
	messageQueued: "MessageQueued",
	messageDelivered: "MessageDelivered",
	messageSettled: "MessageSettled",
	timerScheduled: "TimerScheduled",
	summaryRecorded: "SummaryRecorded",
} as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[keyof typeof RUN_EVENT_TYPES];

export type JournalSerializableValue =
	| string
	| number
	| boolean
	| null
	| readonly JournalSerializableValue[]
	| { readonly [key: string]: JournalSerializableValue | undefined };

export interface RunHeader {
	readonly runId: string;
	readonly name: string;
	readonly cwd: string;
	readonly createdAt: number;
	readonly status: string;
	readonly inputs?: JournalSerializableValue;
	readonly storage?: StorageDescriptor;
}
export type RunSummary = RunHeader;

type EventOf<Type extends string, Payload = JournalSerializableValue> = {
	readonly type: Type;
	readonly payload: Payload;
};
export type RunEvent =
	| EventOf<"RunStarted" | "RunFinished">
	| EventOf<"StatusChanged", { readonly status: string; readonly [key: string]: JournalSerializableValue }>
	| EventOf<
			"CheckpointRecorded",
			{
				readonly kind: "tool" | "ui" | "stage" | "task" | "boundary";
				readonly [key: string]: JournalSerializableValue;
			}
	  >
	| EventOf<
			| "PromptAsked"
			| "PromptReleased"
			| "ControlRequested"
			| "MessageQueued"
			| "MessageDelivered"
			| "MessageSettled"
			| "TimerScheduled"
			| "SummaryRecorded"
	  >;
export interface Lease {
	readonly runId: string;
	readonly holderId: string;
	readonly epoch: number;
}
export type LeaseState = Lease & { readonly renewedAt: number; readonly ageMs: number };
export type LeaseOutcome =
	| { readonly status: "acquired"; readonly lease: Lease }
	| { readonly status: "held"; readonly holderId: string | null; readonly epoch: number };
export interface JournalEntry {
	readonly runId: string;
	readonly seq: number;
	readonly epoch: number;
	readonly key?: string;
	readonly event: RunEvent;
	readonly at: number;
}
export type AppendOutcome = { readonly status: "appended" | "exists"; readonly entry: JournalEntry };
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
/** One append of a batch. `context` runs a function in the async context the append was issued from. */
export interface RunJournalBatchAppend {
	readonly event: RunEvent;
	readonly key?: string;
	readonly context: <R>(action: () => R) => R;
}
export interface RunJournal {
	createRun(header: RunHeader): Promise<"created" | "exists">;
	getRun(runId: string): Promise<RunSummary | undefined>;
	listRuns(filter?: { cwd?: string }): Promise<readonly RunSummary[]>;
	acquire(runId: string, holderId: string): Promise<LeaseOutcome>;
	takeover(runId: string, holderId: string, expectedHolder: string): Promise<LeaseOutcome>;
	takeoverExpired(runId: string, holderId: string, staleAfterMs: number): Promise<LeaseOutcome>;
	leaseState(runId: string): Promise<LeaseState | undefined>;
	renew(lease: Lease): Promise<void>;
	release(lease: Lease): Promise<void>;
	append(lease: Lease, event: RunEvent, options?: { key?: string; expectSeq?: number }): Promise<AppendOutcome>;
	read(runId: string, fromSeq?: number): AsyncIterable<JournalEntry>;
	readKey(runId: string, key: string): Promise<JournalEntry | undefined>;
	deleteOwnedRun(lease: Lease, expectSeq?: number): Promise<void>;
	deleteRun(runId: string): Promise<void>;
	close(): Promise<void>;
	/**
	 * Optional change tracking, used only when `changeToken`, `runVersions` and `snapshotTail` are all present. The
	 * token moves whenever any connection, in this process or another, commits a change to the journal's store.
	 */
	changeToken?(): Promise<string>;
	/** Every listed run with its latest event; a run with no events has version `{ seq: 0, at: 0 }`. */
	runVersions?(): Promise<ReadonlyMap<string, RunVersion>>;
	/** Undefined for a run with no snapshot event. */
	snapshotTail?(runId: string): Promise<RunSnapshotTail | undefined>;
	/** Optional batched appends to one run in one transaction; each append is settled on its own, in order. */
	appendMany?(
		lease: Lease,
		appends: readonly RunJournalBatchAppend[],
	): Promise<readonly PromiseSettledResult<AppendOutcome>[]>;
}
