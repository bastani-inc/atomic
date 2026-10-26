import type { AgentSessionEvent } from "@bastani/atomic";
import type { SeqEvent } from "./stage-watch-types.js";

const DELTA_TYPES = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface DeltaEvent {
	readonly type: string;
	readonly contentIndex: number;
	readonly delta: string;
}

function streamedDelta(event: AgentSessionEvent): DeltaEvent | undefined {
	if (event.type !== "message_update") return undefined;
	const inner = (event as { readonly assistantMessageEvent?: DeltaEvent }).assistantMessageEvent;
	return inner !== undefined && DELTA_TYPES.has(inner.type) && typeof inner.delta === "string" ? inner : undefined;
}

/**
 * Appends an event to a pending batch, merging it into the previous event when both are
 * deltas of the same content block. The merged event carries both deltas, in order, and
 * the newest partial message, so a consumer that rebuilds text from deltas sees the same
 * text. Every other event keeps its place and is never dropped. Returns the length of the
 * delta merged into the previous event, or undefined when `next` was appended on its own.
 */
export function appendCoalesced(batch: SeqEvent[], next: SeqEvent): number | undefined {
	const last = batch.at(-1);
	const previous = last === undefined ? undefined : streamedDelta(last.event);
	const current = streamedDelta(next.event);
	if (
		last === undefined ||
		previous === undefined ||
		current === undefined ||
		previous.type !== current.type ||
		previous.contentIndex !== current.contentIndex
	) {
		batch.push(next);
		return undefined;
	}
	const event = next.event as AgentSessionEvent & { readonly assistantMessageEvent: DeltaEvent };
	batch[batch.length - 1] = {
		seq: next.seq,
		event: {
			...event,
			assistantMessageEvent: { ...event.assistantMessageEvent, delta: previous.delta + current.delta },
		} as AgentSessionEvent,
	};
	return current.delta.length;
}

/**
 * The events of one watch that wait while its previous batch awaits the root (#3996).
 *
 * Its serialized size is kept incrementally: an event appended on its own is measured once,
 * and a delta merged into the previous event adds its own length twice (the merged delta and
 * the newer partial message each grow by it). Accounting therefore stays linear in what
 * arrives, however long one streamed message grows.
 */
export class StageEventBacklog {
	private readonly events: SeqEvent[] = [];
	private size = 0;

	constructor(private readonly limits: { readonly events: number; readonly bytes: number }) {}

	get length(): number {
		return this.events.length;
	}

	/** Approximate serialized size of the waiting events, in characters. */
	get bytes(): number {
		return this.size;
	}

	/** Adds events in order; false as soon as a bound is passed, leaving the rest unadded. */
	push(events: readonly SeqEvent[]): boolean {
		for (const event of events) {
			const merged = appendCoalesced(this.events, event);
			this.size += merged === undefined ? JSON.stringify(event).length : 2 * merged;
			if (this.events.length > this.limits.events || this.size > this.limits.bytes) return false;
		}
		return true;
	}

	/** Removes and returns every waiting event. */
	drain(): SeqEvent[] {
		this.size = 0;
		return this.events.splice(0);
	}
}
