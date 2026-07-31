/**
 * Handle-owned projection of a stage session's pending user-message queue.
 *
 * The queue itself lives on the session, but its display lives in a stage-chat
 * pane that detach destroys, and the graph needs a count for a stage nobody is
 * attached to. Both read this buffer instead of the concrete coding-agent
 * `AgentSession`, so a custom `StageSessionRuntime` that publishes ordinary
 * `queue_update` events keeps queue-aware UI without having to satisfy the
 * whole concrete session surface.
 *
 * This is a runtime projection of the event stream, never durable workflow
 * state: nothing here belongs in a cloned `StageSnapshot`.
 *
 * cross-ref:
 *   - src/runs/foreground/executor-stage-control.ts (live handle wiring)
 *   - src/runs/foreground/postmortem-stage-chat.ts (retained-session wiring)
 *   - packages/coding-agent/src/core/agent-session-events.ts (`queue_update`)
 */

import type { AgentSessionEvent } from "@bastani/atomic";

/** Pending steering and follow-up text on one stage session. */
export interface StageQueuedUserMessages {
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}

export const EMPTY_STAGE_QUEUED_USER_MESSAGES: StageQueuedUserMessages = Object.freeze({
	steering: Object.freeze([]) as readonly string[],
	followUp: Object.freeze([]) as readonly string[],
});

function queuedTexts(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

export class StageQueuedUserMessageBuffer {
	private queued: StageQueuedUserMessages = EMPTY_STAGE_QUEUED_USER_MESSAGES;

	/**
	 * Each `queue_update` is a complete snapshot, including the reduced snapshot
	 * published just before a queued message is consumed, so replace both lists
	 * rather than merging. Duplicates, text, and per-queue order are preserved
	 * exactly as the session published them.
	 */
	record(event: AgentSessionEvent): void {
		if (String((event as { type?: unknown }).type ?? "") !== "queue_update") return;
		const update = event as { steering?: unknown; followUp?: unknown };
		this.queued = {
			steering: queuedTexts(update.steering),
			followUp: queuedTexts(update.followUp),
		};
	}

	snapshot(): StageQueuedUserMessages {
		return this.queued;
	}

	clear(): void {
		this.queued = EMPTY_STAGE_QUEUED_USER_MESSAGES;
	}
}

/**
 * The `queue_update` a session would publish for the queue it is already
 * holding, or `undefined` when it holds nothing or does not expose its queues.
 *
 * A session announces its queue by event, so a queue that exists before this
 * stage's listeners are bound to that session is announced to nobody: the
 * retirement transfer publishes on the adopting session while the stage's
 * listeners are still unsubscribed, and a reopened retained session publishes
 * before a post-mortem handle's projection reaches it. Reading the session once
 * at attach closes that window; every later change still arrives as an event.
 *
 * The lists are copied, never aliased: a session returns its live arrays.
 */
export function stageSessionQueueUpdateEvent(session: {
	getSteeringMessages?(): readonly string[];
	getFollowUpMessages?(): readonly string[];
}): AgentSessionEvent | undefined {
	if (typeof session.getSteeringMessages !== "function" || typeof session.getFollowUpMessages !== "function") {
		return undefined;
	}
	const steering = queuedTexts(session.getSteeringMessages());
	const followUp = queuedTexts(session.getFollowUpMessages());
	if (steering.length === 0 && followUp.length === 0) return undefined;
	return { type: "queue_update", steering, followUp };
}

/** Total pending entries across both queues. */
export function stageQueuedUserMessageCount(queued: StageQueuedUserMessages | undefined): number {
	if (!queued) return 0;
	return queued.steering.length + queued.followUp.length;
}
