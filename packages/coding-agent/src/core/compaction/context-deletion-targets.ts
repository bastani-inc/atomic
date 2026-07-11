import type { ContextDeletionTarget } from "../session-manager.ts";
import type {
	CompactableContentBlock,
	CompactableTranscript,
	CompactableTranscriptEntry,
	ContextDeletionRequest,
} from "./context-compaction-types.ts";
import { getTranscriptCompactionParameters } from "./context-compaction-strategy.ts";
import {
	analyzeCompactableAssistantTurns,
	assistantEntryHasThinkingContentBlock,
	compactableContentBlockIsLlmVisible,
	transcriptEntryStartsNewTurn,
} from "./context-assistant-turns.js";

interface AssistantTurnDeletionViolation {
	entryId: string;
	active: boolean;
}

function findAssistantTurnDeletionViolation(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): AssistantTurnDeletionViolation | undefined {
	const { deletedEntryIds, turns } = analyzeCompactableAssistantTurns(transcript, targets);
	for (const turn of turns) {
		if (turn.signedThinkingEntryIds.length === 0) continue;
		const deleted = turn.signedThinkingEntryIds.filter((entryId) => deletedEntryIds.has(entryId));
		if (turn.active && deleted.length > 0) return { entryId: deleted[0]!, active: true };
		if (!turn.active && deleted.length > 0 && deleted.length < turn.signedThinkingEntryIds.length) {
			return { entryId: deleted[0]!, active: false };
		}
	}
	return undefined;
}

export function targetKey(target: ContextDeletionTarget): string {
	return target.kind === "entry" ? `entry:${target.entryId}` : `content_block:${target.entryId}:${target.blockIndex}`;
}

export function rawTargetKey(target: ContextDeletionRequest["deletions"][number]): string {
	return target.kind === "entry" ? `entry:${target.entryId}` : `content_block:${target.entryId}:${target.blockIndex}`;
}

export function normalizeRawTarget(target: ContextDeletionRequest["deletions"][number]): ContextDeletionTarget {
	if (target.kind === "entry") return { kind: "entry", entryId: target.entryId };
	return { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex as number };
}

export function assertIdOnlyDeletionTarget(target: Record<string, unknown>): void {
	const allowedKeys = target.kind === "content_block" ? new Set(["kind", "entryId", "blockIndex"]) : new Set(["kind", "entryId"]);
	for (const key of Object.keys(target)) {
		if (!allowedKeys.has(key)) {
			throw new Error(
				`Deletion target includes unsupported property ${JSON.stringify(key)}; context deletion targets are id-only and must contain only kind, entryId${target.kind === "content_block" ? ", and blockIndex" : ""}`,
			);
		}
	}
}

export function rawDeletionFromTarget(target: ContextDeletionTarget): ContextDeletionRequest["deletions"][number] {
	if (target.kind === "entry") return { kind: "entry", entryId: target.entryId };
	return { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex };
}

export function deletionRequestFromTargets(targets: readonly ContextDeletionTarget[]): ContextDeletionRequest {
	return { deletions: targets.map(rawDeletionFromTarget) };
}

export function getDeletedEntryIds(targets: readonly ContextDeletionTarget[]): Set<string> {
	return new Set(targets.filter((target) => target.kind === "entry").map((target) => target.entryId));
}

export function getDeletedContentBlocks(targets: readonly ContextDeletionTarget[]): Map<string, Set<number>> {
	const blocksByEntry = new Map<string, Set<number>>();
	for (const target of targets) {
		if (target.kind !== "content_block") continue;
		const blocks = blocksByEntry.get(target.entryId) ?? new Set<number>();
		blocks.add(target.blockIndex);
		blocksByEntry.set(target.entryId, blocks);
	}
	return blocksByEntry;
}

export function recentContextEntryBoundary(transcript: CompactableTranscript): number {
	const { preserve_recent } = getTranscriptCompactionParameters(transcript);
	return preserve_recent > 0 ? Math.max(0, transcript.entries.length - preserve_recent) : transcript.entries.length;
}

export function getRecentContextEntryIds(transcript: CompactableTranscript): Set<string> {
	const { preserve_recent } = getTranscriptCompactionParameters(transcript);
	if (preserve_recent <= 0) return new Set();
	return new Set(transcript.entries.slice(recentContextEntryBoundary(transcript)).map((entry) => entry.entryId));
}

export function isRecentContextEntry(entry: CompactableTranscriptEntry, transcript: CompactableTranscript): boolean {
	const { preserve_recent } = getTranscriptCompactionParameters(transcript);
	if (preserve_recent <= 0) return false;
	const entryIndex = transcript.entries.findIndex((candidate) => candidate.entryId === entry.entryId);
	return entryIndex >= 0 && entryIndex >= recentContextEntryBoundary(transcript);
}

export function formatRecentContextDeletionError(transcript: CompactableTranscript, target: ContextDeletionTarget): string {
	const { preserve_recent } = getTranscriptCompactionParameters(transcript);
	const recentWindow = `last ${preserve_recent} context ${preserve_recent === 1 ? "entry" : "entries"}`;
	if (target.kind === "entry") {
		return `Cannot delete recent context entry ${target.entryId} because the ${recentWindow} must remain available for active continuity. Choose an older entry.`;
	}
	return `Cannot delete content block ${target.entryId}:${target.blockIndex} because entry ${target.entryId} is one of the ${recentWindow} that must remain available for active continuity. Choose an older entry or content block.`;
}

export function deletionGuidance(): string {
	return "Choose another deletion candidate.";
}

export function findTranscriptEntry(transcript: CompactableTranscript, entryId: string): CompactableTranscriptEntry | undefined {
	return transcript.entries.find((entry) => entry.entryId === entryId);
}

export function findTranscriptContentBlock(
	transcript: CompactableTranscript,
	target: ContextDeletionTarget,
): CompactableContentBlock | undefined {
	if (target.kind !== "content_block") return undefined;
	return findTranscriptEntry(transcript, target.entryId)?.contentBlocks.find((block) => block.blockIndex === target.blockIndex);
}

export function firstToolCallBlockTarget(
	entry: CompactableTranscriptEntry,
	callId: string,
): ContextDeletionTarget | undefined {
	const blockIndex = toolCallBlockIndexes(entry, callId)[0];
	return blockIndex === undefined ? undefined : { kind: "content_block", entryId: entry.entryId, blockIndex };
}

export function formatProtectedDeletionError(transcript: CompactableTranscript, target: ContextDeletionTarget): string {
	const entry = findTranscriptEntry(transcript, target.entryId);
	if (target.kind === "entry") {
		const toolResultSuffix = entry?.toolResultFor ? ` for tool call ${entry.toolResultFor}` : "";
		const toolCallSuffix = entry && entry.toolCallIds.length > 0 ? ` containing tool call ${entry.toolCallIds.join(", ")}` : "";
		return `Deletion target ${target.entryId}${toolResultSuffix}${toolCallSuffix} is protected. ${deletionGuidance()}`;
	}

	const block = findTranscriptContentBlock(transcript, target);
	const toolBlockSuffix = block?.toolCallId ? ` It is a protected tool block for tool call ${block.toolCallId}.` : "";
	return `Content block ${target.entryId}:${target.blockIndex} is protected.${toolBlockSuffix} ${deletionGuidance()}`;
}

export function formatProtectedToolDependencyError(
	transcript: CompactableTranscript,
	blockedTarget: ContextDeletionTarget,
	context: string,
): string {
	const protectedMessage = formatProtectedDeletionError(transcript, blockedTarget);
	return `${context} ${protectedMessage}`;
}

export function isProtectedContextDeletionErrorMessage(message: string): boolean {
	return (
		/\bprotected\b/i.test(message) ||
		/Cannot delete (?:recent context entry|content block .* because entry .* is one of the last)/u.test(message) ||
		/latest assistant message|active assistant tool-use turn|completed assistant tool-use turn|thinking\/redacted_thinking block in (?:the latest|a retained) assistant message/u.test(message)
	);
}

export function assertNoRecentContextDeletionTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): void {
	const recentEntryIds = getRecentContextEntryIds(transcript);
	for (const target of targets) {
		if (recentEntryIds.has(target.entryId)) {
			throw new Error(formatRecentContextDeletionError(transcript, target));
		}
	}
}

export function latestAssistantEntry(
	transcript: CompactableTranscript,
	deletedEntryIds: ReadonlySet<string> = new Set<string>(),
): CompactableTranscriptEntry | undefined {
	for (let index = transcript.entries.length - 1; index >= 0; index--) {
		const entry = transcript.entries[index];
		if (entry.role === "assistant" && !deletedEntryIds.has(entry.entryId)) return entry;
	}
	return undefined;
}

export function findAssistantThinkingContentBlockDeletionViolation(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): Extract<ContextDeletionTarget, { kind: "content_block" }> | undefined {
	const deletedEntryIds = getDeletedEntryIds(targets);
	for (const target of targets) {
		if (target.kind !== "content_block") continue;
		if (deletedEntryIds.has(target.entryId)) continue;
		const entry = findTranscriptEntry(transcript, target.entryId);
		if (entry && assistantEntryHasThinkingContentBlock(entry)) return target;
	}
	return undefined;
}

export function findLatestAssistantThinkingDeletionViolation(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): ContextDeletionTarget | undefined {
	const violation = findAssistantTurnDeletionViolation(transcript, targets);
	if (!violation) return undefined;
	return targets.find((target) => target.kind === "entry" && target.entryId === violation.entryId);
}

export function assertNoAssistantThinkingContentBlockDeletionTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): void {
	const violation = findAssistantThinkingContentBlockDeletionViolation(transcript, targets);
	if (!violation) return;
	throw new Error(
		`Cannot delete content block ${violation.entryId}:${violation.blockIndex} because a thinking/redacted_thinking block in a retained assistant message must remain unmodified; retained assistant messages containing thinking/redacted_thinking content blocks are all-or-nothing`,
	);
}

export function assertNoLatestAssistantThinkingDeletionTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): void {
	const violation = findAssistantTurnDeletionViolation(transcript, targets);
	if (!violation) return;
	if (violation.active) {
		throw new Error(
			`Cannot delete assistant entry ${violation.entryId} because the active assistant tool-use turn must retain every thinking/redacted_thinking-bearing assistant entry`,
		);
	}
	throw new Error(
		`Cannot delete assistant entry ${violation.entryId} because a completed assistant tool-use turn must retain all or omit all thinking/redacted_thinking-bearing assistant entries`,
	);
}

export function isToolCallBlockDeleted(
	entry: CompactableTranscriptEntry,
	callId: string,
	deletedEntryIds: ReadonlySet<string>,
	deletedContentBlocks: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
	if (deletedEntryIds.has(entry.entryId)) return true;
	const deletedBlocks = deletedContentBlocks.get(entry.entryId);
	if (!deletedBlocks) return false;
	return entry.contentBlocks.some((block) => block.toolCallId === callId && deletedBlocks.has(block.blockIndex));
}

export function toolCallBlockIndexes(entry: CompactableTranscriptEntry, callId: string): number[] {
	return entry.contentBlocks
		.filter((block) => block.toolCallId === callId)
		.map((block) => block.blockIndex);
}

export function addTarget(targets: ContextDeletionTarget[], target: ContextDeletionTarget): boolean {
	if (targets.some((existing) => targetKey(existing) === targetKey(target))) return false;
	targets.push(target);
	return true;
}

export function deleteEntryTarget(targets: ContextDeletionTarget[], entryId: string): boolean {
	let changed = false;
	for (let index = targets.length - 1; index >= 0; index--) {
		const target = targets[index];
		if (target.kind === "content_block" && target.entryId === entryId) {
			targets.splice(index, 1);
			changed = true;
		}
	}
	return addTarget(targets, { kind: "entry", entryId }) || changed;
}

export function mergeContextDeletionTargets(
	baseTargets: readonly ContextDeletionTarget[],
	additionalTargets: readonly ContextDeletionTarget[],
): ContextDeletionTarget[] {
	const targets = [...baseTargets];
	for (const target of additionalTargets) {
		if (target.kind === "entry") {
			deleteEntryTarget(targets, target.entryId);
			continue;
		}
		if (!getDeletedEntryIds(targets).has(target.entryId)) {
			addTarget(targets, target);
		}
	}
	return targets;
}

export function canonicalizeEntryTargets(
	transcript: CompactableTranscript,
	targets: ContextDeletionTarget[],
	entry: CompactableTranscriptEntry,
): boolean {
	if (!canDeleteTarget(transcript, { kind: "entry", entryId: entry.entryId })) return false;
	if (getDeletedEntryIds(targets).has(entry.entryId)) return false;
	const deletedBlocks = getDeletedContentBlocks(targets).get(entry.entryId);
	if (!deletedBlocks || !entry.contentBlocks.every((block) => deletedBlocks.has(block.blockIndex))) return false;
	// Only repair/promote when dependency reconciliation reaches this entry. Non-tool entries that
	// request every block individually stay invalid so the assistant must choose explicit entry deletion.
	return deleteEntryTarget(targets, entry.entryId);
}

export function addToolCallDeletion(
	transcript: CompactableTranscript,
	targets: ContextDeletionTarget[],
	entry: CompactableTranscriptEntry,
	callId: string,
): boolean {
	if (assistantEntryHasThinkingContentBlock(entry)) {
		if (!canDeleteTarget(transcript, { kind: "entry", entryId: entry.entryId })) return false;
		return deleteEntryTarget(targets, entry.entryId);
	}

	let changed = false;
	for (const blockIndex of toolCallBlockIndexes(entry, callId)) {
		const target: ContextDeletionTarget = { kind: "content_block", entryId: entry.entryId, blockIndex };
		if (!canDeleteTarget(transcript, target)) continue;
		if (!getDeletedEntryIds(targets).has(entry.entryId)) {
			changed = addTarget(targets, target) || changed;
		}
	}
	return canonicalizeEntryTargets(transcript, targets, entry) || changed;
}

/** Whether a task-bearing entry remains provider-visible after proposed block deletions. */
export function isTaskBearingEntry(
	entry: CompactableTranscriptEntry,
	deletedContentBlocks: ReadonlySet<number> = new Set<number>(),
): boolean {
	const taskRole =
		entry.role === "user" ||
		entry.role === "custom" ||
		entry.role === "branchSummary" ||
		entry.entryType === "branch_summary";
	return taskRole && transcriptEntryStartsNewTurn(entry, deletedContentBlocks);
}

export function isRecentTarget(transcript: CompactableTranscript, target: ContextDeletionTarget): boolean {
	const entry = transcript.entries.find((candidate) => candidate.entryId === target.entryId);
	return entry !== undefined && isRecentContextEntry(entry, transcript);
}

export function isStaleUserImageOnlyEntry(transcript: CompactableTranscript, entry: CompactableTranscriptEntry): boolean {
	if (entry.role !== "user" || isRecentContextEntry(entry, transcript)) return false;
	const visibleBlocks = entry.contentBlocks.filter((block) => compactableContentBlockIsLlmVisible(entry, block));
	if (visibleBlocks.length === 0 || !visibleBlocks.every((block) => block.type === "image")) return false;
	return transcript.entries.some(
		(candidate) => candidate.entryId !== entry.entryId && isTaskBearingEntry(candidate),
	);
}

export function canDeleteStaleUserImageContentBlock(
	transcript: CompactableTranscript,
	target: ContextDeletionTarget,
): boolean {
	if (target.kind !== "content_block") return false;
	const entry = transcript.entries.find((candidate) => candidate.entryId === target.entryId);
	if (!entry || entry.role !== "user" || isRecentTarget(transcript, target)) return false;
	const block = entry.contentBlocks.find((candidate) => candidate.blockIndex === target.blockIndex);
	if (!block || block.type !== "image") return false;
	return entry.contentBlocks.some(
		(candidate) =>
			candidate.blockIndex !== target.blockIndex &&
			candidate.type !== "image" &&
			compactableContentBlockIsLlmVisible(entry, candidate),
	);
}

export function canDeleteTarget(transcript: CompactableTranscript, target: ContextDeletionTarget): boolean {
	const entry = transcript.entries.find((candidate) => candidate.entryId === target.entryId);
	if (!entry) return false;
	if (isRecentTarget(transcript, target)) return false;
	if (target.kind === "entry") return isStaleUserImageOnlyEntry(transcript, entry) || !entry.protected;
	const block = entry.contentBlocks.find((candidate) => candidate.blockIndex === target.blockIndex);
	if (!block) return false;
	if (canDeleteStaleUserImageContentBlock(transcript, target)) return true;
	if (entry.protected) return false;
	return !block.protected;
}

