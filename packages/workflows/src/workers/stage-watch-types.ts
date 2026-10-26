import type { AgentSession, AgentSessionEvent, QuestionParams } from "@bastani/atomic";
import type { StageControlStatus } from "../runs/foreground/stage-control-registry.js";
import type { StageQueuedUserMessages } from "../runs/foreground/stage-queued-user-messages.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import type { StageInputAnswer } from "../shared/stage-prompt.js";
import type { StageInputKind } from "../shared/store-types.js";
import type { StageSendUserMessageOptions, WorkflowSerializableValue } from "../shared/types.js";

/**
 * Identity and payload types of a pooled stage watch: a live, attempt-bound view of one
 * stage that runs on a local worker (#3996). Types only, so every process can import them
 * without loading code.
 */

/** Minted only by the coordinator when a watch opens. */
export type WatchId = string & { readonly __brand: "WatchId" };

export interface PooledStageRef {
	readonly runId: string;
	readonly stageId: string;
}

/** The work attempt a watch is bound to; a watch cannot outlive it. */
export interface AttemptRef {
	readonly workId: string;
	readonly generation: number;
}

/** One session event with its position in the watch's ordered stream. */
export interface SeqEvent {
	readonly seq: number;
	readonly event: AgentSessionEvent;
}

type AssistantMessage = NonNullable<NonNullable<AgentSession["agent"]>["state"]["streamingMessage"]>;

export interface PooledStageChatSnapshot {
	readonly sessionId: string | undefined;
	readonly status: StageControlStatus;
	readonly isStreaming: boolean;
	/** Settled messages. */
	readonly messages: AgentSession["messages"];
	/** The assistant message still streaming, if any. */
	readonly streamingMessage?: AssistantMessage;
	readonly pendingToolExecutionEvents: readonly AgentSessionEvent[];
	readonly queued: StageQueuedUserMessages;
	/**
	 * Delivery ops whose text this attempt's session already holds, so a handle that reconnects
	 * after a fence redelivers only what the replacement attempt does not have.
	 */
	readonly deliveredOps?: readonly DeliveryOpId[];
	/**
	 * Whether the stage started a turn in this attempt. A replacement that has not redelivers
	 * nothing until it does, so the replay's own prompt comes first.
	 */
	readonly turnStarted?: boolean;
	/** Seq of the last event folded into this snapshot; the stream continues after it. */
	readonly seq: number;
}

export interface PooledStageWatch {
	readonly id: WatchId;
	readonly attempt: AttemptRef;
	readonly snapshot: PooledStageChatSnapshot;
}

/**
 * Why a watch could not open.
 * - `StageNotOnWorker`: the stage is not running under a pooled attempt (pending, finished, or unpooled).
 * - `AttemptChanging`: its attempt is being fenced; retry once activity shows the next attempt.
 * - `PoolClosed`: the pool is closed.
 */
export type WatchRefusal = "StageNotOnWorker" | "AttemptChanging" | "PoolClosed";

/**
 * Why the system ended a watch. `resync` means the watcher fell behind the bounded backlog
 * and must reopen for a fresh snapshot.
 */
export type WatchEndReason = "attempt_fenced" | "worker_exited" | "stage_finished" | "pool_closed" | "resync";

export type WatchResult =
	| { readonly ok: true; readonly watch: PooledStageWatch }
	| { readonly ok: false; readonly refusal: WatchRefusal };

/** Minted by the root handle once per user action; the worker admits each at most once. */
export type DeliveryOpId = string & { readonly __brand: "DeliveryOpId" };

/** How user text joins the stage's turn: steer it, queue a follow-up, or whichever fits (`auto`). */
export type DeliveryIntent = "steer" | "followUp" | "auto";

/**
 * Why user text was not admitted.
 * - `StaleAttempt`: the watch's attempt was fenced before admission; the text was not delivered.
 * - `StageNotLive`: the stage finished before admission; continue in post-mortem chat.
 * - `Unconfirmed`: the transport was lost after sending; the text may or may not have been admitted.
 */
export type DeliveryRefusal = "StaleAttempt" | "StageNotLive" | "Unconfirmed";

export type DeliveryResult =
	| { readonly ok: true; readonly action: StageUserMessageDeliveryAction }
	| { readonly ok: false; readonly refusal: DeliveryRefusal };

/**
 * Why a per-stage pause or resume was refused.
 * - `PoolPausedOrQuitting`: pool-wide control holds every stage; per-stage control waits for it.
 */
export type ControlRefusal = "StaleAttempt" | "StageNotLive" | "PoolPausedOrQuitting";

export type ControlResult =
	| { readonly ok: true; readonly action?: StageUserMessageDeliveryAction }
	| { readonly ok: false; readonly refusal: ControlRefusal };

/**
 * An answer to a human-input prompt a pooled stage raised (#3996): a workflow `ctx.ui` prompt
 * node (`prompt`), or a stage's brokered question such as `ask_user_question` (`input`).
 * Bound to the prompt id, so an answer meant for one prompt never resolves another.
 */
export type PooledPromptAnswer =
	| { readonly kind: "prompt"; readonly promptId: string; readonly response: WorkflowSerializableValue }
	| { readonly kind: "input"; readonly promptId: string; readonly answer: StageInputAnswer }
	/** The root could not answer the prompt: it fails in the worker with `error`, as an in-process `ui` rejection does. */
	| { readonly kind: "failed"; readonly promptId: string; readonly error: string };

/**
 * A stage's brokered question (`ask_user_question`) as its worker holds it (#3996): the exact
 * tool parameters, so the root can show the same form an in-process stage shows.
 */
export interface PooledStageQuestion {
	readonly promptId: string;
	readonly kind: StageInputKind;
	readonly params: QuestionParams;
}

/**
 * Why an answer was not applied.
 * - `PromptNotPending`: the stage has no pending prompt with that id (already answered or replaced).
 */
export type PromptRefusal = "StaleAttempt" | "StageNotLive" | "PromptNotPending";

export type PromptResult = { readonly ok: true } | { readonly ok: false; readonly refusal: PromptRefusal };

/** One user delivery through a watch. */
export interface PooledStageDelivery {
	readonly watch: WatchId;
	readonly op: DeliveryOpId;
	readonly text: string;
	readonly intent: DeliveryIntent;
	readonly options?: Pick<StageSendUserMessageOptions, "expandPromptTemplates">;
}

/** A stage watch's events after the snapshot, or its end. Applied in order. */
export type PooledStageWatchMessage =
	| { readonly kind: "events"; readonly events: readonly SeqEvent[] }
	| { readonly kind: "ended"; readonly reason: WatchEndReason };
