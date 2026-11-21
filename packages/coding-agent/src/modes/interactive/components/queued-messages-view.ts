import { type Component, Spacer, TruncatedText } from "@bastani/atomic-tui";
import type { SteeringLane, SteeringQueuedTexts, SteeringQueueLists } from "../steering-queue-controller.ts";

/** One queued message as a chat lists it above its prompt. */
export interface QueuedMessageRow {
	readonly lane: SteeringLane;
	readonly text: string;
	/** The agent already took it: drawn until its own row shows, but no longer queued, so no key takes it back. */
	readonly delivering?: true;
}

/** The label a row starts with: `Steering:` for the next turn boundary, `Follow-up:` for after the run. */
export function queuedMessageLabel(lane: SteeringLane): "Steering" | "Follow-up" {
	return lane === "steer" ? "Steering" : "Follow-up";
}

/**
 * The rows for `queued`: every steering message, then every follow-up, each lane in delivery order. `delivering` are
 * messages the agent already took whose own row its transcript does not show yet; each leads its lane until it does.
 */
export function queuedMessageRows(
	queued: Readonly<SteeringQueuedTexts>,
	delivering?: Readonly<SteeringQueueLists>,
): QueuedMessageRow[] {
	const rows = (lane: SteeringLane, taken: readonly string[], waiting: readonly string[]): QueuedMessageRow[] => [
		...taken.map((text): QueuedMessageRow => ({ lane, text, delivering: true })),
		...waiting.map((text): QueuedMessageRow => ({ lane, text })),
	];
	return [
		...rows("steer", delivering?.steering ?? [], queued.steering),
		...rows("followUp", delivering?.followUp ?? [], queued.followUp),
	];
}

/** The line under the rows that names the key taking every queued message back to the editor. */
export function queuedMessagesHint(dequeueKey: string): string {
	return `↳ ${dequeueKey} to edit all queued messages`;
}

/**
 * The queued messages of one chat, drawn above its prompt: a blank line, one dim row per message cut to the width,
 * and, while one of them is still queued, the hint for the key that takes them back to edit. Draws nothing while
 * nothing is queued. Rows are styled when the view is built, so a chat rebuilds the view when its queue, key or theme
 * changes.
 */
export class QueuedMessagesView implements Component {
	private readonly lines: readonly TruncatedText[];

	constructor(rows: readonly QueuedMessageRow[], dequeueKey: string, dim: (text: string) => string) {
		this.lines =
			rows.length === 0
				? []
				: [
						...rows.map((row) => new TruncatedText(dim(`${queuedMessageLabel(row.lane)}: ${row.text}`), 1, 0)),
						...(rows.some((row) => row.delivering !== true)
							? [new TruncatedText(dim(queuedMessagesHint(dequeueKey)), 1, 0)]
							: []),
					];
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.lines.length === 0) return [];
		return [...new Spacer(1).render(width), ...this.lines.flatMap((line) => line.render(width))];
	}
}
