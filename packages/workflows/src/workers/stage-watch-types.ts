import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import type { StageControlStatus } from "../runs/foreground/stage-control-registry.js";
import type { StageQueuedUserMessages } from "../runs/foreground/stage-queued-user-messages.js";

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

/** A stage watch's events after the snapshot, or its end. Applied in order. */
export type PooledStageWatchMessage =
	| { readonly kind: "events"; readonly events: readonly SeqEvent[] }
	| { readonly kind: "ended"; readonly reason: WatchEndReason };
