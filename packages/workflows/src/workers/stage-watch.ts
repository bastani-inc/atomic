import type { AgentSessionEvent, SessionEntry } from "@bastani/atomic";
import type { StageControlHandle, StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { EMPTY_STAGE_QUEUED_USER_MESSAGES } from "../runs/foreground/stage-queued-user-messages.js";
import { tracePooledWatch } from "./pooled-watch-trace.js";
import type { DistributiveOmit, WorkerRequest, WorkerStageCommand } from "./protocol.js";
import { StageDeliveryReceipts } from "./stage-delivery-receipts.js";
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
 *
 * It settles once the text is admitted. A steer or follow-up is admitted when it is queued;
 * a prompt to an idle stage is admitted when its user message starts the turn, not when the
 * turn ends, so a reply never waits on the model and the door stays free for the next text.
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
	// Only an idle stage starts a turn with this text; a streaming one queues it and says so.
	const startedTurn = Promise.withResolvers<StageCommandResult>();
	const unsubscribe = handle.isStreaming
		? () => {}
		: handle.subscribe((event) => {
				// The idle stage's next user message is this one, as sent or after template expansion.
				if (event.type === "message_start" && event.message.role === "user")
					startedTurn.resolve({ action: "prompt" });
			});
	// A busy session takes the text in its mode: a steer steers, anything else follows up. The text is
	// admitted once it is in the session's queue; the call that queued it may settle much later (a
	// replacement attempt's session still finishing its startup, say), and consumption is tracked by
	// the receipts, so admission never waits for the turn.
	const queuedIn: "steering" | "followUp" = intent === "steer" ? "steering" : "followUp";
	const queuedAction: StageCommandResult = { action: intent === "steer" ? "steer" : "followUp" };
	let stopQueueWatch = () => {};
	const queue = async (): Promise<StageCommandResult> => {
		const queued = Promise.withResolvers<StageCommandResult>();
		const before = handle.queuedUserMessages?.()[queuedIn].filter((entry) => entry === text).length ?? 0;
		stopQueueWatch = handle.subscribe((event) => {
			if (event.type !== "queue_update") return;
			const entries = (event as { readonly steering?: readonly string[]; readonly followUp?: readonly string[] })[
				queuedIn
			];
			if ((entries ?? []).filter((entry) => entry === text).length > before) queued.resolve(queuedAction);
		});
		// The stage queues into a turn its live session already runs directly, and arms its own
		// continuation for it (see the stage control handle).
		const direct = handle.agentSession?.isStreaming === true;
		const call = (async (): Promise<StageCommandResult> => {
			if (intent === "steer") await handle.steer(text);
			else await handle.followUp(text);
			return queuedAction;
		})();
		tracePooledWatch("worker.deliver.queueing", { intent, before, direct });
		const admitted = await Promise.race([call, queued.promise]);
		void call.then(
			() => tracePooledWatch("worker.deliver.queue-call-settled", { intent, ok: true }),
			(error: Error) =>
				tracePooledWatch("worker.deliver.queue-call-settled", { intent, ok: false, error: error.message }),
		);
		return admitted;
	};
	// A turn under way, whether or not the stage handle reports it (a replayed turn may not, and
	// holds the stage's message admission until it ends), takes the text in its mode directly:
	// through that admission a steer would wait for the whole turn instead of steering it.
	// So does the stage's own turn loop between two of its turns: its admission would hold the text
	// until the whole loop ends, after the stage's work instead of during it.
	const busy = turnUnderway(handle);
	const delivery = (async (): Promise<StageCommandResult> => {
		if (busy) return queue();
		try {
			if (handle.sendUserMessage !== undefined) return { action: await handle.sendUserMessage(text, options) };
			await handle.prompt(text);
			return { action: "prompt" };
		} catch (error) {
			// The session was busy after all (a replayed turn the stage handle did not report):
			// queue the text in its mode rather than prompt over the running turn.
			if (error instanceof Error && BUSY_SESSION.test(error.message)) return queue();
			throw error;
		}
	})();
	try {
		return await Promise.race([delivery, startedTurn.promise]);
	} finally {
		unsubscribe();
		stopQueueWatch();
		// A turn this delivery started reports its own failure through the stage; the door has answered.
		delivery.catch(() => {});
	}
}

/**
 * Custom session entry recording that a delivery op's text entered the session. It is not
 * part of the model's context; a reconnecting handle reads it to redeliver only what a
 * replacement attempt does not hold (#3996).
 */
export const DELIVERY_OP_ENTRY = "atomic-pooled-delivery-op";

/** Event a watch carries when a delivery op's text entered the stage's session (#3996). */
export const DELIVERY_RECEIPT_EVENT = "atomic_pooled_delivery_receipt";

/**
 * Whether the stage's turn loop runs: a turn streams (reported by the handle or only by its session,
 * as a replayed turn may be), or the loop holds the stage's message admission between two turns.
 * Text sent now joins that loop; it never starts a turn of its own.
 */
function turnUnderway(handle: StageControlHandle): boolean {
	return handle.isStreaming || handle.agentSession?.isStreaming === true || handle.isTurnLoopBusy === true;
}

/** What a session says when asked to start a turn while one is running. */
const BUSY_SESSION = /already processing/i;

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
	private readonly receipts = new Map<StageControlHandle, StageDeliveryReceipts>();

	constructor(
		private readonly registry: StageControlRegistry,
		private readonly attempt: () => AttemptRef | undefined,
		private readonly send: (message: DistributiveOmit<Outbound, "id">) => void,
		/** Pool-wide control as the worker last observed it. */
		private readonly control: () => string = () => "running",
		/** What the airlock reads from the attempt beyond its stage handles; later phases add to it. */
		private readonly options: {
			/** The stage session's committed entries, for a handle whose session is not attached yet. */
			readonly entries?: (sessionId: string) => Promise<readonly SessionEntry[] | undefined>;
			/** Whether the stage started a turn in this attempt. */
			readonly turnStarted?: (handle: StageControlHandle) => boolean;
		} = {},
	) {}

	serve(command: WorkerStageCommand): void {
		const held = this.attempt();
		tracePooledWatch("worker.command", {
			commandId: command.commandId,
			op: command.op,
			watch: "watch" in command ? command.watch : undefined,
			generation: command.attempt.generation,
			heldGeneration: held?.generation,
			heldWorkId: held?.workId === command.attempt.workId,
		});
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
		const handle = this.registry.get(command.runId, command.stageId);
		// The receipts a replayed session already holds, read before the stream starts.
		const delivered = handle === undefined ? new Set<DeliveryOpId>() : this.deliveredOps(handle);
		if (delivered instanceof Promise) void delivered.then((ops) => this.open(command, handle, ops));
		else this.open(command, handle, delivered);
	}

	private open(
		command: Extract<WorkerStageCommand, { op: "watch" }>,
		handle: StageControlHandle | undefined,
		delivered: ReadonlySet<DeliveryOpId>,
	): void {
		const held = this.attempt();
		if (held?.workId !== command.attempt.workId || held.generation !== command.attempt.generation) {
			tracePooledWatch("worker.watch.refused", { watch: command.watch, refusal: "AttemptChanging" });
			this.send({ kind: "stage-command-result", commandId: command.commandId, refusal: "AttemptChanging" });
			return;
		}
		if (handle === undefined || isTerminal(handle) || this.registry.get(command.runId, command.stageId) !== handle) {
			tracePooledWatch("worker.watch.refused", {
				watch: command.watch,
				refusal: "StageNotOnWorker",
				handle: handle !== undefined,
				terminal: handle === undefined ? undefined : isTerminal(handle),
			});
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
		tracePooledWatch("worker.watch.opened", {
			watch: command.watch,
			status: handle.status,
			streaming: handle.isStreaming,
			sessionStreaming: handle.agentSession?.isStreaming,
			turnLoopBusy: handle.isTurnLoopBusy,
			turnStarted: this.options.turnStarted?.(handle),
			session: handle.agentSession !== undefined,
			delivered: [...delivered],
		});
		this.send({
			kind: "stage-command-result",
			commandId: command.commandId,
			snapshot: {
				...snapshot(handle, watch.seq),
				deliveredOps: [...delivered],
				turnStarted: handle.isStreaming || this.options.turnStarted?.(handle) === true,
			},
		});
	}

	/** Ops the stage's session holds receipts for: its live entries and its committed ones. */
	private deliveredOps(handle: StageControlHandle): Set<DeliveryOpId> | Promise<Set<DeliveryOpId>> {
		const session = handle.agentSession?.sessionManager;
		const live = deliveredOps(session?.getEntries() ?? []);
		const load = this.options.entries;
		// An attached session holds every entry it replayed; only a stage that has not attached its
		// session yet needs the committed entries, so nothing here waits on the session store then.
		if (session !== undefined || handle.sessionId === undefined || load === undefined) return new Set(live);
		return load(handle.sessionId).then(
			(committed) => new Set([...live, ...deliveredOps(committed ?? [])]),
			() => new Set(live),
		);
	}

	/** Ends watches whose stage finished; called on the worker heartbeat. */
	sweep(): void {
		for (const [id, watch] of this.watches) {
			// The stage registered another handle (it moved from replaying to running live, say): this
			// watch would see nothing more, so the root opens a new one on the current handle.
			const current = this.registry.get(watch.handle.runId, watch.handle.stageId);
			if (current !== undefined && current !== watch.handle && !isTerminal(current)) {
				tracePooledWatch("worker.watch.handle-replaced", { watch: id });
				this.flush(id);
				this.close(id);
				this.send({ kind: "stage-watch-ended", watch: id, reason: "resync" });
				continue;
			}
			if (isTerminal(watch.handle)) {
				this.flush(id);
				this.close(id);
				this.send({ kind: "stage-watch-ended", watch: id, reason: "stage_finished" });
			}
		}
	}

	/** Ends every watch when the attempt ends; the coordinator tells the root. */
	clear(): void {
		this.ledger.clear();
		for (const receipts of this.receipts.values()) receipts.dispose();
		this.receipts.clear();
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
		// A message the session already holds, e.g. from before a replay, is not sent again.
		const alreadyHeld =
			message !== undefined && (await Promise.resolve(this.deliveredOps(watch.handle))).has(message.deliveryOp);
		const resumeWith = async (): Promise<StageCommandResult> => {
			const action = await watch.handle.resume(alreadyHeld ? undefined : message?.text);
			return action === undefined ? {} : { action };
		};
		const resumed = (
			message === undefined
				? resumeWith()
				: this.receiptsFor(watch.handle).track(message.deliveryOp, watch.handle.isStreaming, resumeWith)
		).catch(
			(error: Error): StageCommandResult =>
				isTerminal(watch.handle) ? { refusal: "StageNotLive" } : { error: error.message },
		);
		if (message !== undefined) this.ledger.set(message.deliveryOp, resumed);
		return resumed;
	}

	/**
	 * The receipt book of a stage: it records an op in the stage's session once that delivery's
	 * user message is in it, so a replacement attempt that replays the session knows it arrived.
	 */
	private receiptsFor(handle: StageControlHandle): StageDeliveryReceipts {
		let receipts = this.receipts.get(handle);
		if (receipts === undefined) {
			receipts = new StageDeliveryReceipts(handle, (op) => {
				void handle.agentSession?.sessionManager.appendCustomEntry(DELIVERY_OP_ENTRY, { op }).catch(() => {});
				// Watchers learn it arrived, so their outbox stops carrying it.
				for (const [id, watch] of this.watches)
					if (watch.handle === handle)
						this.record(id, { type: DELIVERY_RECEIPT_EVENT, op } as never as AgentSessionEvent);
			});
			this.receipts.set(handle, receipts);
		}
		return receipts;
	}

	private async deliver(command: Extract<WorkerStageCommand, { op: "deliver" }>): Promise<StageCommandResult> {
		const recorded = this.ledger.get(command.deliveryOp);
		const watch = this.watches.get(command.watch);
		if (recorded !== undefined) {
			// A retry of text still being admitted: once it sits in the session's queue it is admitted.
			const queue = command.intent === "steer" ? "steering" : "followUp";
			if (watch?.handle.queuedUserMessages?.()[queue].includes(command.text) === true)
				return Promise.race([
					recorded,
					Promise.resolve({ action: command.intent === "steer" ? "steer" : "followUp" } as const),
				]);
			return recorded;
		}
		const held = this.attempt();
		const refuse = (refusal: DeliveryRefusal): Promise<StageCommandResult> => Promise.resolve({ refusal });
		if (
			held?.workId !== command.attempt.workId ||
			held.generation !== command.attempt.generation ||
			watch === undefined
		) {
			tracePooledWatch("worker.deliver.refused", {
				op: command.deliveryOp,
				refusal: "StaleAttempt",
				watched: watch !== undefined,
			});
			return refuse("StaleAttempt");
		}
		if (isTerminal(watch.handle)) return refuse("StageNotLive");
		tracePooledWatch("worker.deliver.admit", {
			op: command.deliveryOp,
			watch: command.watch,
			intent: command.intent,
			status: watch.handle.status,
			streaming: watch.handle.isStreaming,
			sessionStreaming: watch.handle.agentSession?.isStreaming,
			turnLoopBusy: watch.handle.isTurnLoopBusy,
			current: this.registry.get(watch.handle.runId, watch.handle.stageId) === watch.handle,
		});
		const admitted = Promise.resolve(this.deliveredOps(watch.handle))
			.then((delivered) =>
				// The session already holds this op, e.g. from before a replay: admit it at most once.
				delivered.has(command.deliveryOp)
					? { action: "handled" as const }
					: this.receiptsFor(watch.handle).track(command.deliveryOp, turnUnderway(watch.handle), () =>
							admitStageUserMessage(watch.handle, command.text, command.intent, command.expandPromptTemplates),
						),
			)
			.catch(
				(error: Error): StageCommandResult =>
					isTerminal(watch.handle) ? { refusal: "StageNotLive" } : { error: error.message },
			);
		void admitted.then((outcome) =>
			tracePooledWatch("worker.deliver.settled", {
				op: command.deliveryOp,
				action: outcome.action,
				refusal: outcome.refusal,
				error: outcome.error,
			}),
		);
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

function deliveredOps(entries: readonly SessionEntry[]): DeliveryOpId[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== DELIVERY_OP_ENTRY) return [];
		const op = (entry.data as { readonly op?: string } | undefined)?.op;
		return typeof op === "string" ? [op as DeliveryOpId] : [];
	});
}

function snapshot(handle: StageControlHandle, seq: number): PooledStageChatSnapshot {
	const streamingMessage = handle.agentSession?.agent?.state.streamingMessage;
	return {
		sessionId: handle.sessionId,
		status: handle.status,
		isStreaming: handle.isStreaming,
		messages: [...handle.messages],
		...(streamingMessage === undefined ? {} : { streamingMessage }),
		pendingToolExecutionEvents: [...(handle.pendingToolExecutionEvents?.() ?? [])],
		queued: handle.queuedUserMessages?.() ?? EMPTY_STAGE_QUEUED_USER_MESSAGES,
		seq,
	};
}
