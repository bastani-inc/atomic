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
 * text. Every other event keeps its place and is never dropped.
 */
export function appendCoalesced(batch: SeqEvent[], next: SeqEvent): void {
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
		return;
	}
	const event = next.event as AgentSessionEvent & { readonly assistantMessageEvent: DeltaEvent };
	batch[batch.length - 1] = {
		seq: next.seq,
		event: {
			...event,
			assistantMessageEvent: { ...event.assistantMessageEvent, delta: previous.delta + current.delta },
		} as AgentSessionEvent,
	};
}
