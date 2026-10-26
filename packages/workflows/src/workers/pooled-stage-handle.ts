import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import type {
	AgentSessionEventListener,
	StageControlHandle,
	StageControlStatus,
	StagePlacement,
} from "../runs/foreground/stage-control-registry.js";
import { StageQueuedUserMessageBuffer } from "../runs/foreground/stage-queued-user-messages.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import { StageToolExecutionBuffer } from "../runs/foreground/stage-tool-execution-buffer.js";
import type { StageSendUserMessageOptions } from "../shared/types.js";
import type {
	DeliveryIntent,
	DeliveryOpId,
	DeliveryRefusal,
	DeliveryResult,
	PooledStageChatSnapshot,
	PooledStageDelivery,
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
	/** The one door for user text into the watched stage; at most once per op. */
	deliver(delivery: PooledStageDelivery): Promise<DeliveryResult>;
}

/** User text a pooled stage did not admit, with the reason. */
export class PooledStageDeliveryError extends Error {
	constructor(
		readonly refusal: DeliveryRefusal,
		stageName: string,
	) {
		super(
			refusal === "StageNotLive"
				? `Stage "${stageName}" finished before the message was delivered; open it again to continue in post-mortem chat.`
				: refusal === "StaleAttempt"
					? `Stage "${stageName}" moved to another worker attempt; the message was not delivered.`
					: `The connection to stage "${stageName}" was lost; the message may not have been delivered.`,
		);
		this.name = "PooledStageDeliveryError";
	}
}

/**
 * Root-side `StageControlHandle` of a stage that runs on a local worker (#3996).
 *
 * It mirrors the worker's real handle from one watch: the snapshot the watch opened with,
 * then its ordered events. Consumers read it like an in-process handle. It has no
 * `agentSession`; user text goes through the pool's single delivery door.
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
		private readonly deliverDoor: (delivery: PooledStageDelivery) => Promise<DeliveryResult>,
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

	/**
	 * Delivers through the worker's idle-aware stage delivery and reports its action.
	 * `beforeDelivery` runs here, immediately before the text is sent to the worker.
	 */
	async sendUserMessage(
		text: string,
		options?: StageSendUserMessageOptions,
		beforeDelivery?: () => void,
	): Promise<StageUserMessageDeliveryAction> {
		beforeDelivery?.();
		return this.deliver(text, options?.deliverAs ?? "auto", options);
	}
	async prompt(text: string): Promise<void> {
		await this.deliver(text, "auto");
	}
	async steer(text: string): Promise<void> {
		await this.deliver(text, "steer");
	}
	async followUp(text: string): Promise<void> {
		await this.deliver(text, "followUp");
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

	private async deliver(
		text: string,
		intent: DeliveryIntent,
		options?: StageSendUserMessageOptions,
	): Promise<StageUserMessageDeliveryAction> {
		if (this.disposed) throw new Error(`Stage chat "${this.stageName}" is closed.`);
		const result = await this.deliverDoor({
			watch: this.watchId,
			op: randomUUID() as DeliveryOpId,
			text,
			intent,
			...(options?.expandPromptTemplates === undefined
				? {}
				: { options: { expandPromptTemplates: options.expandPromptTemplates } }),
		});
		if (!result.ok) throw new PooledStageDeliveryError(result.refusal, this.stageName);
		return result.action;
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
	return new Error(`Stage "${stageName}" runs on a local worker; pausing it is not available yet.`);
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
	handle = new PooledStageHandle(
		ref.runId,
		ref.stageId,
		stageName,
		watch.id,
		watch.snapshot,
		watch.attempt,
		() => {
			onClose();
			void transport.unwatch(watch.id);
		},
		(delivery) => transport.deliver(delivery),
	);
	for (const message of early.splice(0)) handle.receive(message);
	return { ok: true, handle };
}
