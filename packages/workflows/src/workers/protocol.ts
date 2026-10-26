import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { PoolControl, PoolMutation, PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { PoolUsageReport } from "../durable/journal/sql-pool-usage.js";
import type { RunResult } from "../runs/foreground/executor-types.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import type { AdmissionConfiguration } from "./resource-admission.js";
import type {
	AttemptRef,
	DeliveryIntent,
	DeliveryOpId,
	DeliveryRefusal,
	PooledStageChatSnapshot,
	SeqEvent,
	WatchEndReason,
	WatchId,
	WatchRefusal,
} from "./stage-watch-types.js";

export const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;

/** `Omit` applied to each member of a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends T ? Omit<T, K> : never;

export type WorkerStageDelivery = NonNullable<
	NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"]
>;
export type WorkerDeliver = Parameters<WorkerStageDelivery["deliverPending"]>[0];
export type WorkerRecipient = Parameters<WorkerStageDelivery["deliverPending"]>[1];
export interface WorkerStart {
	readonly journalPath: string;
	readonly root: string;
	readonly definitions: readonly WorkerDefinitionSource[];
	readonly admission?: AdmissionConfiguration;
}
export type WorkerRequest = { readonly id: number } & (
	| { readonly kind: "ready" | "claim" | "renew" | "budget" | "control" }
	/** The worker ended its attempt because a reply reported it fenced; it is not a worker fault. */
	| { readonly kind: "fenced" }
	| { readonly kind: "controlled"; readonly revision: number }
	| { readonly kind: "activity"; readonly runs: readonly RunSnapshot[] }
	| { readonly kind: "route"; readonly runId: string }
	| {
			readonly kind: "delivery" | "delivery-ready";
			readonly runId: string;
			readonly stageId: string;
			readonly stageName: string;
			readonly recipient?: WorkerRecipient;
			readonly sessionId?: string;
	  }
	| { readonly kind: "delivery-ack"; readonly deliveryId: string; readonly error?: string }
	| { readonly kind: "commit"; readonly operation: string; readonly mutation: PoolMutation }
	| { readonly kind: "usage"; readonly reports: readonly PoolUsageReport[] }
	| { readonly kind: "complete"; readonly result: RunResult }
	// One-way stage watch traffic (#3996); the coordinator does not reply to these.
	| {
			readonly kind: "stage-command-result";
			readonly commandId: number;
			readonly snapshot?: PooledStageChatSnapshot;
			readonly refusal?: WatchRefusal | DeliveryRefusal;
			readonly action?: StageUserMessageDeliveryAction;
			/** The stage refused the text for another reason; the message says why. */
			readonly error?: string;
	  }
	| { readonly kind: "stage-events"; readonly watch: WatchId; readonly events: readonly SeqEvent[] }
	| { readonly kind: "stage-watch-ended"; readonly watch: WatchId; readonly reason: WatchEndReason }
);
export interface WorkerReply {
	readonly id: number;
	readonly value?: WorkflowSerializableValue | PoolWork | PoolControl;
	readonly error?: string;
	/** The refusal fences the worker's attempt: the work has another owner, or none, and the attempt must end. */
	readonly fenced?: true;
	/** The root no longer holds its lease (it released it, or another incarnation took it): the worker has nothing to serve. */
	readonly rootLeaseLost?: true;
	readonly delivery?: {
		readonly id: string;
		readonly from: Parameters<WorkerDeliver>[0];
		readonly message: Parameters<WorkerDeliver>[1];
	};
}

/** Coordinator -> worker push: a command for one stage of the attempt the worker holds (#3996). */
export type WorkerStageCommand = {
	readonly kind: "stage-command";
	readonly commandId: number;
	readonly attempt: AttemptRef;
} & (
	| { readonly op: "watch"; readonly watch: WatchId; readonly runId: string; readonly stageId: string }
	| { readonly op: "unwatch"; readonly watch: WatchId }
	| {
			readonly op: "deliver";
			readonly watch: WatchId;
			readonly deliveryOp: DeliveryOpId;
			readonly text: string;
			readonly intent: DeliveryIntent;
			readonly expandPromptTemplates?: boolean;
	  }
);

/** Everything a worker receives over IPC: replies to its requests, and stage commands. */
export type WorkerInbound = WorkerReply | WorkerStageCommand;
