import { type Component, Spacer, TruncatedText } from "@bastani/atomic-tui";
import type { SteeringLane, SteeringQueuedTexts } from "../steering-queue-controller.ts";

/** One queued message as a chat lists it above its prompt. */
export interface QueuedMessageRow {
	readonly lane: SteeringLane;
	readonly text: string;
}

/** The label a row starts with: `Steering:` for the next turn boundary, `Follow-up:` for after the run. */
export function queuedMessageLabel(lane: SteeringLane): "Steering" | "Follow-up" {
	return lane === "steer" ? "Steering" : "Follow-up";
}

/** The rows for `queued`: every steering message, then every follow-up, each lane in delivery order. */
export function queuedMessageRows(queued: Readonly<SteeringQueuedTexts>): QueuedMessageRow[] {
	return [
		...queued.steering.map((text): QueuedMessageRow => ({ lane: "steer", text })),
		...queued.followUp.map((text): QueuedMessageRow => ({ lane: "followUp", text })),
	];
}

/** The line under the rows that names the key taking every queued message back to the editor. */
export function queuedMessagesHint(dequeueKey: string): string {
	return `↳ ${dequeueKey} to edit all queued messages`;
}

/**
 * The queued messages of one chat, drawn above its prompt: a blank line, one dim row per message cut to the width,
 * and the hint for the key that edits them. Draws nothing while nothing is queued.
 */
export class QueuedMessagesView implements Component {
	private readonly rows: readonly QueuedMessageRow[];
	private readonly dequeueKey: string;
	private readonly dim: (text: string) => string;

	constructor(rows: readonly QueuedMessageRow[], dequeueKey: string, dim: (text: string) => string) {
		this.rows = rows;
		this.dequeueKey = dequeueKey;
		this.dim = dim;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.rows.length === 0) return [];
		const lines = new Spacer(1).render(width);
		for (const row of this.rows) {
			lines.push(...line(this.dim(`${queuedMessageLabel(row.lane)}: ${row.text}`), width));
		}
		lines.push(...line(this.dim(queuedMessagesHint(this.dequeueKey)), width));
		return lines;
	}
}

function line(text: string, width: number): string[] {
	return new TruncatedText(text, 1, 0).render(width);
}
