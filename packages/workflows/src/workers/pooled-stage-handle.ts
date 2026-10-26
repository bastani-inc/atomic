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
import { tracePooledWatch } from "./pooled-watch-trace.js";
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

/** Mirrors the worker's `DELIVERY_RECEIPT_EVENT`, without loading worker code in the root. */
const DELIVERY_RECEIPT_EVENT = "atomic_pooled_delivery_receipt";

/** Watch ends after which the stage may continue on another attempt; the handle reconnects. */
const RECONNECTABLE = new Set<WatchEndReason>(["attempt_fenced", "worker_exited", "resync"]);

/** Events that show a stage's turn is under way, even when the turn started before the watch. */
const TURN_EVENTS = new Set(["agent_start", "turn_start", "tool_execution_start", "tool_execution_update"]);

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
 * User text sent to one pooled stage, kept in send order until the stage's session holds its
 * receipt or the stage ends. A pool keeps one outbox per stage, so text survives a chat that
 * detaches and reopens, and a worker that dies, until it is delivered or reported undelivered.
 */
export interface OutboundEntry {
	readonly op: DeliveryOpId;
	readonly text: string;
	/** How the text was sent; a redelivery keeps it, so a steer still steers. */
	readonly intent: DeliveryIntent;
	readonly options?: PooledStageDelivery["options"];
	/** Sent as a resume message rather than a delivery, the first time. */
	readonly resume: boolean;
	/** The attempt generation that admitted it; undefined until one has. */
	admittedBy?: number;
	/** The attempt generation whose send failed; that attempt is not asked again. */
	failedOn?: number;
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
 * `agentSession`; user text goes through the pool's single delivery door, in send order,
 * from the stage's outbox.
 *
 * Whenever it binds to an attempt (on open, and after the worker dies or its attempt is
 * fenced), it sends every outbox entry that attempt has not admitted and whose receipt the
 * attempt's session does not hold, in its original mode. Until that is done after a
 * reconnect it reads as reconnecting.
 */
export class PooledStageHandle implements StageControlHandle {
	readonly sessionFile = undefined;
	private readonly listeners = new Set<AgentSessionEventListener>();
	private readonly rebindListeners = new Set<(redelivered: number) => void>();
	private readonly drainedListeners = new Set<() => void>();
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
	private undelivered?: number;
	private disposed = false;
	private session: string | undefined;
	/** The outbox's sender while it runs; one at a time keeps send order. */
	private pumping?: Promise<void>;
	/** Something to send arrived while the sender ran. */
	private pumpAgain = false;
	/** Settles when the current watch ends or is replaced: a send to it stops waiting then. */
	private watchGone = Promise.withResolvers<void>();
	/** Redelivery waits for the attempt's own first turn, so the replay's prompt comes first. */
	private awaitingTurn = false;
	/** A rebind in flight: the handle reads as reconnecting until the outbox drains. */
	private rebinding?: { readonly watch: WatchId; redelivered: number; readonly done: (redelivered: number) => void };

	constructor(
		readonly runId: string,
		readonly stageId: string,
		readonly stageName: string,
		private watchId: WatchId,
		snapshot: PooledStageChatSnapshot,
		attempt: { readonly workId: string; readonly generation: number },
		private readonly close: (watch: WatchId) => void,
		private readonly transport: Pick<PooledStageTransport, "deliver" | "pause" | "resume">,
		private readonly outbound: OutboundEntry[] = [],
	) {
		this.attempt = attempt;
		this.adopt(snapshot);
		this.reconcile(snapshot);
		this.pump();
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
			...(this.undeliveredCount() === 0 ? {} : { undelivered: this.undeliveredCount() }),
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
	/** True between the end of a watch on a fenced attempt and the end of its rebind. */
	get isReconnecting(): boolean {
		return this.reconnecting;
	}
	/** Whether text in the outbox still waits for this attempt, or the handle is reconnecting. */
	get hasPending(): boolean {
		return (
			this.reconnecting ||
			this.outbound.some((entry) => !this.admitted(entry) && entry.failedOn !== this.attempt.generation)
		);
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
	/**
	 * The stage's queues as the attempt reports them, plus outbox text the current attempt has not
	 * admitted (sent while reconnecting, or waiting behind a redelivery), so a chat shows every
	 * message that has not arrived, including in a view reopened mid-reconnect.
	 */
	queuedUserMessages() {
		const queued = this.queued.snapshot();
		// After the end nothing is pending: the header counts what never arrived.
		if (this.ended !== undefined) return queued;
		// Between attempts, nothing in the outbox is known to have arrived.
		const waiting = this.reconnecting ? this.outbound : this.outbound.filter((entry) => !this.admitted(entry));
		if (waiting.length === 0) return queued;
		const steering = [...queued.steering];
		const followUp = [...queued.followUp];
		for (const entry of waiting) {
			const queue = entry.intent === "steer" ? steering : followUp;
			if (!queue.includes(entry.text)) queue.push(entry.text);
		}
		return { steering, followUp };
	}

	/** Observes rebinding to a replacement attempt, with the number of messages redelivered. */
	onRebind(listener: (redelivered: number) => void): () => void {
		this.rebindListeners.add(listener);
		return () => {
			this.rebindListeners.delete(listener);
		};
	}

	/** Observes the outbox draining while the handle is live: nothing waits for this attempt. */
	onDrained(listener: () => void): () => void {
		this.drainedListeners.add(listener);
		return () => {
			this.drainedListeners.delete(listener);
		};
	}

	/** Applies one message of the watch stream. */
	receive(message: PooledStageWatchMessage): void {
		if (message.kind === "ended") {
			this.leaveWatch();
			this.streamingNow = false;
			if (RECONNECTABLE.has(message.reason) && !this.disposed && this.ended === undefined) this.reconnecting = true;
			else this.end(message.reason);
			// A rebind cut short by this end leaves the rest for the next attempt.
			this.finishRebind(false);
			return;
		}
		for (const { seq, event } of message.events) {
			if (seq <= this.seq) continue;
			this.seq = seq;
			if (!this.apply(event)) continue;
			for (const listener of [...this.listeners]) listener(event);
		}
	}

	/**
	 * Binds the handle to a watch of the replacement attempt, then sends from the outbox, in send
	 * order and each in its original mode, what that attempt has not admitted and its session
	 * holds no receipt for. The handle reads as reconnecting until that is done.
	 */
	rebind(watch: PooledStageWatch): Promise<number> {
		const previous = this.watchId;
		this.leaveWatch();
		this.finishRebind(false);
		this.watchId = watch.id;
		this.attempt = watch.attempt;
		this.adopt(watch.snapshot);
		if (previous !== watch.id) this.close(previous);
		const done = Promise.withResolvers<number>();
		this.rebinding = { watch: watch.id, redelivered: 0, done: done.resolve };
		this.reconnecting = true;
		this.reconcile(watch.snapshot);
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
	 * `beforeDelivery` runs here, immediately before the text is queued for the worker.
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

	/**
	 * Closes this view's watch. The outbox it shares with the pool keeps any text that has not
	 * arrived, for the stage's next view.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.leaveWatch();
		for (const entry of this.outbound) {
			entry.waiter?.reject(new Error(`Stage chat "${this.stageName}" is closed.`));
			entry.waiter = undefined;
		}
		this.finishRebind(false);
		this.listeners.clear();
		this.rebindListeners.clear();
		this.drainedListeners.clear();
		this.close(this.watchId);
	}

	/** Releases sends waiting on the current watch; the next watch gets a fresh signal. */
	private leaveWatch(): void {
		this.watchGone.resolve();
		this.watchGone = Promise.withResolvers<void>();
	}

	private throwIfClosed(): void {
		if (this.disposed) throw new Error(`Stage chat "${this.stageName}" is closed.`);
	}

	/** Text that never reached the stage (ended), or whose send this attempt refused (live). */
	private undeliveredCount(): number {
		if (this.undelivered !== undefined) return this.undelivered;
		return this.outbound.filter((entry) => entry.failedOn === this.attempt.generation).length;
	}

	private admitted(entry: OutboundEntry): boolean {
		return entry.admittedBy === this.attempt.generation;
	}

	/** Drops entries the attempt's session holds receipts for; the rest wait for this attempt. */
	private reconcile(snapshot: PooledStageChatSnapshot): void {
		const present = new Set(snapshot.deliveredOps ?? []);
		for (const entry of [...this.outbound]) if (present.has(entry.op)) this.forget(entry.op);
		// The replay sends the stage's own prompt first; redelivered text follows it.
		this.awaitingTurn =
			snapshot.turnStarted !== true &&
			!this.streamingNow &&
			this.outbound.some((entry) => entry.admittedBy !== undefined && !this.admitted(entry));
		tracePooledWatch("root.handle.reconcile", {
			stage: this.stageId,
			watch: this.watchId,
			generation: this.attempt.generation,
			turnStarted: snapshot.turnStarted,
			streaming: this.streamingNow,
			awaitingTurn: this.awaitingTurn,
			deliveredOps: [...present],
			outbox: this.outbound.map(
				(entry) => `${entry.op}:${entry.intent}:${entry.admittedBy ?? "-"}:${entry.failedOn ?? "-"}`,
			),
		});
	}

	/** Ends the handle for good: nothing reconnects, and text that never arrived is reported. */
	private end(reason: WatchEndReason): void {
		// Receipts prune the outbox as text arrives, so whatever is left never reached the stage.
		this.ended ??= reason;
		this.reconnecting = false;
		const undelivered = this.outbound.length;
		// Nothing runs any more: no reply streams, no tool is still running, nothing is queued. The
		// header reports what never arrived.
		this.queued = new StageQueuedUserMessageBuffer();
		this.toolExecutions = new StageToolExecutionBuffer();
		this.streaming = undefined;
		this.streamingNow = false;
		if (undelivered > 0) this.undelivered = undelivered;
		for (const entry of this.outbound) {
			if (this.admitted(entry)) continue;
			entry.waiter?.reject(new PooledStageDeliveryError("StageNotLive", this.stageName));
			entry.waiter = undefined;
		}
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
		if (this.ended !== undefined) return Promise.reject(new PooledStageDeliveryError("StageNotLive", this.stageName));
		const outcome = Promise.withResolvers<StageUserMessageDeliveryAction | undefined>();
		const entry: OutboundEntry = {
			op: randomUUID() as DeliveryOpId,
			text,
			intent,
			...(options === undefined ? {} : { options }),
			resume,
			waiter: { resolve: outcome.resolve, reject: outcome.reject },
		};
		this.outbound.push(entry);
		// While the watch's attempt is gone the text waits for the replacement; say so now.
		if (this.reconnecting && this.rebinding === undefined) {
			entry.waiter = undefined;
			outcome.reject(new PooledStageDeliveryError("StaleAttempt", this.stageName));
		}
		this.pump();
		return outcome.promise;
	}

	/** Sends outbox text this attempt has not admitted, in order, one message at a time. */
	private pump(): void {
		// A send queued while the sender is finishing must not be missed: run again after it.
		if (this.pumping !== undefined) {
			this.pumpAgain = true;
			return;
		}
		this.pumpAgain = false;
		this.pumping = (async () => {
			for (;;) {
				if (this.disposed || this.ended !== undefined || (this.reconnecting && this.rebinding === undefined))
					return;
				const entry = this.outbound.find(
					(candidate) => !this.admitted(candidate) && candidate.failedOn !== this.attempt.generation,
				);
				if (entry === undefined) break;
				// The first new send also waits behind the replay's own prompt, keeping send order.
				if (this.awaitingTurn) {
					tracePooledWatch("root.outbox.awaiting-turn", { stage: this.stageId, watch: this.watchId });
					return;
				}
				const watch = this.watchId;
				const generation = this.attempt.generation;
				const redelivery = entry.admittedBy !== undefined;
				tracePooledWatch("root.outbox.send", { op: entry.op, watch, generation, intent: entry.intent, redelivery });
				let result: Awaited<ReturnType<PooledStageHandle["sendEntry"]>>;
				try {
					// A send whose watch ended or was replaced is sent again to the next one, by its op.
					const gone = this.watchGone.promise.then(
						(): Awaited<ReturnType<PooledStageHandle["sendEntry"]>> => ({ ok: false, refusal: "StaleAttempt" }),
					);
					result = await Promise.race([this.sendEntry(entry, watch), gone]);
				} catch (error) {
					// The stage refused it, or the outcome is unknown. Either way the caller hears now,
					// and the next attempt gets it again, deduplicated by its op.
					entry.failedOn = generation;
					entry.waiter?.reject(error instanceof Error ? error : new Error(String(error)));
					entry.waiter = undefined;
					continue;
				}
				tracePooledWatch("root.outbox.settled", {
					op: entry.op,
					watch,
					ok: result.ok,
					action: result.ok ? result.action : undefined,
					refusal: result.ok ? undefined : result.refusal,
				});
				const waiter = entry.waiter;
				entry.waiter = undefined;
				if (result.ok) {
					entry.admittedBy = generation;
					// `handled`: the attempt's session already held it, so nothing was sent again.
					if (redelivery && result.action !== "handled" && this.rebinding?.watch === watch)
						this.rebinding.redelivered++;
					waiter?.resolve(result.action);
					continue;
				}
				// A stale or unconfirmed send stays in the outbox and is sent again on reconnect.
				if (result.refusal === "StageNotLive") this.forget(entry.op);
				waiter?.reject(new PooledStageDeliveryError(result.refusal, this.stageName));
				if (result.refusal !== "StageNotLive") return;
			}
			this.finishRebind(true);
			for (const listener of [...this.drainedListeners]) listener();
		})()
			// A send's failure reaches its caller above; nothing here may reject unhandled.
			.catch(() => {})
			.finally(() => {
				this.pumping = undefined;
				if (this.pumpAgain) this.pump();
			});
	}

	private async sendEntry(
		entry: OutboundEntry,
		watch: WatchId,
	): Promise<
		| { readonly ok: true; readonly action: StageUserMessageDeliveryAction | undefined }
		| { readonly ok: false; readonly refusal: DeliveryRefusal | ControlRefusal }
	> {
		if (entry.resume && entry.admittedBy === undefined) {
			const result = await this.transport.resume(watch, { op: entry.op, text: entry.text });
			return result.ok ? { ok: true, action: result.action } : result;
		}
		// The original mode: a steer joins the attempt's turn, a follow-up waits for its end.
		return this.transport.deliver({
			watch,
			op: entry.op,
			text: entry.text,
			intent: entry.intent,
			...(entry.options === undefined ? {} : { options: entry.options }),
		});
	}

	/** Ends a rebind: the outbox drained (`drained`), or the replacement's watch ended first. */
	private finishRebind(drained: boolean): void {
		const rebinding = this.rebinding;
		if (rebinding === undefined) return;
		this.rebinding = undefined;
		tracePooledWatch("root.handle.rebind-finished", {
			stage: this.stageId,
			drained,
			sameWatch: rebinding.watch === this.watchId,
			redelivered: rebinding.redelivered,
		});
		if (drained && rebinding.watch === this.watchId && !this.disposed && this.ended === undefined) {
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

	private apply(event: AgentSessionEvent): boolean {
		if ((event.type as string) === DELIVERY_RECEIPT_EVENT) {
			this.forget((event as never as { readonly op: DeliveryOpId }).op);
			return false;
		}
		this.applyEvent(event);
		const turnUnderway =
			TURN_EVENTS.has(event.type) ||
			((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant");
		if (turnUnderway && this.awaitingTurn) {
			tracePooledWatch("root.handle.turn-released", { stage: this.stageId, event: event.type });
			this.awaitingTurn = false;
			this.pump();
		}
		return true;
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

/** Opens a watch through `transport` and returns the handle that mirrors it, sharing `outbound`. */
export async function openPooledStageHandle(
	transport: PooledStageTransport,
	ref: PooledStageRef,
	stageName: string,
	onClose: () => void = () => {},
	outbound: OutboundEntry[] = [],
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
		outbound,
	);
	for (const message of early.splice(0)) handle.receive(message);
	return { ok: true, handle };
}

/**
 * Reopens a reconnecting handle on its stage's current attempt through `transport`.
 * Resolves false while no attempt runs the stage yet, or when the attempt's watch ended again
 * before the rebind finished; the caller retries on later activity.
 */
export async function reconnectPooledStageHandle(
	handle: PooledStageHandle,
	transport: PooledStageTransport,
	wanted: () => boolean = () => true,
): Promise<boolean> {
	if (!handle.isReconnecting || handle.isDisposed) return false;
	let bound = false;
	const early: PooledStageWatchMessage[] = [];
	const result = await transport.watch({ runId: handle.runId, stageId: handle.stageId }, (message) => {
		if (bound) handle.receive(message);
		else early.push(message);
	});
	if (!result.ok) return false;
	// A view that gave up on this attempt, or closed, does not bind a watch that opened late.
	if (handle.isDisposed || !wanted()) {
		await transport.unwatch(result.watch.id);
		return false;
	}
	const rebinding = handle.rebind(result.watch);
	bound = true;
	for (const message of early.splice(0)) handle.receive(message);
	await rebinding;
	return !handle.isReconnecting;
}
