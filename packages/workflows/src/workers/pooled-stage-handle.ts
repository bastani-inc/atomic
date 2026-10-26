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

/** A delivery made through this handle, kept until a reconnected attempt's session shows it arrived. */
interface OutboundEntry {
	readonly op: DeliveryOpId;
	readonly text: string;
	/** How the text was sent; a redelivery keeps it, so a steer still steers. */
	readonly intent: DeliveryIntent;
	readonly options?: PooledStageDelivery["options"];
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
	/** Set while a rebind waits for the replacement attempt to start its own turn. */
	private whenStarted?: () => void;

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
			this.started();
			if (RECONNECTABLE.has(message.reason) && !this.disposed) this.reconnecting = true;
			else this.ended ??= message.reason;
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
	 * Binds the handle to a watch of the replacement attempt, then redelivers in send order
	 * every message whose op the replacement's session does not hold. Returns how many.
	 */
	async rebind(watch: PooledStageWatch): Promise<number> {
		const previous = this.watchId;
		this.watchId = watch.id;
		this.attempt = watch.attempt;
		this.adopt(watch.snapshot);
		// Still `reconnecting` until redelivery is done, so the chat shows it for the whole rebind.
		if (previous !== watch.id) this.close(previous);
		const present = new Set(watch.snapshot.deliveredOps ?? []);
		const outstanding = this.outbound.filter((entry) => !present.has(entry.op));
		this.outbound.splice(0, this.outbound.length, ...outstanding);
		// The replay sends the stage's own prompt first; redelivered text joins its turn, as it did.
		// The replay's session may already hold earlier messages, so only a streaming turn counts.
		if (outstanding.length > 0 && !this.streamingNow) {
			const started = Promise.withResolvers<void>();
			this.whenStarted = started.resolve;
			await started.promise;
			if (this.disposed || this.watchId !== watch.id || !this.streamingNow) return 0;
		}
		if (this.watchId !== watch.id) return 0;
		let redelivered = 0;
		for (const entry of outstanding) {
			// The original mode: a steer joins the replacement's turn, a follow-up waits for its end.
			const result = await this.transport.deliver({
				watch: this.watchId,
				op: entry.op,
				text: entry.text,
				intent: entry.intent,
				...(entry.options === undefined ? {} : { options: entry.options }),
			});
			if (result.ok) redelivered++;
			else if (result.refusal === "StageNotLive") this.forget(entry.op);
			else break;
		}
		if (this.watchId !== watch.id) return redelivered;
		this.reconnecting = false;
		this.redelivered = redelivered;
		for (const listener of [...this.rebindListeners]) listener(redelivered);
		return redelivered;
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
		const entry =
			message === undefined || message.trim().length === 0 ? undefined : this.record(message, undefined, "auto");
		beforeResume?.();
		const result = await this.transport.resume(
			this.watchId,
			entry === undefined ? undefined : { op: entry.op, text: entry.text },
		);
		if (!result.ok) {
			if (entry !== undefined && result.refusal !== "StaleAttempt") this.forget(entry.op);
			throw new PooledStageDeliveryError(result.refusal, this.stageName);
		}
		this.currentStatus = "running";
		return result.action;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.started();
		this.listeners.clear();
		this.rebindListeners.clear();
		this.close(this.watchId);
	}

	private throwIfClosed(): void {
		if (this.disposed) throw new Error(`Stage chat "${this.stageName}" is closed.`);
	}

	private record(text: string, options: PooledStageDelivery["options"], intent: DeliveryIntent): OutboundEntry {
		const entry = {
			op: randomUUID() as DeliveryOpId,
			text,
			intent,
			...(options === undefined ? {} : { options }),
		};
		this.outbound.push(entry);
		return entry;
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
		const entry = this.record(
			text,
			options?.expandPromptTemplates === undefined
				? undefined
				: { expandPromptTemplates: options.expandPromptTemplates },
			intent,
		);
		const result = await this.transport.deliver({
			watch: this.watchId,
			op: entry.op,
			text,
			intent,
			...(entry.options === undefined ? {} : { options: entry.options }),
		});
		if (!result.ok) {
			// A stale or unconfirmed delivery stays in the ledger and is redelivered on reconnect.
			if (result.refusal === "StageNotLive") this.forget(entry.op);
			throw new PooledStageDeliveryError(result.refusal, this.stageName);
		}
		return result.action;
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
		if (this.streamingNow) this.started();
	}

	/** Releases a rebind waiting for the replacement's turn; it then checks why it woke. */
	private started(): void {
		const resolve = this.whenStarted;
		this.whenStarted = undefined;
		resolve?.();
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
