import type { AgentSessionEvent, SessionEntry } from "@bastani/atomic";
import type { StageControlHandle, StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { EMPTY_STAGE_QUEUED_USER_MESSAGES } from "../runs/foreground/stage-queued-user-messages.js";
import type { DistributiveOmit, WorkerRequest, WorkerStageCommand } from "./protocol.js";
import { appendCoalesced } from "./stage-watch-coalesce.js";
import type {
	AttemptRef,
	DeliveryIntent,
	DeliveryOpId,
	DeliveryRefusal,
	PooledStageChatSnapshot,
	SeqEvent,
	WatchId,
} from "./stage-watch-types.js";

type StageCommandResult = Omit<Extract<Outbound, { kind: "stage-command-result" }>, "id" | "kind" | "commandId">;

/**
 * The one way user text from the root enters a pooled stage's session (#3996): through the
 * stage's own idle-aware delivery, so it reports the same action an in-process stage does.
 */
export async function admitStageUserMessage(
	handle: StageControlHandle,
	text: string,
	intent: DeliveryIntent,
	expandPromptTemplates: boolean | undefined,
): Promise<StageCommandResult> {
	const options = {
		...(intent === "auto" ? {} : { deliverAs: intent }),
		...(expandPromptTemplates === undefined ? {} : { expandPromptTemplates }),
	};
	if (handle.sendUserMessage !== undefined) return { action: await handle.sendUserMessage(text, options) };
	if (intent === "steer" && handle.isStreaming) {
		await handle.steer(text);
		return { action: "steer" };
	}
	if (intent !== "steer" && handle.isStreaming) {
		await handle.followUp(text);
		return { action: "followUp" };
	}
	await handle.prompt(text);
	return { action: "prompt" };
}

/**
 * Custom session entry recording that a delivery op's text entered the session. It is not
 * part of the model's context; a reconnecting handle reads it to redeliver only what a
 * replacement attempt does not hold (#3996).
 */
export const DELIVERY_OP_ENTRY = "atomic-pooled-delivery-op";

/** A watched stage's events leave the worker at most this often, as one batch. */
export const STAGE_EVENT_BATCH_INTERVAL_MS = 50;

const TERMINAL = new Set(["completed", "failed", "skipped"]);

type Outbound = Extract<WorkerRequest, { kind: "stage-command-result" | "stage-events" | "stage-watch-ended" }>;

interface Watch {
	readonly handle: StageControlHandle;
	readonly unsubscribe: () => void;
	readonly batch: SeqEvent[];
	seq: number;
	timer?: NodeJS.Timeout;
}

function isTerminal(handle: StageControlHandle): boolean {
	return handle.isDisposed === true || TERMINAL.has(handle.status);
}

/**
 * The worker's airlock for stage watches (#3996).
 *
 * It is the one place that checks a stage command against the attempt this worker actually
 * holds and the stage's live status before it touches the real stage handle. A stage is
 * subscribed only while a watch is open, so a stage nobody watches sends no session events.
 */
export class WorkerStageWatches {
	private readonly watches = new Map<WatchId, Watch>();
	/** Deliveries of the current attempt by op, so a retried op is admitted at most once. */
	private readonly ledger = new Map<DeliveryOpId, Promise<StageCommandResult>>();

	constructor(
		private readonly registry: StageControlRegistry,
		private readonly attempt: () => AttemptRef | undefined,
		private readonly send: (message: DistributiveOmit<Outbound, "id">) => void,
		/** Pool-wide control as the worker last observed it. */
		private readonly control: () => string = () => "running",
	) {}

	serve(command: WorkerStageCommand): void {
		if (command.op === "unwatch") {
			this.close(command.watch);
			this.send({ kind: "stage-command-result", commandId: command.commandId });
			return;
		}
		if (command.op === "deliver" || command.op === "pause" || command.op === "resume") {
			const result =
				command.op === "deliver"
					? this.deliver(command)
					: command.op === "pause"
						? this.pause(command)
						: this.resume(command);
			void result.then((outcome) =>
				this.send({ kind: "stage-command-result", commandId: command.commandId, ...outcome }),
			);
			return;
		}
		const held = this.attempt();
		if (held?.workId !== command.attempt.workId || held.generation !== command.attempt.generation) {
			this.send({ kind: "stage-command-result", commandId: command.commandId, refusal: "AttemptChanging" });
			return;
		}
		const handle = this.registry.get(command.runId, command.stageId);
		if (handle === undefined || isTerminal(handle)) {
			this.send({ kind: "stage-command-result", commandId: command.commandId, refusal: "StageNotOnWorker" });
			return;
		}
		this.close(command.watch);
		const batch: SeqEvent[] = [];
		const watch: Watch = {
			handle,
			batch,
			seq: 0,
			// Subscribed before the snapshot is taken: nothing between them can be missed.
			unsubscribe: handle.subscribe((event) => this.record(command.watch, event)),
		};
		this.watches.set(command.watch, watch);
		this.send({ kind: "stage-command-result", commandId: command.commandId, snapshot: snapshot(handle, watch.seq) });
	}

	/** Ends watches whose stage finished; called on the worker heartbeat. */
	sweep(): void {
		for (const [id, watch] of this.watches)
			if (isTerminal(watch.handle)) {
				this.flush(id);
				this.close(id);
				this.send({ kind: "stage-watch-ended", watch: id, reason: "stage_finished" });
			}
	}

	/** Ends every watch when the attempt ends; the coordinator tells the root. */
	clear(): void {
		this.ledger.clear();
		for (const id of [...this.watches.keys()]) {
			this.flush(id);
			this.close(id);
		}
	}

	/** The watched handle when the command is for the attempt this worker holds; otherwise the refusal. */
	private airlock(command: { readonly attempt: AttemptRef; readonly watch: WatchId }): Watch | DeliveryRefusal {
		const held = this.attempt();
		const watch = this.watches.get(command.watch);
		if (held?.workId !== command.attempt.workId || held.generation !== command.attempt.generation || !watch)
			return "StaleAttempt";
		return isTerminal(watch.handle) ? "StageNotLive" : watch;
	}

	private async pause(command: Extract<WorkerStageCommand, { op: "pause" }>): Promise<StageCommandResult> {
		const watch = this.airlock(command);
		if (typeof watch === "string") return { refusal: watch };
		if (this.control() !== "running") return { refusal: "PoolPausedOrQuitting" };
		try {
			await watch.handle.pause();
			return {};
		} catch (error) {
			return isTerminal(watch.handle) ? { refusal: "StageNotLive" } : { error: (error as Error).message };
		}
	}

	private async resume(command: Extract<WorkerStageCommand, { op: "resume" }>): Promise<StageCommandResult> {
		const watch = this.airlock(command);
		if (typeof watch === "string") return { refusal: watch };
		if (this.control() !== "running") return { refusal: "PoolPausedOrQuitting" };
		const message = command.message;
		// A retried resume whose message this attempt already admitted is answered from the ledger.
		const recorded = message === undefined ? undefined : this.ledger.get(message.deliveryOp);
		if (recorded !== undefined) return recorded;
		const unmark =
			message === undefined ? () => {} : this.markDelivered(watch.handle, message.deliveryOp, message.text);
		const resumed = (async (): Promise<StageCommandResult> => {
			const action = await watch.handle.resume(message?.text);
			return action === undefined ? {} : { action };
		})().catch((error: Error): StageCommandResult => {
			unmark();
			return isTerminal(watch.handle) ? { refusal: "StageNotLive" } : { error: error.message };
		});
		if (message !== undefined) this.ledger.set(message.deliveryOp, resumed);
		return resumed;
	}

	/**
	 * Records the op in the stage's session once its text enters the session as a user message,
	 * so a replacement attempt that replays the session knows the text arrived.
	 */
	private markDelivered(handle: StageControlHandle, op: DeliveryOpId, text: string): () => void {
		const sessionManager = handle.agentSession?.sessionManager;
		if (sessionManager === undefined) return () => {};
		const unsubscribe = handle.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			if (!messageText(event.message).includes(text)) return;
			unsubscribe();
			void sessionManager.appendCustomEntry(DELIVERY_OP_ENTRY, { op }).catch(() => {});
		});
		return unsubscribe;
	}

	private async deliver(command: Extract<WorkerStageCommand, { op: "deliver" }>): Promise<StageCommandResult> {
		const recorded = this.ledger.get(command.deliveryOp);
		if (recorded !== undefined) return recorded;
		const held = this.attempt();
		const watch = this.watches.get(command.watch);
		const refuse = (refusal: DeliveryRefusal): Promise<StageCommandResult> => Promise.resolve({ refusal });
		if (
			held?.workId !== command.attempt.workId ||
			held.generation !== command.attempt.generation ||
			watch === undefined
		)
			return refuse("StaleAttempt");
		if (isTerminal(watch.handle)) return refuse("StageNotLive");
		const unmark = this.markDelivered(watch.handle, command.deliveryOp, command.text);
		const admitted = admitStageUserMessage(
			watch.handle,
			command.text,
			command.intent,
			command.expandPromptTemplates,
		).catch((error: Error): StageCommandResult => {
			unmark();
			return isTerminal(watch.handle) ? { refusal: "StageNotLive" } : { error: error.message };
		});
		this.ledger.set(command.deliveryOp, admitted);
		return admitted;
	}

	private record(id: WatchId, event: AgentSessionEvent): void {
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		appendCoalesced(watch.batch, { seq: ++watch.seq, event });
		watch.timer ??= setTimeout(() => this.flush(id), STAGE_EVENT_BATCH_INTERVAL_MS);
	}

	private flush(id: WatchId): void {
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		clearTimeout(watch.timer);
		watch.timer = undefined;
		if (watch.batch.length === 0) return;
		const events = watch.batch.splice(0);
		this.send({ kind: "stage-events", watch: id, events });
	}

	private close(id: WatchId): void {
		const watch = this.watches.get(id);
		if (watch === undefined) return;
		this.watches.delete(id);
		clearTimeout(watch.timer);
		watch.unsubscribe();
	}
}

function messageText(message: object): string {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { readonly type?: string; readonly text?: string }) =>
			block.type === "text" ? (block.text ?? "") : "",
		)
		.join("");
}

function deliveredOps(entries: readonly SessionEntry[]): DeliveryOpId[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== DELIVERY_OP_ENTRY) return [];
		const op = (entry.data as { readonly op?: string } | undefined)?.op;
		return typeof op === "string" ? [op as DeliveryOpId] : [];
	});
}

function snapshot(handle: StageControlHandle, seq: number): PooledStageChatSnapshot {
	const streamingMessage = handle.agentSession?.agent?.state.streamingMessage;
	const entries = handle.agentSession?.sessionManager.getEntries();
	return {
		sessionId: handle.sessionId,
		status: handle.status,
		isStreaming: handle.isStreaming,
		messages: [...handle.messages],
		...(streamingMessage === undefined ? {} : { streamingMessage }),
		pendingToolExecutionEvents: [...(handle.pendingToolExecutionEvents?.() ?? [])],
		queued: handle.queuedUserMessages?.() ?? EMPTY_STAGE_QUEUED_USER_MESSAGES,
		...(entries === undefined ? {} : { deliveredOps: deliveredOps(entries) }),
		seq,
	};
}
