import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import type {
	AgentSessionEventListener,
	StageControlHandle,
	StageControlRegistry,
	StageControlStatus,
	StagePlacement,
} from "../runs/foreground/stage-control-registry.js";
import {
	EMPTY_STAGE_QUEUED_USER_MESSAGES,
	type StageQueuedUserMessages,
} from "../runs/foreground/stage-queued-user-messages.js";
import type { StageUserMessageDeliveryAction } from "../runs/foreground/stage-runner-types.js";
import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { StageSendUserMessageOptions } from "../shared/types.js";
import type { PooledStageLease } from "./pooled-stage-sources.js";

type Acquire = (runId: string, stageId: string) => Promise<PooledStageLease | undefined>;

const LIVE = new Set<StageSnapshot["status"]>(["running", "awaiting_input", "paused", "blocked"]);

/**
 * A caller-registry handle of a stage on a local worker (#3996).
 *
 * It holds no watch of its own: a watch opens while something subscribes to it or a
 * message is on its way, and closes when nothing does, so registering every pooled stage
 * streams nothing until a caller uses one.
 */
export class RegisteredPooledStageHandle implements StageControlHandle {
	readonly sessionFile = undefined;
	private readonly listeners = new Set<AgentSessionEventListener>();
	private lease?: Promise<PooledStageLease | undefined>;
	private users = 0;
	private disposed = false;

	constructor(
		readonly runId: string,
		private stage: StageSnapshot,
		readonly placement: StagePlacement,
		private readonly acquire: Acquire,
	) {}

	get stageId(): string {
		return this.stage.id;
	}
	get stageName(): string {
		return this.stage.name;
	}
	get sessionId(): string | undefined {
		return this.stage.sessionId;
	}
	get status(): StageControlStatus {
		return this.stage.status;
	}
	get isDisposed(): boolean {
		return this.disposed;
	}
	get isStreaming(): boolean {
		return this.current()?.isStreaming ?? false;
	}
	get messages(): AgentSession["messages"] {
		return this.current()?.messages ?? [];
	}
	queuedUserMessages(): StageQueuedUserMessages {
		return this.current()?.queuedUserMessages?.() ?? EMPTY_STAGE_QUEUED_USER_MESSAGES;
	}
	streamingMessage(): ReturnType<NonNullable<StageControlHandle["streamingMessage"]>> {
		return this.current()?.streamingMessage?.();
	}
	pendingToolExecutionEvents(): readonly AgentSessionEvent[] {
		return this.current()?.pendingToolExecutionEvents?.() ?? [];
	}

	/** Keeps the published stage current. */
	update(stage: StageSnapshot): void {
		this.stage = stage;
	}

	async ensureAttached(): Promise<void> {
		await this.use(async () => {});
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.add(listener);
		this.users++;
		const opening = this.open();
		let subscribed = true;
		let unsubscribe: (() => void) | undefined;
		void opening.then((lease) => {
			if (subscribed) unsubscribe = lease?.handle.subscribe((event) => this.emit(listener, event));
		});
		return () => {
			if (!subscribed) return;
			subscribed = false;
			this.listeners.delete(listener);
			unsubscribe?.();
			this.done();
		};
	}

	sendUserMessage(
		text: string,
		options?: StageSendUserMessageOptions,
		beforeDelivery?: () => void,
	): Promise<StageUserMessageDeliveryAction> {
		return this.use((handle) => {
			if (handle.sendUserMessage === undefined) throw new Error(`Stage "${this.stageName}" cannot take messages`);
			return handle.sendUserMessage(text, options, beforeDelivery);
		});
	}
	async prompt(text: string): Promise<void> {
		await this.use((handle) => handle.prompt(text));
	}
	async steer(text: string): Promise<void> {
		await this.use((handle) => handle.steer(text));
	}
	async followUp(text: string): Promise<void> {
		await this.use((handle) => handle.followUp(text));
	}
	async pause(): Promise<void> {
		await this.use((handle) => handle.pause());
	}
	async resume(): Promise<undefined> {
		await this.use((handle) => handle.resume());
		return undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		this.users = 0;
		this.release();
	}

	private emit(listener: AgentSessionEventListener, event: AgentSessionEvent): void {
		if (this.listeners.has(listener)) listener(event);
	}

	private current(): StageControlHandle | undefined {
		return this.settled;
	}
	private settled?: StageControlHandle;

	private open(): Promise<PooledStageLease | undefined> {
		if (this.lease === undefined) {
			const opening = this.acquire(this.runId, this.stage.id);
			this.lease = opening;
			void opening.then((lease) => {
				if (this.lease !== opening) lease?.release();
				else this.settled = lease?.handle;
			});
		}
		return this.lease;
	}

	private async use<T>(action: (handle: StageControlHandle) => Promise<T>): Promise<T> {
		if (this.disposed) throw new Error(`Stage "${this.stageName}" is no longer running on a local worker`);
		this.users++;
		try {
			const lease = await this.open();
			if (lease === undefined) throw new Error(`Stage "${this.stageName}" is not running on a local worker`);
			return await action(lease.handle);
		} finally {
			this.done();
		}
	}

	private done(): void {
		if (--this.users <= 0) {
			this.users = 0;
			this.release();
		}
	}

	private release(): void {
		const lease = this.lease;
		this.lease = undefined;
		this.settled = undefined;
		void lease?.then((opened) => opened?.release());
	}
}

/** Keeps a caller's stage-control registry holding one handle per live stage of a pool's runs. */
export class PooledStageRegistrations {
	private readonly entries = new Map<string, { readonly handle: RegisteredPooledStageHandle; unregister(): void }>();

	constructor(
		private readonly registry: StageControlRegistry,
		private readonly acquire: Acquire,
	) {}

	sync(work: { readonly id: string; readonly generation: number }, runs: readonly RunSnapshot[]): void {
		for (const run of runs)
			for (const stage of run.stages) {
				const key = JSON.stringify([run.id, stage.id]);
				const entry = this.entries.get(key);
				if (!LIVE.has(stage.status) || stage.sessionId === undefined) {
					if (entry !== undefined && !LIVE.has(stage.status)) this.remove(key);
					continue;
				}
				if (entry !== undefined && entry.handle.placement.generation === work.generation) {
					entry.handle.update(stage);
					continue;
				}
				if (entry !== undefined) this.remove(key);
				const handle = new RegisteredPooledStageHandle(
					run.id,
					stage,
					{ kind: "local-worker", workId: work.id, generation: work.generation },
					this.acquire,
				);
				const unregister = this.registry.register(handle);
				// Run-level pause and resume of a pooled run stay pool-wide.
				this.registry.detachControl(run.id, stage.id, handle);
				this.entries.set(key, { handle, unregister });
			}
	}

	/** Removes the handles of a finished or fenced attempt's stages. */
	forget(workId: string): void {
		for (const [key, entry] of [...this.entries]) if (entry.handle.placement.workId === workId) this.remove(key);
	}

	clear(): void {
		for (const key of [...this.entries.keys()]) this.remove(key);
	}

	private remove(key: string): void {
		const entry = this.entries.get(key);
		if (entry === undefined) return;
		this.entries.delete(key);
		entry.unregister();
		entry.handle.dispose();
	}
}
