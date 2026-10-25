import type { PendingStageMessage } from "./store-types.js";

export const PENDING_STAGE_SETTLED_MESSAGE_LIMIT = 50;

/** Whether an entry no longer awaits delivery or notification and only remains as a bounded receipt. */
export function isSettledPendingStageMessage(entry: PendingStageMessage): boolean {
	return (
		entry.status === "delivered" || (entry.status === "undeliverable" && entry.undeliverableNotifiedAt !== undefined)
	);
}

export async function retainPendingStageMessages(
	messages: readonly PendingStageMessage[],
	archive: (entry: PendingStageMessage) => Promise<void>,
): Promise<readonly PendingStageMessage[]> {
	const settled = messages.filter(isSettledPendingStageMessage);
	const expired = new Set(settled.slice(0, Math.max(0, settled.length - PENDING_STAGE_SETTLED_MESSAGE_LIMIT)));
	for (const entry of expired) await archive(entry);
	return expired.size === 0 ? messages : messages.filter((entry) => !expired.has(entry));
}
