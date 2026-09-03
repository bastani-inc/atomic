import { coercePossibleStages } from "../shared/possible-stages.js";
import type { PendingStageMessage, WorkflowActor } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import {
	isWorkflowFailureCode,
	isWorkflowFailureDisposition,
	isWorkflowFailureKind,
	isWorkflowFailureRecoverability,
} from "../shared/workflow-failures.js";
import type { DbosStepRecord } from "./dbos-backend.js";
import { DURABLE_FORMAT_VERSION, isCurrentDurableFormat } from "./format-version.js";
import type { DurableWorkflowMetadata, DurableWorkflowStatus } from "./types.js";
import { isAbsorbingDurableStatus } from "./workflow-status-transition.js";

const METADATA_STEP_PREFIX = "__atomic_metadata";

export type DbosMetadataClassification =
	| { readonly kind: "current"; readonly metadata: DurableWorkflowMetadata; readonly generation: number }
	| { readonly kind: "unknown" }
	| { readonly kind: "unavailable" };

export function metadataStepName(ts: number): string {
	return `${METADATA_STEP_PREFIX}:${ts}:${crypto.randomUUID()}`;
}

/** Deterministic first-writer-wins claim id for one observed generation. */
export function claimMetadataStepName(generation: number): string {
	return `${METADATA_STEP_PREFIX}:${generation + 1}:claim`;
}

export function isMetadataStep(stepName: string): boolean {
	return stepName === METADATA_STEP_PREFIX || stepName.startsWith(`${METADATA_STEP_PREFIX}:`);
}

/** Parse one metadata step record, returning current-format metadata only. */
export function parseCurrentMetadataRecord(
	record: DbosStepRecord,
	workflowId: string,
): DurableWorkflowMetadata | undefined {
	const classified = classifyMetadataRecord(record, workflowId);
	return classified.kind === "current" ? classified.metadata : undefined;
}

export function encodeMetadata(metadata: DurableWorkflowMetadata): WorkflowSerializableValue {
	return {
		__atomicDurableMetadata: true,
		version: DURABLE_FORMAT_VERSION,
		metadata: {
			workflowId: metadata.workflowId,
			name: metadata.name,
			inputs: metadata.inputs,
			status: metadata.status,
			createdAt: metadata.createdAt,
			completedCheckpoints: metadata.completedCheckpoints,
			pendingPrompts: metadata.pendingPrompts,
			promptReservationEpoch: metadata.promptReservationEpoch,
			...(metadata.pendingStageMessages !== undefined
				? { pendingStageMessages: serializePendingStageMessages(metadata.pendingStageMessages) }
				: {}),
			...(metadata.possibleStages !== undefined
				? {
						possibleStages: Array.isArray(metadata.possibleStages)
							? [...metadata.possibleStages]
							: metadata.possibleStages,
					}
				: {}),
			...(metadata.ownerExecutorId !== undefined ? { ownerExecutorId: metadata.ownerExecutorId } : {}),
			...(metadata.transitionClaimId !== undefined ? { transitionClaimId: metadata.transitionClaimId } : {}),
			...(metadata.sessionFile !== undefined ? { sessionFile: metadata.sessionFile } : {}),
			...(metadata.label !== undefined ? { label: metadata.label } : {}),
			...(metadata.rootWorkflowId !== undefined ? { rootWorkflowId: metadata.rootWorkflowId } : {}),
			...(metadata.resumable !== undefined ? { resumable: metadata.resumable } : {}),
			...(metadata.exited !== undefined ? { exited: metadata.exited } : {}),
			...(metadata.exitReason !== undefined ? { exitReason: metadata.exitReason } : {}),
			...(metadata.error !== undefined ? { error: metadata.error } : {}),
			...(metadata.failureKind !== undefined ? { failureKind: metadata.failureKind } : {}),
			...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
			...(metadata.failureRecoverability !== undefined
				? { failureRecoverability: metadata.failureRecoverability }
				: {}),
			...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
			...(metadata.failedToolNodeId !== undefined ? { failedToolNodeId: metadata.failedToolNodeId } : {}),
			...(metadata.origin !== undefined ? { origin: metadata.origin } : {}),
			...(metadata.invocationCwd !== undefined ? { invocationCwd: metadata.invocationCwd } : {}),
			...(metadata.workflowCwd !== undefined ? { workflowCwd: metadata.workflowCwd } : {}),
			...(metadata.repositoryRoot !== undefined ? { repositoryRoot: metadata.repositoryRoot } : {}),
			...(metadata.gitWorktreeRoot !== undefined ? { gitWorktreeRoot: metadata.gitWorktreeRoot } : {}),
			updatedAt: metadata.updatedAt,
		},
	};
}

export function classifyLatestMetadata(
	records: readonly DbosStepRecord[],
	workflowId: string,
): DbosMetadataClassification {
	const metadataRecords = records.filter((record) => isMetadataStep(record.stepName));
	if (metadataRecords.length === 0) return { kind: "unavailable" };
	const latest = metadataRecords.reduce((selected, record) =>
		metadataTimestamp(record) >= metadataTimestamp(selected) ? record : selected,
	);
	const latestClassification = classifyMetadataRecord(latest, workflowId);
	if (latestClassification.kind !== "current") return latestClassification;
	const terminals = metadataRecords
		.map((record) => ({ record, classified: classifyMetadataRecord(record, workflowId) }))
		.filter(
			(
				candidate,
			): candidate is {
				record: DbosStepRecord;
				classified: { kind: "current"; metadata: DurableWorkflowMetadata };
			} =>
				candidate.classified.kind === "current" &&
				isAbsorbingDurableStatus(candidate.classified.metadata.status, candidate.classified.metadata.resumable),
		);
	if (terminals.length === 0) {
		return { ...latestClassification, generation: metadataTimestamp(latest) };
	}
	const terminal = terminals.reduce((selected, candidate) =>
		metadataTimestamp(candidate.record) >= metadataTimestamp(selected.record) ? candidate : selected,
	);
	return { ...terminal.classified, generation: metadataTimestamp(terminal.record) };
}

function classifyMetadataRecord(
	record: DbosStepRecord,
	workflowId: string,
): { readonly kind: "current"; readonly metadata: DurableWorkflowMetadata } | { readonly kind: "unknown" } {
	if (typeof record.output !== "object" || record.output === null || Array.isArray(record.output)) {
		return { kind: "unknown" };
	}
	const raw = record.output as Record<string, WorkflowSerializableValue>;
	if (raw.__atomicDurableMetadata !== true || !isCurrentDurableFormat(raw.version)) {
		return { kind: "unknown" };
	}
	const metadata = parseDurableWorkflowMetadata(raw.metadata, workflowId);
	return metadata === undefined ? { kind: "unknown" } : { kind: "current", metadata };
}

function metadataTimestamp(record: DbosStepRecord): number {
	const segment = record.stepName.split(":")[1];
	const fromName = segment === undefined ? Number.NaN : Number(segment);
	return Number.isFinite(fromName) ? fromName : (record.completedAt ?? 0);
}

function parseDurableWorkflowMetadata(
	value: WorkflowSerializableValue | undefined,
	workflowId: string,
): DurableWorkflowMetadata | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const serialized = value as Record<string, WorkflowSerializableValue | undefined>;
	const pendingStageMessages = parsePendingStageMessages(serialized.pendingStageMessages);
	if (pendingStageMessages === null) return undefined;
	// Corrupt possible-stages values are dropped (hydrating as an empty set on
	// read) rather than rejecting the whole record: the scan is advisory (D4).
	const possibleStages = coercePossibleStages(serialized.possibleStages);
	const metadata = value as Partial<DurableWorkflowMetadata>;
	if (
		metadata.workflowId !== workflowId ||
		typeof metadata.workflowId !== "string" ||
		typeof metadata.name !== "string" ||
		typeof metadata.inputs !== "object" ||
		metadata.inputs === null ||
		Array.isArray(metadata.inputs) ||
		typeof metadata.status !== "string" ||
		!isDurableWorkflowStatus(metadata.status) ||
		typeof metadata.completedCheckpoints !== "number" ||
		typeof metadata.createdAt !== "number" ||
		typeof metadata.pendingPrompts !== "number" ||
		typeof metadata.promptReservationEpoch !== "string" ||
		typeof metadata.updatedAt !== "number" ||
		(metadata.ownerExecutorId !== undefined && typeof metadata.ownerExecutorId !== "string") ||
		(metadata.transitionClaimId !== undefined && typeof metadata.transitionClaimId !== "string") ||
		(metadata.sessionFile !== undefined && typeof metadata.sessionFile !== "string") ||
		(metadata.label !== undefined && typeof metadata.label !== "string") ||
		(metadata.rootWorkflowId !== undefined && typeof metadata.rootWorkflowId !== "string") ||
		(metadata.resumable !== undefined && typeof metadata.resumable !== "boolean") ||
		(metadata.exited !== undefined && typeof metadata.exited !== "boolean") ||
		(metadata.exitReason !== undefined && typeof metadata.exitReason !== "string") ||
		(metadata.error !== undefined && typeof metadata.error !== "string") ||
		(metadata.failureKind !== undefined && !isWorkflowFailureKind(metadata.failureKind)) ||
		(metadata.failureCode !== undefined && !isWorkflowFailureCode(metadata.failureCode)) ||
		(metadata.failureRecoverability !== undefined &&
			!isWorkflowFailureRecoverability(metadata.failureRecoverability)) ||
		(metadata.failureDisposition !== undefined && !isWorkflowFailureDisposition(metadata.failureDisposition)) ||
		(metadata.failedToolNodeId !== undefined && typeof metadata.failedToolNodeId !== "string") ||
		(metadata.invocationCwd !== undefined && typeof metadata.invocationCwd !== "string") ||
		(metadata.workflowCwd !== undefined && typeof metadata.workflowCwd !== "string") ||
		(metadata.repositoryRoot !== undefined && typeof metadata.repositoryRoot !== "string") ||
		(metadata.gitWorktreeRoot !== undefined && typeof metadata.gitWorktreeRoot !== "string")
	)
		return undefined;
	const { origin, possibleStages: rawPossibleStages, ...metadataWithoutOrigin } = metadata;
	void rawPossibleStages;
	return {
		...metadataWithoutOrigin,
		pendingStageMessages,
		// Only the validated value re-enters; corrupt shapes were dropped above.
		...(possibleStages !== undefined ? { possibleStages } : {}),
		...(isWorkflowActor(origin) ? { origin } : {}),
	} as DurableWorkflowMetadata;
}

function serializePendingStageMessages(messages: readonly PendingStageMessage[]): WorkflowSerializableValue {
	return messages.map((entry) => ({
		id: entry.id,
		runId: entry.runId,
		stageKey: entry.stageKey,
		...(entry.stageId !== undefined ? { stageId: entry.stageId } : {}),
		...(entry.stageReplayKey !== undefined ? { stageReplayKey: entry.stageReplayKey } : {}),
		...(entry.senderRegistrationName !== undefined ? { senderRegistrationName: entry.senderRegistrationName } : {}),
		...(entry.senderReturnAddress !== undefined ? { senderReturnAddress: entry.senderReturnAddress } : {}),
		from: {
			id: entry.from.id,
			...(entry.from.name !== undefined ? { name: entry.from.name } : {}),
			...(entry.from.group !== undefined ? { group: entry.from.group } : {}),
			...(entry.from.groups !== undefined ? { groups: [...entry.from.groups] } : {}),
			...(entry.from.cwd !== undefined ? { cwd: entry.from.cwd } : {}),
			...(entry.from.model !== undefined ? { model: entry.from.model } : {}),
			...(entry.from.pid !== undefined ? { pid: entry.from.pid } : {}),
			...(entry.from.startedAt !== undefined ? { startedAt: entry.from.startedAt } : {}),
			...(entry.from.lastActivity !== undefined ? { lastActivity: entry.from.lastActivity } : {}),
			...(entry.from.status !== undefined ? { status: entry.from.status } : {}),
		},
		message: {
			id: entry.message.id,
			timestamp: entry.message.timestamp,
			...(entry.message.replyTo !== undefined ? { replyTo: entry.message.replyTo } : {}),
			...(entry.message.expectsReply !== undefined ? { expectsReply: entry.message.expectsReply } : {}),
			...(entry.message.replyError !== undefined ? { replyError: entry.message.replyError } : {}),
			...(entry.message.source !== undefined ? { source: { ...entry.message.source } } : {}),
			content: {
				text: entry.message.content.text,
				...(entry.message.content.attachments !== undefined
					? { attachments: entry.message.content.attachments.map((attachment) => ({ ...attachment })) }
					: {}),
			},
		},
		queuedAt: entry.queuedAt,
		...(entry.admissionOrder !== undefined ? { admissionOrder: entry.admissionOrder } : {}),
		...(entry.sticky === undefined ? {} : { sticky: entry.sticky }),
		...(entry.targetPath === undefined ? {} : { targetPath: entry.targetPath }),
		...(entry.notInKnownSet === undefined ? {} : { notInKnownSet: entry.notInKnownSet }),
		...(entry.deliveries === undefined ? {} : { deliveries: entry.deliveries.map((delivery) => ({ ...delivery })) }),
		...(entry.deliveryCount === undefined ? {} : { deliveryCount: entry.deliveryCount }),
		status: entry.status,
		...(entry.deliveredAt !== undefined ? { deliveredAt: entry.deliveredAt } : {}),
		...(entry.undeliverableReason !== undefined ? { undeliverableReason: entry.undeliverableReason } : {}),
		...(entry.undeliverableNotificationId !== undefined
			? { undeliverableNotificationId: entry.undeliverableNotificationId }
			: {}),
		...(entry.undeliverableNotifiedAt !== undefined
			? { undeliverableNotifiedAt: entry.undeliverableNotifiedAt }
			: {}),
	}));
}

function parsePendingStageMessages(
	value: WorkflowSerializableValue | undefined,
): readonly PendingStageMessage[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(isPendingStageMessage)) return null;
	return value as readonly PendingStageMessage[];
}

function isPendingStageMessage(value: WorkflowSerializableValue): boolean {
	if (!isSerializableObject(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.runId === "string" &&
		typeof value.stageKey === "string" &&
		(value.stageId === undefined || typeof value.stageId === "string") &&
		(value.stageReplayKey === undefined || typeof value.stageReplayKey === "string") &&
		(value.senderRegistrationName === undefined || typeof value.senderRegistrationName === "string") &&
		(value.senderReturnAddress === undefined || typeof value.senderReturnAddress === "string") &&
		typeof value.queuedAt === "string" &&
		(value.admissionOrder === undefined ||
			(typeof value.admissionOrder === "number" &&
				Number.isSafeInteger(value.admissionOrder) &&
				value.admissionOrder > 0)) &&
		(value.sticky === undefined || value.sticky === true) &&
		(value.targetPath === undefined || typeof value.targetPath === "string") &&
		(value.notInKnownSet === undefined || value.notInKnownSet === true) &&
		(value.deliveries === undefined ||
			(Array.isArray(value.deliveries) && value.deliveries.every(isPendingStageDelivery))) &&
		(value.deliveryCount === undefined ||
			(typeof value.deliveryCount === "number" &&
				Number.isSafeInteger(value.deliveryCount) &&
				value.deliveryCount >= 0)) &&
		(value.status === "queued" || value.status === "delivered" || value.status === "undeliverable") &&
		(value.deliveredAt === undefined || typeof value.deliveredAt === "string") &&
		(value.undeliverableReason === undefined || typeof value.undeliverableReason === "string") &&
		(value.undeliverableNotificationId === undefined || typeof value.undeliverableNotificationId === "string") &&
		(value.undeliverableNotifiedAt === undefined || typeof value.undeliverableNotifiedAt === "string") &&
		isPendingStageSender(value.from) &&
		isPendingStageIntercomMessage(value.message)
	);
}

/** Slice 3 sticky-delivery record; immutable once written. */
function isPendingStageDelivery(value: WorkflowSerializableValue): boolean {
	if (!isSerializableObject(value)) return false;
	return (
		typeof value.runId === "string" &&
		typeof value.stageId === "string" &&
		(value.stageName === undefined || typeof value.stageName === "string") &&
		typeof value.deliveredAt === "string"
	);
}

function isPendingStageSender(value: WorkflowSerializableValue | undefined): boolean {
	return (
		isSerializableObject(value) &&
		typeof value.id === "string" &&
		(value.name === undefined || typeof value.name === "string") &&
		(value.group === undefined || typeof value.group === "string") &&
		(value.groups === undefined ||
			(Array.isArray(value.groups) && value.groups.every((group) => typeof group === "string"))) &&
		(value.cwd === undefined || typeof value.cwd === "string") &&
		(value.model === undefined || typeof value.model === "string") &&
		(value.pid === undefined || typeof value.pid === "number") &&
		(value.startedAt === undefined || typeof value.startedAt === "number") &&
		(value.lastActivity === undefined || typeof value.lastActivity === "number") &&
		(value.status === undefined || typeof value.status === "string")
	);
}

function isPendingStageIntercomMessage(value: WorkflowSerializableValue | undefined): boolean {
	if (!isSerializableObject(value) || typeof value.id !== "string" || typeof value.timestamp !== "number")
		return false;
	if (value.replyTo !== undefined && typeof value.replyTo !== "string") return false;
	if (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean") return false;
	if (value.replyError !== undefined && typeof value.replyError !== "string") return false;
	if (!isSerializableObject(value.content) || typeof value.content.text !== "string") return false;
	const attachments = value.content.attachments;
	if (attachments !== undefined && (!Array.isArray(attachments) || !attachments.every(isPendingStageAttachment)))
		return false;
	return value.source === undefined || isPendingStageSource(value.source);
}

function isPendingStageAttachment(value: WorkflowSerializableValue): boolean {
	return (
		isSerializableObject(value) &&
		(value.type === "file" || value.type === "snippet" || value.type === "context") &&
		typeof value.name === "string" &&
		typeof value.content === "string" &&
		(value.language === undefined || typeof value.language === "string")
	);
}

function isPendingStageSource(value: WorkflowSerializableValue): boolean {
	return (
		isSerializableObject(value) &&
		typeof value.subagentRunId === "string" &&
		(value.subagentAgent === undefined || typeof value.subagentAgent === "string") &&
		(value.subagentIndex === undefined || typeof value.subagentIndex === "number")
	);
}

function isSerializableObject(
	value: WorkflowSerializableValue | undefined,
): value is Record<string, WorkflowSerializableValue | undefined> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkflowActor(value: WorkflowSerializableValue | undefined): value is WorkflowActor {
	return value === "user" || value === "agent";
}

function isDurableWorkflowStatus(value: string): value is DurableWorkflowStatus {
	return (
		value === "running" ||
		value === "paused" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "blocked"
	);
}
