import { type Component, Spacer, TruncatedText } from "@bastani/atomic-tui";
import type { SteeringLane, SteeringQueuedTexts, SteeringQueueLists } from "../steering-queue-controller.ts";

/** One queued message as a chat lists it above its prompt. */
export interface QueuedMessageRow {
	readonly lane: SteeringLane;
	readonly text: string;
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
	return [
		...[...(delivering?.steering ?? []), ...queued.steering].map(
			(text): QueuedMessageRow => ({ lane: "steer", text }),
		),
		...[...(delivering?.followUp ?? []), ...queued.followUp].map(
			(text): QueuedMessageRow => ({ lane: "followUp", text }),
		),
	];
}

/** The line under the rows that names the key taking every queued message back to the editor. */
export function queuedMessagesHint(dequeueKey: string): string {
	return `↳ ${dequeueKey} to edit all queued messages`;
}

/**
 * The queued messages of one chat, drawn above its prompt: a blank line, one dim row per message cut to the width,
 * and the hint for the key that edits them. Draws nothing while nothing is queued. Rows are styled when the view is
 * built, so a chat rebuilds the view when its queue, key or theme changes.
 */
export class QueuedMessagesView implements Component {
	private readonly lines: readonly TruncatedText[];

	constructor(rows: readonly QueuedMessageRow[], dequeueKey: string, dim: (text: string) => string) {
		this.lines =
			rows.length === 0
				? []
				: [
						...rows.map((row) => new TruncatedText(dim(`${queuedMessageLabel(row.lane)}: ${row.text}`), 1, 0)),
						new TruncatedText(dim(queuedMessagesHint(dequeueKey)), 1, 0),
					];
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.lines.length === 0) return [];
		return [...new Spacer(1).render(width), ...this.lines.flatMap((line) => line.render(width))];
	}
}
