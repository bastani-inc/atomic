import type { PendingStageMessage } from "./store-types.js";

const PENDING_STAGE_SETTLED_MESSAGE_LIMIT = 50;

export async function retainPendingStageMessages(
	messages: readonly PendingStageMessage[],
	archive: (entry: PendingStageMessage) => Promise<void>,
): Promise<readonly PendingStageMessage[]> {
	const settled = messages.filter(
		(entry) =>
			entry.status === "delivered" ||
			(entry.status === "undeliverable" && entry.undeliverableNotifiedAt !== undefined),
	);
	const expired = new Set(settled.slice(0, Math.max(0, settled.length - PENDING_STAGE_SETTLED_MESSAGE_LIMIT)));
	for (const entry of expired) await archive(entry);
	return expired.size === 0 ? messages : messages.filter((entry) => !expired.has(entry));
}
