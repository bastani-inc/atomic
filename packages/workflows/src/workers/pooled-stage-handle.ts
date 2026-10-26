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
	ControlRefusal,
	ControlResult,
	DeliveryIntent,
	DeliveryOpId,
	DeliveryRefusal,
	DeliveryResult,
	PooledStageChatSnapshot,
	PooledStageDelivery,
	PooledStageRef,
	PooledStageWatch,
	PooledStageWatchMessage,
	WatchEndReason,
	WatchId,
	WatchRefusal,
	WatchResult,
} from "./stage-watch-types.js";

type AgentMessage = AgentSession["messages"][number];
type StreamingMessage = PooledStageChatSnapshot["streamingMessage"];

/** Watch ends after which the stage may continue on another attempt; the handle reconnects. */
const RECONNECTABLE = new Set<WatchEndReason>(["attempt_fenced", "worker_exited", "resync"]);

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
	/** Holds or releases this one stage's turn loop; pool control is untouched. */
	pause(watch: WatchId): Promise<ControlResult>;
	resume(watch: WatchId, message?: { readonly op: DeliveryOpId; readonly text: string }): Promise<ControlResult>;
}

/** User text or a control a pooled stage did not admit, with the reason. */
export class PooledStageDeliveryError extends Error {
	constructor(
		readonly refusal: DeliveryRefusal | ControlRefusal,
		stageName: string,
	) {
		super(
			refusal === "StageNotLive"
				? `Stage "${stageName}" finished first; open it again to continue in post-mortem chat.`
				: refusal === "PoolPausedOrQuitting"
					? `The local worker pool running stage "${stageName}" is paused or quitting; resume the run first.`
					: refusal === "StaleAttempt"
						? `Stage "${stageName}" is moving to another worker attempt; the message is sent again when it reconnects.`
						: `The connection to stage "${stageName}" was lost; the message is sent again when it reconnects unless it already arrived.`,
		);
		this.name = "PooledStageDeliveryError";
	}
}

/**
 * User text sent through this handle, kept in send order until a reconnected attempt's
 * session shows it arrived. Every send goes through this one queue, so redelivered text and
 * text sent while a rebind is in flight reach the replacement in the order the user sent it.
 */
interface OutboundEntry {
	readonly op: DeliveryOpId;
	readonly text: string;
	/** How the text was sent; a redelivery keeps it, so a steer still steers. */
	readonly intent: DeliveryIntent;
	readonly options?: PooledStageDelivery["options"];
	/** Sent as a resume message rather than a delivery, the first time. */
	readonly resume: boolean;
	/** Sent to the current attempt. */
	sent: boolean;
	/** Sent to an earlier attempt that ended; a send now is a redelivery. */
	resend: boolean;
	/** The caller waiting for the first send's outcome. */
	waiter?: {
		readonly resolve: (action: StageUserMessageDeliveryAction | undefined) => void;
		readonly reject: (error: Error) => void;
	};
}

/**
 * Root-side `StageControlHandle` of a stage that runs on a local worker (#3996).
 *
 * It mirrors the worker's real handle from one watch: the snapshot the watch opened with,
 * then its ordered events. Consumers read it like an in-process handle. It has no
 * `agentSession`; user text goes through the pool's single delivery door.
 *
 * When the worker dies or its attempt is fenced, the handle reports `reconnecting` until
 * the pool rebinds it to the replacement attempt. It then redelivers, at most once per op,
 * every message it sent that the replacement attempt's session does not hold.
 */
export class PooledStageHandle implements StageControlHandle {
	readonly sessionFile = undefined;
	private readonly listeners = new Set<AgentSessionEventListener>();
	private readonly rebindListeners = new Set<(redelivered: number) => void>();
	private readonly outbound: OutboundEntry[] = [];
	private settled: AgentMessage[] = [];
	private toolExecutions = new StageToolExecutionBuffer();
	private queued = new StageQueuedUserMessageBuffer();
	private streaming: StreamingMessage;
	private currentStatus: StageControlStatus = "running";
	private streamingNow = false;
	private seq = 0;
	private attempt: { readonly workId: string; readonly generation: number };
	private ended?: WatchEndReason;
	private reconnecting = false;
	private redelivered?: number;
	private disposed = false;
	private session: string | undefined;
	/** The outbound queue's sender while it runs; one at a time keeps send order. */
	private pumping?: Promise<void>;
	/** A rebind in flight: redelivery waits for the replacement's own turn, then drains. */
	private rebinding?: {
		readonly watch: WatchId;
		awaitingTurn: boolean;
		redelivered: number;
		readonly done: (redelivered: number) => void;
	};

	constructor(
		readonly runId: string,
		readonly stageId: string,
		readonly stageName: string,
		private watchId: WatchId,
		snapshot: PooledStageChatSnapshot,
		attempt: { readonly workId: string; readonly generation: number },
		private readonly close: (watch: WatchId) => void,
		private readonly transport: Pick<PooledStageTransport, "deliver" | "pause" | "resume">,
	) {
		this.attempt = attempt;
		this.adopt(snapshot);
	}

	get watch(): WatchId {
		return this.watchId;
	}
	get placement(): StagePlacement {
		return {
			kind: "local-worker",
			workId: this.attempt.workId,
			generation: this.attempt.generation,
			...(this.reconnecting ? { reconnecting: true } : {}),
			...(this.redelivered === undefined ? {} : { redelivered: this.redelivered }),
		};
	}
	get sessionId(): string | undefined {
		return this.session;
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
	/** Why the watch behind this handle ended for good; undefined while it is live or reconnecting. */
	get endReason(): WatchEndReason | undefined {
		return this.ended;
	}
	/** True between the end of a watch on a fenced attempt and its rebinding to the next one. */
	get isReconnecting(): boolean {
		return this.reconnecting;
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

	/** Observes rebinding to a replacement attempt, with the number of messages redelivered. */
	onRebind(listener: (redelivered: number) => void): () => void {
		this.rebindListeners.add(listener);
		return () => {
			this.rebindListeners.delete(listener);
		};
	}

	/** Applies one message of the watch stream. */
	receive(message: PooledStageWatchMessage): void {
		if (message.kind === "ended") {
			this.streamingNow = false;
			if (RECONNECTABLE.has(message.reason) && !this.disposed) this.reconnecting = true;
			else {
				// Ended for good: nothing will reconnect, so the chat must not say it is reconnecting.
				this.ended ??= message.reason;
				this.reconnecting = false;
			}
			// A rebind cut short by this end leaves the rest for the next attempt.
			this.finishRebind(false);
			return;
		}
		for (const { seq, event } of message.events) {
			if (seq <= this.seq) continue;
			this.seq = seq;
			this.apply(event);
			for (const listener of [...this.listeners]) listener(event);
		}
	}

	/**
	 * Binds the handle to a watch of the replacement attempt, then redelivers in send order, each
	 * in its original mode, every message whose op the replacement's session does not hold.
	 * The handle reads as reconnecting until that is done. Resolves with how many were sent.
	 */
	rebind(watch: PooledStageWatch): Promise<number> {
		const previous = this.watchId;
		this.finishRebind(false);
		this.watchId = watch.id;
		this.attempt = watch.attempt;
		this.adopt(watch.snapshot);
		if (previous !== watch.id) this.close(previous);
		const present = new Set(watch.snapshot.deliveredOps ?? []);
		for (const entry of [...this.outbound]) {
			if (present.has(entry.op)) this.forget(entry.op);
			else if (entry.sent) {
				entry.sent = false;
				entry.resend = true;
			}
		}
		const done = Promise.withResolvers<number>();
		this.rebinding = {
			watch: watch.id,
			// The replay sends the stage's own prompt first; redelivered text joins its turn, as it did.
			// The replay's session may already hold earlier messages, so only a streaming turn counts.
			awaitingTurn: !this.streamingNow && this.outbound.some((entry) => !entry.sent),
			redelivered: 0,
			done: done.resolve,
		};
		this.reconnecting = true;
		this.pump();
		return done.promise;
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
		this.throwIfClosed();
		const result = await this.transport.pause(this.watchId);
		if (!result.ok) throw new PooledStageDeliveryError(result.refusal, this.stageName);
		this.currentStatus = "paused";
		this.streamingNow = false;
	}
	async resume(message?: string, beforeResume?: () => void): Promise<StageUserMessageDeliveryAction | undefined> {
		this.throwIfClosed();
		if (message === undefined || message.trim().length === 0) {
			beforeResume?.();
			const result = await this.transport.resume(this.watchId);
			if (!result.ok) throw new PooledStageDeliveryError(result.refusal, this.stageName);
			this.currentStatus = "running";
			return result.action;
		}
		beforeResume?.();
		const action = await this.send(message, "auto", undefined, true);
		this.currentStatus = "running";
		return action;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.outbound) entry.waiter?.reject(new Error(`Stage chat "${this.stageName}" is closed.`));
		this.finishRebind(false);
		this.listeners.clear();
		this.rebindListeners.clear();
		this.close(this.watchId);
	}

	private throwIfClosed(): void {
		if (this.disposed) throw new Error(`Stage chat "${this.stageName}" is closed.`);
	}

	private forget(op: DeliveryOpId): void {
		const index = this.outbound.findIndex((entry) => entry.op === op);
		if (index >= 0) this.outbound.splice(index, 1);
	}

	private async deliver(
		text: string,
		intent: DeliveryIntent,
		options?: StageSendUserMessageOptions,
	): Promise<StageUserMessageDeliveryAction> {
		this.throwIfClosed();
		const action = await this.send(
			text,
			intent,
			options?.expandPromptTemplates === undefined
				? undefined
				: { expandPromptTemplates: options.expandPromptTemplates },
			false,
		);
		return action ?? "prompt";
	}

	/** Queues text behind everything sent before it and resolves with its first send's outcome. */
	private send(
		text: string,
		intent: DeliveryIntent,
		options: PooledStageDelivery["options"],
		resume: boolean,
	): Promise<StageUserMessageDeliveryAction | undefined> {
		const outcome = Promise.withResolvers<StageUserMessageDeliveryAction | undefined>();
		this.outbound.push({
			op: randomUUID() as DeliveryOpId,
			text,
			intent,
			...(options === undefined ? {} : { options }),
			resume,
			sent: false,
			resend: false,
			waiter: { resolve: outcome.resolve, reject: outcome.reject },
		});
		// While the watch's attempt is gone the text waits for the replacement; say so now.
		if (this.reconnecting && this.rebinding === undefined) {
			const waiting = this.outbound.at(-1)!;
			waiting.waiter = undefined;
			outcome.reject(new PooledStageDeliveryError("StaleAttempt", this.stageName));
		}
		this.pump();
		return outcome.promise;
	}

	/** Sends unsent text in order to the current attempt, one message at a time. */
	private pump(): void {
		if (this.pumping !== undefined) return;
		this.pumping = (async () => {
			for (;;) {
				if (this.disposed || (this.reconnecting && this.rebinding === undefined)) return;
				if (this.rebinding?.awaitingTurn === true) return;
				const entry = this.outbound.find((candidate) => !candidate.sent);
				if (entry === undefined) break;
				const watch = this.watchId;
				entry.sent = true;
				const result = await this.sendEntry(entry, watch);
				const waiter = entry.waiter;
				entry.waiter = undefined;
				if (result.ok) {
					if (entry.resend && this.rebinding?.watch === watch) this.rebinding.redelivered++;
					waiter?.resolve(result.action);
					continue;
				}
				// A stale or unconfirmed send stays queued and is sent again on reconnect.
				if (result.refusal === "StageNotLive") this.forget(entry.op);
				else entry.sent = false;
				waiter?.reject(new PooledStageDeliveryError(result.refusal, this.stageName));
				if (result.refusal !== "StageNotLive") return;
			}
			this.finishRebind(true);
		})().finally(() => {
			this.pumping = undefined;
		});
	}

	private async sendEntry(
		entry: OutboundEntry,
		watch: WatchId,
	): Promise<
		| { readonly ok: true; readonly action: StageUserMessageDeliveryAction | undefined }
		| { readonly ok: false; readonly refusal: DeliveryRefusal | ControlRefusal }
	> {
		if (entry.resume && !entry.resend) {
			const result = await this.transport.resume(watch, { op: entry.op, text: entry.text });
			return result.ok ? { ok: true, action: result.action } : result;
		}
		// The original mode: a steer joins the replacement's turn, a follow-up waits for its end.
		return this.transport.deliver({
			watch,
			op: entry.op,
			text: entry.text,
			intent: entry.intent,
			...(entry.options === undefined ? {} : { options: entry.options }),
		});
	}

	/** Ends a rebind: the outbound queue drained (`drained`), or the replacement's watch ended first. */
	private finishRebind(drained: boolean): void {
		const rebinding = this.rebinding;
		if (rebinding === undefined) return;
		this.rebinding = undefined;
		if (
			drained &&
			rebinding.watch === this.watchId &&
			!this.disposed &&
			this.ended === undefined &&
			this.outbound.every((entry) => entry.sent)
		) {
			this.reconnecting = false;
			this.redelivered = rebinding.redelivered;
			for (const listener of [...this.rebindListeners]) listener(rebinding.redelivered);
		}
		rebinding.done(rebinding.redelivered);
	}

	private adopt(snapshot: PooledStageChatSnapshot): void {
		this.session = snapshot.sessionId;
		this.settled = [...snapshot.messages];
		this.streaming = snapshot.streamingMessage;
		this.currentStatus = snapshot.status;
		this.streamingNow = snapshot.isStreaming;
		this.seq = snapshot.seq;
		this.toolExecutions = new StageToolExecutionBuffer();
		for (const event of snapshot.pendingToolExecutionEvents) this.toolExecutions.record(event);
		this.queued = new StageQueuedUserMessageBuffer();
		this.queued.record({
			type: "queue_update",
			steering: [...snapshot.queued.steering],
			followUp: [...snapshot.queued.followUp],
		} as AgentSessionEvent);
	}

	private apply(event: AgentSessionEvent): void {
		this.applyEvent(event);
		if (this.streamingNow && this.rebinding?.awaitingTurn === true) {
			this.rebinding.awaitingTurn = false;
			this.pump();
		}
	}

	private applyEvent(event: AgentSessionEvent): void {
		this.toolExecutions.record(event);
		this.queued.record(event);
		switch (event.type) {
			case "agent_start":
				// A turn only starts on a running stage, including one resumed after it paused.
				this.streamingNow = true;
				this.currentStatus = "running";
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
	let closed = false;
	handle = new PooledStageHandle(
		ref.runId,
		ref.stageId,
		stageName,
		watch.id,
		watch.snapshot,
		watch.attempt,
		(id) => {
			void transport.unwatch(id);
			if (handle?.isDisposed === true && !closed) {
				closed = true;
				onClose();
			}
		},
		transport,
	);
	for (const message of early.splice(0)) handle.receive(message);
	return { ok: true, handle };
}

/**
 * Reopens a reconnecting handle on its stage's current attempt through `transport`.
 * Resolves false while no attempt runs the stage yet; the caller retries on later activity.
 */
export async function reconnectPooledStageHandle(
	handle: PooledStageHandle,
	transport: PooledStageTransport,
): Promise<boolean> {
	if (!handle.isReconnecting || handle.isDisposed) return false;
	let bound = false;
	const early: PooledStageWatchMessage[] = [];
	const result = await transport.watch({ runId: handle.runId, stageId: handle.stageId }, (message) => {
		if (bound) handle.receive(message);
		else early.push(message);
	});
	if (!result.ok) return false;
	if (handle.isDisposed) {
		await transport.unwatch(result.watch.id);
		return false;
	}
	const rebinding = handle.rebind(result.watch);
	bound = true;
	for (const message of early.splice(0)) handle.receive(message);
	await rebinding;
	// A watch that ended during the rebind leaves the handle reconnecting for the next attempt.
	return !handle.isReconnecting;
}
