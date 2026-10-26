import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import type {
	AgentSessionEventListener,
	StageControlHandle,
	StageControlStatus,
	StagePlacement,
} from "../runs/foreground/stage-control-registry.js";
import { StageQueuedUserMessageBuffer } from "../runs/foreground/stage-queued-user-messages.js";
import { StageToolExecutionBuffer } from "../runs/foreground/stage-tool-execution-buffer.js";
import type {
	PooledStageChatSnapshot,
	PooledStageRef,
	PooledStageWatchMessage,
	WatchEndReason,
	WatchId,
	WatchRefusal,
	WatchResult,
} from "./stage-watch-types.js";

type AgentMessage = AgentSession["messages"][number];
type StreamingMessage = PooledStageChatSnapshot["streamingMessage"];

/** The watch doors a pooled stage handle is built on; a pool implements them over its coordinator. */
export interface PooledStageTransport {
	/**
	 * Opens a watch. `listener` receives the events after the returned snapshot, in order;
	 * the first of them may arrive before this promise settles.
	 */
	watch(ref: PooledStageRef, listener: (message: PooledStageWatchMessage) => void): Promise<WatchResult>;
	unwatch(watch: WatchId): Promise<void>;
}

/**
 * Root-side `StageControlHandle` of a stage that runs on a local worker (#3996).
 *
 * It mirrors the worker's real handle from one watch: the snapshot the watch opened with,
 * then its ordered events. Consumers read it like an in-process handle. It has no
 * `agentSession`; steering a pooled stage is not available through it yet.
 */
export class PooledStageHandle implements StageControlHandle {
	readonly sessionFile = undefined;
	readonly placement: StagePlacement;
	private readonly listeners = new Set<AgentSessionEventListener>();
	private readonly settled: AgentMessage[];
	private readonly toolExecutions = new StageToolExecutionBuffer();
	private readonly queued = new StageQueuedUserMessageBuffer();
	private streaming: StreamingMessage;
	private currentStatus: StageControlStatus;
	private streamingNow: boolean;
	private seq: number;
	private ended?: WatchEndReason;
	private disposed = false;

	constructor(
		readonly runId: string,
		readonly stageId: string,
		readonly stageName: string,
		private readonly watchId: WatchId,
		snapshot: PooledStageChatSnapshot,
		attempt: { readonly workId: string; readonly generation: number },
		private readonly close: () => void,
		readonly sessionId = snapshot.sessionId,
	) {
		this.placement = { kind: "local-worker", workId: attempt.workId, generation: attempt.generation };
		this.settled = [...snapshot.messages];
		this.streaming = snapshot.streamingMessage;
		this.currentStatus = snapshot.status;
		this.streamingNow = snapshot.isStreaming;
		this.seq = snapshot.seq;
		for (const event of snapshot.pendingToolExecutionEvents) this.toolExecutions.record(event);
		this.queued.record({
			type: "queue_update",
			steering: [...snapshot.queued.steering],
			followUp: [...snapshot.queued.followUp],
		} as AgentSessionEvent);
	}

	get watch(): WatchId {
		return this.watchId;
	}
	get status(): StageControlStatus {
		return this.currentStatus;
	}
	get isStreaming(): boolean {
		return this.streamingNow;
	}
	get isDisposed(): boolean {
		return this.disposed;
	}
	/** Why the watch behind this handle ended; undefined while it is live. */
	get endReason(): WatchEndReason | undefined {
		return this.ended;
	}
	get messages(): AgentSession["messages"] {
		return this.settled;
	}
	streamingMessage(): StreamingMessage {
		return this.streaming;
	}
	pendingToolExecutionEvents(): readonly AgentSessionEvent[] {
		return this.toolExecutions.replayEvents();
	}
	queuedUserMessages() {
		return this.queued.snapshot();
	}

	/** Applies one message of the watch stream. */
	receive(message: PooledStageWatchMessage): void {
		if (message.kind === "ended") {
			this.ended ??= message.reason;
			this.streamingNow = false;
			return;
		}
		for (const { seq, event } of message.events) {
			if (seq <= this.seq) continue;
			this.seq = seq;
			this.apply(event);
			for (const listener of [...this.listeners]) listener(event);
		}
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async ensureAttached(): Promise<void> {}

	async prompt(): Promise<void> {
		throw unsupported(this.stageName);
	}
	async steer(): Promise<void> {
		throw unsupported(this.stageName);
	}
	async followUp(): Promise<void> {
		throw unsupported(this.stageName);
	}
	async pause(): Promise<void> {
		throw unsupported(this.stageName);
	}
	async resume(): Promise<undefined> {
		throw unsupported(this.stageName);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		this.close();
	}

	private apply(event: AgentSessionEvent): void {
		this.toolExecutions.record(event);
		this.queued.record(event);
		switch (event.type) {
			case "agent_start":
				this.streamingNow = true;
				if (this.currentStatus !== "paused") this.currentStatus = "running";
				return;
			case "agent_end":
				this.streamingNow = false;
				this.streaming = undefined;
				return;
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") this.streaming = event.message as StreamingMessage;
				return;
			case "message_end":
				this.settled.push(event.message);
				if (event.message.role === "assistant") this.streaming = undefined;
				return;
		}
	}
}

function unsupported(stageName: string): Error {
	return new Error(`Stage "${stageName}" runs on a local worker; sending it messages is not available yet.`);
}

/** Opens a watch through `transport` and returns the handle that mirrors it. */
export async function openPooledStageHandle(
	transport: PooledStageTransport,
	ref: PooledStageRef,
	stageName: string,
	onClose: () => void = () => {},
): Promise<
	{ readonly ok: true; readonly handle: PooledStageHandle } | { readonly ok: false; readonly refusal: WatchRefusal }
> {
	let handle: PooledStageHandle | undefined;
	const early: PooledStageWatchMessage[] = [];
	const result = await transport.watch(ref, (message) => {
		if (handle === undefined) early.push(message);
		else handle.receive(message);
	});
	if (!result.ok) return result;
	const { watch } = result;
	handle = new PooledStageHandle(ref.runId, ref.stageId, stageName, watch.id, watch.snapshot, watch.attempt, () => {
		onClose();
		void transport.unwatch(watch.id);
	});
	for (const message of early.splice(0)) handle.receive(message);
	return { ok: true, handle };
}
