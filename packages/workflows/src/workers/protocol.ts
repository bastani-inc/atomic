import type { CreateAgentSessionOptions, ProviderRateLimitObservation } from "@bastani/atomic";
import type { PoolControl, PoolMutation, PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { PoolUsageReport } from "../durable/journal/sql-pool-usage.js";
import type { RunResult } from "../runs/foreground/executor-types.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import type { SerializedError } from "../shared/error-codec.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { WorkerDefinitionSource } from "./definitions.js";
import type { AdmissionConfiguration } from "./resource-admission.js";
import type {
	AttemptRef,
	ControlRefusal,
	DeliveryIntent,
	DeliveryOpId,
	DeliveryRefusal,
	IntercomRefusal,
	PooledBashResult,
	PooledPromptAnswer,
	PooledStageChatSnapshot,
	PooledStageQuestion,
	PooledStageSessionCommand,
	PooledTaskReply,
	PromptRefusal,
	SeqEvent,
	StageInputDeferral,
	WatchEndReason,
	WatchId,
	WatchRefusal,
} from "./stage-watch-types.js";

/**
 * How often a worker sweeps its stage watches and republishes its attempt's activity. Neither writes to the journal:
 * the attempt's lease, usage and pool control travel in its heartbeat, every `WorkerStart.heartbeatMs`.
 */
export const WORKER_ACTIVITY_INTERVAL_MS = 1_000;

/** `Omit` applied to each member of a union. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends T ? Omit<T, K> : never;

export type WorkerStageDelivery = NonNullable<
	NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["pendingStageDelivery"]
>;
export type WorkerDeliver = Parameters<WorkerStageDelivery["deliverPending"]>[0];
export type WorkerRecipient = Parameters<WorkerStageDelivery["deliverPending"]>[1];

/** The messages a stage's session `sessionId` took before its first turn, which the root records as delivered. */
export interface StageReceipts {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly sessionId: string;
	readonly messageIds: readonly string[];
}

/**
 * The result a worker completes its attempt with: the child's run result and, when any of them took messages, the
 * receipts of the stages of the child's nested workflow runs; the child's own stages carry theirs. The pool stores it
 * whole, so a restarted root still reads them, and the root records them all before the child settles (#4513).
 */
export type PooledRunResult = RunResult & { readonly nestedStageReceipts?: readonly StageReceipts[] };

export interface WorkerStart {
	/** The SQLite database holding the pool's tables; absent for a shared pool, opened by its durable selection. */
	readonly journalPath?: string;
	/**
	 * Set for a shared pool (#4310). `routes: false` is a worker on a host that does not run the root: its stages hold
	 * no live route of the root's, which only the root's host announces, and take Intercom messages through their input
	 * queues instead (#4391).
	 */
	readonly shared?: { readonly host: string; readonly routes: boolean };
	readonly root: string;
	readonly definitions: readonly WorkerDefinitionSource[];
	/**
	 * How often the worker's heartbeat renews its attempt's work lease, reports its usage and reads pool control, all in
	 * one request (`localWorkers.heartbeatMs`, a quarter of `localWorkers.leaseMs` by default).
	 */
	readonly heartbeatMs: number;
	readonly admission?: AdmissionConfiguration;
	/** Children raise `ctx.ui` prompts as prompt nodes for the root to answer (#3996). */
	readonly promptNodes?: boolean;
	/** Load per CPU above which the root's pooled stage starts are paced (`localWorkers.maxLoadPerCpu`). */
	readonly stageStartMaxLoadPerCpu?: number;
	/**
	 * Resident set size, in bytes, past which the worker ends once its current child's attempt is over, and the pool
	 * starts a fresh worker in its place (`localWorkers.maxWorkerRssBytes`). Undefined: never.
	 */
	readonly maxRssBytes?: number;
}
export type WorkerRequest = { readonly id: number } & (
	| { readonly kind: "ready" | "claim" | "budget" | "control" }
	/**
	 * Renews the held attempt's work lease and records the attempt's cumulative usage, in one journal transaction that
	 * also reads pool control; the reply is the current {@link PoolControl}.
	 */
	| { readonly kind: "heartbeat"; readonly reports: readonly PoolUsageReport[] }
	/**
	 * The worker ended its attempt because a reply refused it as stale, or because its run failed on a fault of the pool
	 * (`fault` is that fault); neither is a worker fault, and the child replays within its attempt limit.
	 */
	| { readonly kind: "fenced"; readonly fault?: SerializedError }
	/**
	 * The worker holds no attempt and is about to exit because its resident set size, `rssBytes`, passed its
	 * `maxRssBytes`, after running `attempts` attempts: a planned exit, not a crash, so the pool starts a replacement
	 * without counting it as a failure.
	 */
	| { readonly kind: "recycle"; readonly rssBytes: number; readonly attempts: number }
	| { readonly kind: "controlled"; readonly revision: number }
	/**
	 * A failed stage carries the typed error it failed on as `failureDetail`, a `SerializedError`, and so does the
	 * `complete` result for the run (#4309, #4378). The root reads it as untrusted input when it makes a failed child
	 * its parent's error.
	 */
	| { readonly kind: "activity"; readonly runs: readonly RunSnapshot[] }
	/**
	 * The attempt's place among the pool's `count`: `release` gives it back while every live stage waits released;
	 * `reacquire` asks for one again before the attempt starts anything, and is answered `true` once granted, or `false`
	 * when the attempt ended first.
	 */
	| { readonly kind: "place"; readonly op: "release" | "reacquire" }
	| { readonly kind: "route"; readonly runId: string }
	/** A stage of the attempt started its session: the pool records where it runs (shared pools only, #4310). */
	| { readonly kind: "stage-workspace"; readonly runId: string; readonly stageId: string }
	| {
			readonly kind: "delivery" | "delivery-ready";
			readonly runId: string;
			readonly stageId: string;
			readonly stageName: string;
			readonly recipient?: WorkerRecipient;
			readonly sessionId?: string;
	  }
	| { readonly kind: "delivery-ack"; readonly deliveryId: string; readonly error?: SerializedError }
	| { readonly kind: "commit"; readonly operation: string; readonly mutation: PoolMutation }
	| { readonly kind: "complete"; readonly result: PooledRunResult }
	// One-way stage watch traffic (#3996); the coordinator does not reply to these.
	| {
			readonly kind: "stage-command-result";
			readonly commandId: number;
			readonly snapshot?: PooledStageChatSnapshot;
			readonly refusal?:
				| WatchRefusal
				| DeliveryRefusal
				| ControlRefusal
				| PromptRefusal
				| IntercomRefusal
				| StageInputDeferral;
			readonly action?: StageUserMessageDeliveryAction;
			readonly question?: PooledStageQuestion;
			/** The result of a `!` shell command run on the stage's session. */
			readonly bash?: PooledBashResult;
			/** The answer to an action on one of the stage's background tasks. */
			readonly task?: PooledTaskReply;
			/** The stage refused the command for another reason; the error says why. */
			readonly error?: SerializedError;
	  }
	| { readonly kind: "stage-events"; readonly watch: WatchId; readonly events: readonly SeqEvent[] }
	| { readonly kind: "stage-watch-ended"; readonly watch: WatchId; readonly reason: WatchEndReason }
	/** One-way: limits this worker recorded, for the rest of the pool (#4023). */
	| { readonly kind: "rate-limits"; readonly observations: readonly ProviderRateLimitObservation[] }
);
export interface WorkerReply {
	readonly id: number;
	readonly value?: WorkflowSerializableValue | PoolWork | PoolControl;
	/**
	 * The refusal, typed: a stale work lease in its cause chain fences the worker's attempt, and a stale root lease
	 * (`StaleLeaseError`) means the root no longer holds its lease, so the worker has nothing to serve.
	 */
	readonly error?: SerializedError;
	/**
	 * On a `claim` reply: the pool runs more workers than its waiting children need, so this idle worker ends, cleanly,
	 * and nothing replaces it.
	 */
	readonly retire?: true;
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
	| { readonly op: "pause"; readonly watch: WatchId }
	/** Runs a session command (`/compact`, a `!` shell command) on the watched stage's session. */
	| { readonly op: "session"; readonly watch: WatchId; readonly command: PooledStageSessionCommand }
	/** Answers a prompt of the attempt's stage; needs no watch, since a prompt waits for whoever answers. */
	/** Reads the brokered question the attempt's stage waits on; needs no watch either. */
	| { readonly op: "question"; readonly runId: string; readonly stageId: string }
	/**
	 * Admits stage chat text into the attempt's stage without a watch, at most once per op: the root sends it through
	 * the stage's input queue when the stage runs on another host, which streams no watch to it (#4391).
	 */
	| {
			readonly op: "user-message";
			readonly runId: string;
			readonly stageId: string;
			readonly deliveryOp: DeliveryOpId;
			readonly text: string;
			readonly intent: DeliveryIntent;
			readonly expandPromptTemplates?: boolean;
	  }
	/**
	 * Hands an Intercom message to the stage session's own pending-stage delivery, which holds no live route on a host
	 * that does not run the root: its messages arrive through the stage's input queue (#4391).
	 */
	| {
			readonly op: "intercom";
			readonly runId: string;
			readonly stageId: string;
			readonly sessionId: string;
			readonly from: Parameters<WorkerDeliver>[0];
			readonly message: Parameters<WorkerDeliver>[1];
	  }
	| {
			readonly op: "answer";
			readonly runId: string;
			readonly stageId: string;
			readonly answer: PooledPromptAnswer;
	  }
	| {
			readonly op: "resume";
			readonly watch: WatchId;
			/** Sent as the next user message, admitted at most once per op. */
			readonly message?: { readonly deliveryOp: DeliveryOpId; readonly text: string };
	  }
);

/** Coordinator -> worker push: provider and model limits recorded elsewhere in the pool (#4023). */
export interface WorkerRateLimits {
	readonly kind: "rate-limits";
	readonly observations: readonly ProviderRateLimitObservation[];
}

/** Coordinator -> worker push: pool control as committed, sent to every ready worker when it changes. */
export interface WorkerPoolControl {
	readonly kind: "pool-control";
	readonly control: PoolControl;
}

/** Everything a worker receives over IPC: replies to its requests, stage commands, pool control and shared limits. */
export type WorkerInbound = WorkerReply | WorkerStageCommand | WorkerPoolControl | WorkerRateLimits;
