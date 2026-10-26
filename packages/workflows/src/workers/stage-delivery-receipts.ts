import type { AgentSessionEvent } from "@bastani/atomic";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import type { DeliveryOpId } from "./stage-watch-types.js";

type QueueName = "steering" | "followUp";

/** One of the session's message queues, counted from this receipt book's subscription. */
interface QueueCount {
	length: number;
	/** Items that ever entered it; the next item gets `enqueued + 1`. */
	enqueued: number;
	/** Items that ever left it, from the front. */
	consumed: number;
	/** Ops queued by this worker, by the position they entered at. */
	readonly ops: Map<number, DeliveryOpId>;
}

function queueLengths(event: AgentSessionEvent): Record<QueueName, number> | undefined {
	if (event.type !== "queue_update") return undefined;
	const update = event as { readonly steering?: readonly string[]; readonly followUp?: readonly string[] };
	return { steering: update.steering?.length ?? 0, followUp: update.followUp?.length ?? 0 };
}

/**
 * Records, in a stage's own session, which delivery ops have entered it as user messages
 * (#3996), so a replacement attempt that replays the session redelivers only what it lacks.
 *
 * A delivery is identified by where it went, never by its text: a queued steer or follow-up
 * by its position in its queue, an idle prompt by the user message that starts its turn. Each
 * receipt is written when that user message ends, so a session never holds a receipt for a
 * message it does not hold, and template expansion or similar texts cannot confuse two ops.
 */
export class StageDeliveryReceipts {
	private readonly queues: Record<QueueName, QueueCount> = {
		steering: { length: 0, enqueued: 0, consumed: 0, ops: new Map() },
		followUp: { length: 0, enqueued: 0, consumed: 0, ops: new Map() },
	};
	/** Consumed queue items awaiting their user message's end; undefined for items not ours. */
	private readonly consumed: (DeliveryOpId | undefined)[] = [];
	/** An idle prompt being admitted, waiting for the user message that starts its turn. */
	private prompting?: DeliveryOpId;
	/** The idle prompt whose user message started, waiting for that message's end. */
	private prompted?: DeliveryOpId;
	private readonly unsubscribe: () => void;

	constructor(
		handle: StageControlHandle,
		private readonly receipt: (op: DeliveryOpId) => void,
	) {
		const queued = handle.queuedUserMessages?.();
		this.queues.steering.length = this.queues.steering.enqueued = queued?.steering.length ?? 0;
		this.queues.followUp.length = this.queues.followUp.enqueued = queued?.followUp.length ?? 0;
		this.unsubscribe = handle.subscribe((event) => this.observe(event));
	}

	/**
	 * Admits one delivery through `admit` and keeps track of where it went: the queue its
	 * action names, or the turn an idle prompt started.
	 */
	async track<T extends { readonly action?: string }>(
		op: DeliveryOpId,
		streaming: boolean,
		admit: () => Promise<T>,
	): Promise<T> {
		const before = { steering: this.queues.steering.enqueued, followUp: this.queues.followUp.enqueued };
		if (!streaming) this.prompting = op;
		let promptPending = false;
		try {
			const result = await admit();
			// An idle prompt may be admitted before its user message starts the turn (a resume that waits
			// for a provider cooldown first, say): the receipt waits for that message, not for the call.
			promptPending = result.action === "prompt" && this.prompting === op;
			const queue: QueueName | undefined =
				result.action === "steer" ? "steering" : result.action === "followUp" ? "followUp" : undefined;
			if (queue !== undefined && this.queues[queue].enqueued > before[queue]) {
				const position = before[queue] + 1;
				// Already consumed by the time admission answered: its message is next to end.
				if (position <= this.queues[queue].consumed) this.consumed.push(op);
				else this.queues[queue].ops.set(position, op);
			}
			return result;
		} finally {
			if (!promptPending && this.prompting === op) this.prompting = undefined;
		}
	}

	dispose(): void {
		this.unsubscribe();
	}

	private observe(event: AgentSessionEvent): void {
		const lengths = queueLengths(event);
		if (lengths !== undefined) {
			for (const name of ["steering", "followUp"] as const) {
				const queue = this.queues[name];
				const length = lengths[name];
				if (length > queue.length) queue.enqueued += length - queue.length;
				else
					for (let taken = queue.length - length; taken > 0; taken--) {
						queue.consumed++;
						this.consumed.push(queue.ops.get(queue.consumed));
						queue.ops.delete(queue.consumed);
					}
				queue.length = length;
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user") {
			if (this.consumed.length === 0 && this.prompting !== undefined) {
				this.prompted = this.prompting;
				this.prompting = undefined;
			}
			return;
		}
		if (event.type !== "message_end" || event.message.role !== "user") return;
		if (this.consumed.length > 0) {
			const op = this.consumed.shift();
			if (op !== undefined) this.receipt(op);
			return;
		}
		const op = this.prompted;
		this.prompted = undefined;
		if (op !== undefined) this.receipt(op);
	}
}
