import type { ProviderRateLimitObservation } from "@bastani/atomic";
import type { PoolControl, PoolWork, PoolWorkDescriptor } from "../durable/journal/sql-pool-queue.js";
import type { PoolUsage } from "../durable/journal/sql-pool-usage.js";
import type { Lease } from "../durable/journal/types.js";
import type { DurableStageCheckpoint } from "../durable/types.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableObject } from "../shared/types.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import type { WorkerDeliver, WorkerRecipient } from "./protocol.js";
import type { AdmissionConfiguration } from "./resource-admission.js";
import type {
	DeliveryOpId,
	PooledPromptAnswer,
	PooledStageDelivery,
	SeqEvent,
	WatchEndReason,
	WatchId,
} from "./stage-watch-types.js";

/**
 * Main thread <-> pool coordinator protocol.
 *
 * The coordinator is a child process of the root host that owns every per-worker
 * concern of a local worker pool: worker processes and their IPC, pool journal
 * writes (claims, lease extensions, checkpoint and session commits, results),
 * lease recovery, and the Intercom routes of pooled runs. The root's main thread
 * sends it root-level commands and receives only coalesced activity summaries,
 * results, and the few lifecycle events that need the root's store.
 */
export const POOL_COORDINATOR_ROLE = "pool-coordinator";

/** Argument the coordinator process is started with, in place of a worker's start descriptor. */
export interface PoolCoordinatorStart {
	readonly role: typeof POOL_COORDINATOR_ROLE;
}

/** Activity of pooled runs reaches the root at most this often, as one summary per interval. */
export const POOL_SUMMARY_INTERVAL_MS = 250;

/** The identity and lease fields of one work attempt; the root keeps the descriptor from enqueue. */
export type PoolWorkToken = Pick<PoolWork, "id" | "generation" | "worker" | "epoch" | "renewedAt" | "expiresAt">;

/** Root run stage identities the coordinator needs to address pooled runs under their boundaries. */
export interface PoolRootProjection {
	readonly id: string;
	readonly name: string;
	readonly status: RunSnapshot["status"];
	readonly startedAt: number;
	readonly stages: RunSnapshot["stages"];
}

export interface PoolCoordinatorOptions {
	readonly journalPath: string;
	readonly workers: number;
	readonly leaseMs: number;
	readonly startupTimeoutMs: number;
	readonly admission?: AdmissionConfiguration;
	/** Module forked for each worker; undefined forks the coordinator's own entry module. */
	readonly workerEntry?: string;
}

export type CoordinatorCommandBody =
	| {
			readonly kind: "prepare";
			readonly root: string;
			readonly lease: Lease;
			readonly options: PoolCoordinatorOptions;
			/** Control requested before the coordinator existed. */
			readonly control?: PoolControl["state"];
	  }
	| { readonly kind: "control"; readonly state: PoolControl["state"] }
	| {
			readonly kind: "start";
			readonly sources: readonly WorkerDefinitionSource[];
			readonly cwd: string;
			/** Whether the root has a store to publish pooled runs into; routes of pooled runs need one. */
			readonly publish: boolean;
			readonly rootRun?: PoolRootProjection;
			/** Whether workers raise `ctx.ui` prompts for the root to answer (#3996). */
			readonly promptNodes?: boolean;
	  }
	| {
			readonly kind: "enqueue";
			readonly descriptor: PoolWorkDescriptor;
			readonly boundary: DurableStageCheckpoint;
			readonly rootRun?: PoolRootProjection;
	  }
	| ({ readonly kind: "transport"; readonly request: number } & DeliveryPayload)
	| { readonly kind: "undeliverable"; readonly payload: Record<string, unknown> }
	/** Opens a watch of one running pooled stage; answered with a `WatchResult` (#3996). */
	| { readonly kind: "stage-watch"; readonly watch: WatchId; readonly runId: string; readonly stageId: string }
	/** Stops a watch; idempotent. */
	| { readonly kind: "stage-unwatch"; readonly watch: WatchId }
	/** Admits user text into a watched stage at most once per op; answered with a `DeliveryResult`. */
	| ({ readonly kind: "stage-deliver" } & PooledStageDelivery)
	/** Reads the brokered question a pooled stage waits on; answered with a `PooledStageQuestion` or undefined. */
	| { readonly kind: "stage-question"; readonly runId: string; readonly stageId: string }
	/** Answers a prompt a pooled stage raised; answered with a `PromptResult`. */
	| {
			readonly kind: "stage-answer";
			readonly runId: string;
			readonly stageId: string;
			readonly answer: PooledPromptAnswer;
	  }
	/** Holds one watched stage's turn loop without touching pool control; answered with a `ControlResult`. */
	| { readonly kind: "stage-pause"; readonly watch: WatchId }
	/** Releases a stage paused on its own; the message goes through the delivery op ledger. */
	| {
			readonly kind: "stage-resume";
			readonly watch: WatchId;
			readonly message?: { readonly op: DeliveryOpId; readonly text: string };
	  }
	| { readonly kind: "close" };

/** Request from the main thread; answered by one `reply` event with the same id. */
export type CoordinatorCommand = { readonly id: number } & CoordinatorCommandBody;

export interface DeliveryPayload {
	readonly from: Parameters<WorkerDeliver>[0];
	readonly message: Parameters<WorkerDeliver>[1];
}

/** One-way notices from the main thread. */
export type CoordinatorNotice =
	| { readonly kind: "budget"; readonly blocked: boolean }
	| { readonly kind: "root"; readonly rootRun: PoolRootProjection }
	/** The root applied the last `stage-events` batch of this watch; the next one may follow. */
	| { readonly kind: "stage-events-applied"; readonly watch: WatchId }
	/** Provider and model limits the root process recorded, for the pool's workers (#4023). */
	| { readonly kind: "rate-limits"; readonly observations: readonly ProviderRateLimitObservation[] }
	| {
			readonly kind: "published";
			readonly batch: number;
			readonly rejected: readonly { readonly workId: string; readonly generation: number; readonly error: string }[];
	  };

export interface CoordinatorReply {
	readonly kind: "reply";
	readonly id: number;
	readonly value?: unknown;
	readonly error?: string;
}

export interface PoolActivityEntry {
	readonly work: PoolWorkToken;
	readonly runs: readonly RunSnapshot[];
}

/** A request from the coordinator that only the root's store can answer. */
export type CoordinatorRequestBody =
	| {
			readonly kind: "ready";
			readonly work: PoolWorkToken;
			readonly runId: string;
			readonly stageId: string;
			readonly stageName: string;
			readonly sessionId?: string;
	  }
	| {
			readonly kind: "deliver";
			readonly work: PoolWorkToken;
			readonly runId: string;
			readonly stageId: string;
			readonly stageName: string;
			readonly recipient: NonNullable<WorkerRecipient>;
	  }
	| { readonly kind: "pending-stage-message"; readonly payload: Record<string, unknown> }
	| { readonly kind: "sticky-live-delivered"; readonly payload: Record<string, unknown> };

/** Coordinator -> main thread. Every event except `reply` is applied in order. */
export type CoordinatorEvent =
	| CoordinatorReply
	| {
			readonly kind: "activity";
			readonly batch: number;
			readonly entries: readonly PoolActivityEntry[];
			readonly usage?: PoolUsage;
	  }
	| { readonly kind: "spawned"; readonly pid: number }
	| { readonly kind: "exited"; readonly pid: number }
	| { readonly kind: "fence"; readonly work: Pick<PoolWork, "id" | "generation"> }
	| {
			readonly kind: "result";
			readonly workId: string;
			readonly result: WorkflowSerializableObject;
			readonly usage?: PoolUsage;
	  }
	| { readonly kind: "failure"; readonly error: string }
	/** One child failed without failing the pool. */
	| { readonly kind: "work-failure"; readonly workId: string; readonly error: string }
	/** Ordered events of an open watch; at most one batch per watch awaits `stage-events-applied`. */
	| { readonly kind: "stage-events"; readonly watch: WatchId; readonly events: readonly SeqEvent[] }
	/** The last event of a watch. */
	| { readonly kind: "stage-watch-ended"; readonly watch: WatchId; readonly reason: WatchEndReason }
	| { readonly kind: "request"; readonly id: number; readonly request: CoordinatorRequestBody }
	/** Provider and model limits a worker recorded, for the root process (#4023). */
	| { readonly kind: "rate-limits"; readonly observations: readonly ProviderRateLimitObservation[] };

/** Main thread answer to a coordinator `request`. */
export interface CoordinatorRequestReply {
	readonly kind: "request-reply";
	readonly id: number;
	readonly value?: unknown;
	readonly error?: string;
}

export type CoordinatorInbound = CoordinatorCommand | CoordinatorNotice | CoordinatorRequestReply;

/** One end of the main thread <-> coordinator channel. */
export interface CoordinatorPort<Send, Receive> {
	send(message: Send): void;
	onMessage(listener: (message: Receive) => void): void;
	/** Called once when the other end is gone. */
	onClose(listener: (reason: Error) => void): void;
	close(): Promise<void>;
}
