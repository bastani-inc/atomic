import type {
	PendingStageMessage,
	PendingStageMessageDelivery,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStickyStageMessageInput,
} from "./store-types.js";

export type {
	PendingStageMessage,
	PendingStageMessageDelivery,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStageSender,
	PendingStickyStageMessageInput,
} from "./store-types.js";

/** Maximum queued messages retained for one canonical workflow stage. */
export const PENDING_STAGE_MESSAGE_LIMIT = 50;
const PENDING_STAGE_UNDELIVERABLE_NOTIFICATION_PREFIX = "atomic-pending-stage-undeliverable";

export interface PendingStageIdentity {
	readonly id: string;
	readonly replayKey?: string;
	readonly aliases: readonly string[];
}

/**
 * Add one queued entry without mutating the supplied collection.
 *
 * Group comparison deliberately mirrors intercom's `normalizeGroup` semantics
 * locally. The workflows durable-state layer must remain independent of the
 * detached broker package, while undefined/empty/whitespace groups still map
 * to the same implicit `default` group.
 */
export function queueStageMessage(
	messages: readonly PendingStageMessage[],
	input: PendingStageMessageInput,
	senderGroup: string | undefined,
	runGroup: string | undefined,
	stageIdentity?: PendingStageIdentity,
): PendingStageQueueResult {
	if (normalizeDeliveryGroup(senderGroup) !== normalizeDeliveryGroup(runGroup)) {
		return { ok: false, reason: "group_mismatch", runId: input.runId, stageKey: input.stageKey };
	}

	const messageId = input.message.id;
	const queued = pendingStageMessagesFor(messages, input.runId, input.stageKey, stageIdentity);
	const existing = messages.find((entry) => entry.runId === input.runId && entry.id === messageId);
	if (existing !== undefined) {
		if (
			pendingStageMessageSignature(existing, stageIdentity) !== pendingStageMessageSignature(input, stageIdentity)
		) {
			return {
				ok: false,
				reason: "message_id_conflict",
				runId: input.runId,
				stageKey: input.stageKey,
				messageId,
			};
		}
		const queuedPosition = queued.indexOf(existing);
		return {
			ok: true,
			messages,
			entry: existing,
			...(queuedPosition >= 0 ? { position: queuedPosition + 1 } : {}),
			deduplicated: true,
		};
	}

	if (queued.length >= PENDING_STAGE_MESSAGE_LIMIT) {
		return {
			ok: false,
			reason: "capacity",
			limit: PENDING_STAGE_MESSAGE_LIMIT,
			runId: input.runId,
			stageKey: input.stageKey,
		};
	}

	const entry: PendingStageMessage = {
		...input,
		id: messageId,
		...(stageIdentity !== undefined ? { stageId: stageIdentity.id } : {}),
		...(stageIdentity?.replayKey !== undefined ? { stageReplayKey: stageIdentity.replayKey } : {}),
		admissionOrder: nextAdmissionOrder(messages, input.runId),
		status: "queued",
	};
	return {
		ok: true,
		messages: [...messages, entry],
		entry,
		position: queued.length + 1,
		deduplicated: false,
	};
}

/**
 * Add one sticky (D3) entry for a path/pattern target without mutating the supplied
 * collection. The entry lives in the ROOT run's durable bucket, is keyed by the verbatim
 * `targetPath`, and is delivered to every future stage whose depth-faithful path matches
 * until the root run reaches a terminal status. Capacity is counted per target path.
 */
export function queueStickyStageMessage(
	messages: readonly PendingStageMessage[],
	input: PendingStickyStageMessageInput,
	senderGroup: string | undefined,
	runGroup: string | undefined,
): PendingStageQueueResult {
	if (normalizeDeliveryGroup(senderGroup) !== normalizeDeliveryGroup(runGroup)) {
		return { ok: false, reason: "group_mismatch", runId: input.runId, stageKey: input.targetPath };
	}

	const messageId = input.message.id;
	const existing = messages.find((entry) => entry.runId === input.runId && entry.id === messageId);
	if (existing !== undefined) {
		if (pendingStageMessageSignature(existing) !== pendingStageMessageSignature(input)) {
			return {
				ok: false,
				reason: "message_id_conflict",
				runId: input.runId,
				stageKey: input.targetPath,
				messageId,
			};
		}
		const queuedForTarget = queuedStickyCount(messages, input.runId, input.targetPath);
		return {
			ok: true,
			messages,
			entry: existing,
			...(existing.status === "queued" ? { position: queuedForTarget } : {}),
			deduplicated: true,
		};
	}

	if (queuedStickyCount(messages, input.runId, input.targetPath) >= PENDING_STAGE_MESSAGE_LIMIT) {
		return {
			ok: false,
			reason: "capacity",
			limit: PENDING_STAGE_MESSAGE_LIMIT,
			runId: input.runId,
			stageKey: input.targetPath,
		};
	}

	const entry: PendingStageMessage = {
		...input,
		id: messageId,
		stageKey: input.targetPath,
		sticky: true,
		deliveries: [],
		deliveryCount: 0,
		admissionOrder: nextAdmissionOrder(messages, input.runId),
		status: "queued",
	};
	return {
		ok: true,
		messages: [...messages, entry],
		entry,
		position: queuedStickyCount(messages, input.runId, input.targetPath) + 1,
		deduplicated: false,
	};
}

function queuedStickyCount(messages: readonly PendingStageMessage[], runId: string, targetPath: string): number {
	return messages.filter(
		(entry) =>
			entry.runId === runId && entry.sticky === true && entry.targetPath === targetPath && entry.status === "queued",
	).length;
}

/**
 * Record exactly-once deliveries of a sticky entry to materialized stages (D3). Entries
 * for (runId, stageId) pairs that already have a record are ignored; the entry itself
 * stays queued so future matching stages keep receiving it.
 */
export function recordPendingStageMessageDeliveries(
	messages: readonly PendingStageMessage[],
	runId: string,
	messageId: string,
	records: readonly { readonly runId: string; readonly stageId: string; readonly stageName?: string }[],
	deliveredAt: string,
): readonly PendingStageMessage[] {
	const index = messages.findIndex(
		(entry) => entry.runId === runId && entry.id === messageId && entry.sticky === true && entry.status === "queued",
	);
	if (index < 0) return messages;
	const entry = messages[index]!;
	const recorded = new Set((entry.deliveries ?? []).map((delivery) => `${delivery.runId}\u0000${delivery.stageId}`));
	const additions: PendingStageMessageDelivery[] = [];
	for (const record of records) {
		const key = `${record.runId}\u0000${record.stageId}`;
		if (recorded.has(key)) continue;
		recorded.add(key);
		additions.push({
			runId: record.runId,
			stageId: record.stageId,
			...(record.stageName === undefined ? {} : { stageName: record.stageName }),
			deliveredAt,
		});
	}
	if (additions.length === 0) return messages;
	const deliveries = [...(entry.deliveries ?? []), ...additions];
	const next: PendingStageMessage = { ...entry, deliveries, deliveryCount: deliveries.length };
	const result = [...messages];
	result[index] = next;
	return result;
}

/** Settle a sticky entry that delivered at least once when its root run terminates (D4: no notification). */
export function settleStickyPendingStageMessageDelivered(
	messages: readonly PendingStageMessage[],
	runId: string,
	messageId: string,
	settledAt: string,
): readonly PendingStageMessage[] {
	const index = messages.findIndex(
		(entry) =>
			entry.runId === runId &&
			entry.id === messageId &&
			entry.sticky === true &&
			entry.status === "queued" &&
			(entry.deliveryCount ?? 0) > 0,
	);
	if (index < 0) return messages;
	const next = [...messages];
	next[index] = { ...next[index]!, status: "delivered", deliveredAt: settledAt };
	return next;
}

/** Read one canonical stage's queued entries in durable workflow admission order. */
export function pendingStageMessagesFor(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	stageIdentity?: PendingStageIdentity,
): readonly PendingStageMessage[] {
	return messages
		.map((entry, index) => ({ entry, index }))
		.filter(({ entry }) => matchesPendingStage(entry, runId, stageKey, stageIdentity) && entry.status === "queued")
		.sort(
			(left, right) =>
				(left.entry.admissionOrder ?? left.index + 1) - (right.entry.admissionOrder ?? right.index + 1) ||
				left.index - right.index,
		)
		.map(({ entry }) => entry);
}

export function queuedPendingStageMessageCount(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	stageIdentity?: PendingStageIdentity,
): number {
	return pendingStageMessagesFor(messages, runId, stageKey, stageIdentity).length;
}

export function markPendingStageMessageDelivered(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	deliveredAt: string,
	stageIdentity?: PendingStageIdentity,
): readonly PendingStageMessage[] {
	return updateQueuedPendingStageMessage(messages, runId, stageKey, messageId, stageIdentity, (entry) => ({
		...entry,
		status: "delivered",
		deliveredAt,
	}));
}

export function markPendingStageMessageUndeliverable(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	reason: string,
	stageIdentity?: PendingStageIdentity,
): readonly PendingStageMessage[] {
	return updateQueuedPendingStageMessage(messages, runId, stageKey, messageId, stageIdentity, (entry) => ({
		...entry,
		status: "undeliverable",
		undeliverableReason: reason,
		undeliverableNotificationId: pendingStageUndeliverableNotificationId(entry),
	}));
}

export function markPendingStageMessageUndeliverableNotified(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	notificationId: string,
	notifiedAt: string,
): readonly PendingStageMessage[] {
	const index = messages.findIndex(
		(entry) =>
			(entry.sticky === true ? entry.runId === runId : matchesPendingStage(entry, runId, stageKey)) &&
			entry.id === messageId &&
			entry.status === "undeliverable" &&
			entry.undeliverableNotificationId === notificationId &&
			entry.undeliverableNotifiedAt === undefined,
	);
	if (index < 0) return messages;
	const next = [...messages];
	next[index] = { ...next[index]!, undeliverableNotifiedAt: notifiedAt };
	return next;
}

/** Stable broker identity lets DeliveredMessageCache consume workflow-process crash retries. */
export function pendingStageUndeliverableNotificationId(
	entry: Pick<PendingStageMessage, "runId" | "stageKey" | "id">,
): string {
	return [
		PENDING_STAGE_UNDELIVERABLE_NOTIFICATION_PREFIX,
		encodeURIComponent(entry.runId),
		encodeURIComponent(entry.stageKey),
		encodeURIComponent(entry.id),
	].join(":");
}

function updateQueuedPendingStageMessage(
	messages: readonly PendingStageMessage[],
	runId: string,
	stageKey: string,
	messageId: string,
	stageIdentity: PendingStageIdentity | undefined,
	update: (entry: PendingStageMessage) => PendingStageMessage,
): readonly PendingStageMessage[] {
	const index = messages.findIndex((entry) => queuedEntryMatches(entry, runId, stageKey, messageId, stageIdentity));
	if (index < 0) return messages;
	const next = [...messages];
	next[index] = update(next[index]!);
	return next;
}

/** Sticky entries are unique per (runId, messageId); exact entries keep stage-key matching. */
function queuedEntryMatches(
	entry: PendingStageMessage,
	runId: string,
	stageKey: string,
	messageId: string,
	stageIdentity: PendingStageIdentity | undefined,
): boolean {
	if (entry.runId !== runId || entry.id !== messageId || entry.status !== "queued") return false;
	return entry.sticky === true || matchesPendingStage(entry, runId, stageKey, stageIdentity);
}

function matchesPendingStage(
	entry: PendingStageMessage,
	runId: string,
	stageKey: string,
	stageIdentity?: PendingStageIdentity,
): boolean {
	// Sticky (D3) entries target paths/patterns, never one exact stage; they are matched
	// separately by depth-faithful path matching and must not leak into exact lookups.
	if (entry.sticky === true) return false;
	if (entry.runId !== runId) return false;
	if (stageIdentity === undefined) return entry.stageKey === stageKey;
	return (
		entry.stageId === stageIdentity.id ||
		(entry.stageReplayKey !== undefined && entry.stageReplayKey === stageIdentity.replayKey) ||
		(entry.stageId === undefined && stageIdentity.aliases.includes(entry.stageKey))
	);
}

function nextAdmissionOrder(messages: readonly PendingStageMessage[], runId: string): number {
	let greatest = 0;
	let legacyPosition = 0;
	for (const entry of messages) {
		if (entry.runId !== runId) continue;
		legacyPosition += 1;
		greatest = Math.max(greatest, entry.admissionOrder ?? legacyPosition);
	}
	return greatest + 1;
}

function pendingStageMessageSignature(
	entry: PendingStageMessage | PendingStageMessageInput,
	stageIdentity?: PendingStageIdentity,
): string {
	const storedTarget = "status" in entry ? (entry.stageReplayKey ?? entry.stageId) : undefined;
	const { timestamp: transportTimestamp, ...logicalMessage } = entry.message;
	void transportTimestamp;
	return stableJson({
		target: storedTarget ?? stageIdentity?.replayKey ?? stageIdentity?.id ?? entry.stageKey,
		sender: entry.senderReturnAddress ?? entry.from.id,
		message: {
			...logicalMessage,
			expectsReply: logicalMessage.expectsReply ?? false,
			content: {
				...logicalMessage.content,
				attachments: logicalMessage.content.attachments ?? [],
			},
		},
	});
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, nested]) => nested !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, nested]) => [key, sortJsonValue(nested)]),
	);
}

function normalizeDeliveryGroup(value?: string | null): string {
	if (typeof value !== "string") return "default";
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : "default";
}
