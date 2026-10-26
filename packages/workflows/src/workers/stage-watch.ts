import type { AgentSessionEvent } from "@bastani/atomic";
import type { StageControlHandle, StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { EMPTY_STAGE_QUEUED_USER_MESSAGES } from "../runs/foreground/stage-queued-user-messages.js";
import type { DistributiveOmit, WorkerRequest, WorkerStageCommand } from "./protocol.js";
import { appendCoalesced } from "./stage-watch-coalesce.js";
import type { AttemptRef, PooledStageChatSnapshot, SeqEvent, WatchId } from "./stage-watch-types.js";

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

	constructor(
		private readonly registry: StageControlRegistry,
		private readonly attempt: () => AttemptRef | undefined,
		private readonly send: (message: DistributiveOmit<Outbound, "id">) => void,
	) {}

	serve(command: WorkerStageCommand): void {
		if (command.op === "unwatch") {
			this.close(command.watch);
			this.send({ kind: "stage-command-result", commandId: command.commandId });
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
		for (const id of [...this.watches.keys()]) {
			this.flush(id);
			this.close(id);
		}
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
