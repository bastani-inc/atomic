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
}
