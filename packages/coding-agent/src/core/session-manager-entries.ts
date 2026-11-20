import type { ImageContent, Message, TextContent, Usage } from "@bastani/atomic-ai/compat";
import { join } from "path";
import type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type ModelChangeEntry,
	type ModelFallbackRecord,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfoEntry,
	type SessionMessageEntry,
	type SessionNameState,
	type SessionSummaryEntry,
	type ThinkingLevelChangeEntry,
	type WorktreeRestoreHostWarning,
	type WorktreeSnapshotEntry,
} from "./session-manager-types.ts";
import { generateId } from "./session-manager-validation.ts";
import type { WorktreeRootMapping, WorktreeSnapshot, WorktreeUnrestored } from "./worktree-snapshot/types.ts";

function entryBase(
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
): Pick<SessionEntryBase, "id" | "parentId" | "timestamp"> {
	return {
		id: generateId(byId),
		parentId,
		timestamp: new Date().toISOString(),
	};
}

const kindOf = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

/**
 * Check an extension-supplied `customType` before it is stored, so the session can be read back (#6097).
 */
export function checkedCustomType(customType: unknown, owner: "custom entry" | "custom message"): string {
	if (typeof customType !== "string")
		throw new TypeError(`A ${owner} customType must be a string, not ${kindOf(customType)}`);
	return customType;
}

/** Custom message content as the session stores it: text or content blocks, and empty when left out (#6097). */
export function checkedCustomMessageContent(content: unknown): string | (TextContent | ImageContent)[] {
	if (content === undefined || content === null) return [];
	if (typeof content === "string" || Array.isArray(content)) return content;
	throw new TypeError(
		`A custom message content must be a string or an array of content blocks, not ${kindOf(content)}`,
	);
}

/**
 * A custom message as the session stores it (#6097): `customType` and content are checked, and `display` is read the
 * way the chat has always read it, by truthiness, so a missing `display` is false.
 */
export function checkedCustomMessage<T>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
): Pick<CustomMessage<T>, "customType" | "content" | "display" | "details"> {
	return {
		customType: checkedCustomType(message.customType, "custom message"),
		content: checkedCustomMessageContent(message.content),
		display: Boolean(message.display),
		details: message.details,
	};
}

/** Check a label before it is stored, so the session can be read back (#6097). */
export function checkedLabel(label: unknown): string | undefined {
	if (label === undefined || typeof label === "string") return label;
	throw new TypeError(`A label must be a string or undefined, not ${kindOf(label)}`);
}

export function createSessionHeader(
	id: string,
	cwd: string,
	timestamp: string = new Date().toISOString(),
	parentSession?: string,
): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		createdAt: timestamp,
		cwd,
		...(parentSession === undefined ? {} : { parentSessionId: parentSession }),
	};
}

export function createSessionFilePath(sessionDir: string, timestamp: string, sessionId: string): string {
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	return join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
}

export function createMessageEntry(
	message: Message | CustomMessage | BashExecutionMessage,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
): SessionMessageEntry {
	return {
		type: "message",
		...entryBase(byId, parentId),
		message,
	};
}

export function createThinkingLevelChangeEntry(
	thinkingLevel: string,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
): ThinkingLevelChangeEntry {
	return {
		type: "thinking_level_change",
		...entryBase(byId, parentId),
		thinkingLevel,
	};
}

export function createModelChangeEntry(
	provider: string,
	modelId: string,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
	fallback?: ModelFallbackRecord,
): ModelChangeEntry {
	return {
		type: "model_change",
		...entryBase(byId, parentId),
		provider,
		modelId,
		...(fallback === undefined ? {} : { fallback }),
	};
}

export function createCompactionEntry(
	compactedText: string,
	firstKeptEntryId: string | null,
	tokensBefore: number,
	details: VerbatimCompactionDetails,
	usage: Usage | undefined,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
	coveredThroughEntryId?: string,
): CompactionEntry<VerbatimCompactionDetails> {
	return {
		type: "compaction",
		...entryBase(byId, parentId),
		summary: compactedText,
		firstKeptEntryId,
		tokensBefore,
		...(coveredThroughEntryId === undefined ? {} : { coveredThroughEntryId }),
		details,
		usage,
		fromHook: details.backend === "extension" || undefined,
	};
}

export function createContextEditEntry(
	targetId: string,
	replacement: ContextEditEntry["replacement"],
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
): ContextEditEntry {
	return {
		type: "context_edit",
		...entryBase(byId, parentId),
		targetId,
		replacement,
	};
}

export function createCustomEntry(
	customType: string,
	data: unknown,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
): CustomEntry {
	return {
		type: "custom",
		customType: checkedCustomType(customType, "custom entry"),
		data,
		...entryBase(byId, parentId),
	};
}

export function createSessionInfoEntry(
	name: string,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
): SessionInfoEntry {
	return {
		type: "session_info",
		...entryBase(byId, parentId),
		name: name.trim(),
	};
}

export function createWorktreeSnapshotEntry(
	root: string,
	snapshotId: string,
	snapshot: WorktreeSnapshot | undefined,
	restore: WorktreeRootMapping | undefined,
	restoreWarnings: readonly WorktreeRestoreHostWarning[],
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
	unrestored?: WorktreeUnrestored,
	captureMs?: number,
	degradedFrom?: string,
): WorktreeSnapshotEntry {
	return {
		type: "worktree_snapshot",
		...entryBase(byId, parentId),
		root,
		snapshotId,
		...(snapshot === undefined ? {} : { snapshot }),
		...(restore === undefined ? {} : { restore }),
		...(restoreWarnings.length === 0 ? {} : { restoreWarnings: [...restoreWarnings] }),
		...(unrestored === undefined ? {} : { unrestored }),
		...(captureMs === undefined ? {} : { captureMs }),
		...(degradedFrom === undefined ? {} : { degradedFrom }),
	};
}

export function createSessionSummaryEntry(
	summary: string,
	summarizedThroughId: string,
	usage: Usage | undefined,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
): SessionSummaryEntry {
	return {
		type: "session_summary",
		...entryBase(byId, parentId),
		summary: summary.trim(),
		summarizedThroughId,
		usage,
	};
}

/**
 * Anchor for a session summary: the newest user/assistant message entry.
 *
 * Both sides of the freshness check call this so they cannot drift apart. Tool results and
 * non-message entries are ignored, and an assistant turn made only of tool calls still counts —
 * it carries no text, but it is a real conversation step.
 */
export function getLastConversationMessageId(entries: FileEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const role = entry.message.role;
		if (role === "user" || role === "assistant") return entry.id;
	}
	return undefined;
}

/**
 * Latest generated resume summary that has not been retired, entry and all.
 *
 * Returns the entry rather than its text: callers need `summarizedThroughId` alongside the
 * summary to decide whether it still describes the conversation.
 *
 * A `branch_summary` written afterwards retires it, because the branch it described was
 * abandoned. Both the picker and the generation guard call this, so a retired summary is hidden
 * from the picker *and* lets a replacement be generated; splitting the two rules leaves such a
 * session showing fallback text forever.
 */
export function getLatestSessionSummary(entries: FileEntry[]): SessionSummaryEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary") return undefined;
		if (entry.type === "session_summary") return entry;
	}
	return undefined;
}

export function getLatestSessionName(entries: readonly FileEntry[]): SessionNameState {
	// Walk entries in reverse to find the latest session_info entry. An existing entry
	// with an empty name is an explicit clear, not a never-named session: the fact that
	// a session was named is separate from the name it currently holds (upstream 7bdb16c2).
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "session_info") {
			const name = entry.name?.trim() || undefined;
			return { hasName: true, ...(name !== undefined ? { name } : {}) };
		}
	}
	return { hasName: false };
}

export function createCustomMessageEntry<T = unknown>(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: T | undefined,
	excludeFromContext: boolean | undefined,
	protectedReconciliation: CustomMessageEntry["protectedReconciliation"],
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
	stageAdmissionKey?: string,
): CustomMessageEntry<T> {
	return {
		type: "custom_message",
		...checkedCustomMessage({ customType, content, display, details }),
		...(excludeFromContext === true ? { excludeFromContext: true } : {}),
		...(stageAdmissionKey === undefined ? {} : { stageAdmissionKey }),
		...(protectedReconciliation === undefined ? {} : { protectedReconciliation }),
		...entryBase(byId, parentId),
	};
}

export function createLabelEntry(
	targetId: string,
	label: string | undefined,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
	parentId: string | null,
	timestamp?: string,
): LabelEntry {
	return {
		type: "label",
		...entryBase(byId, parentId),
		...(timestamp !== undefined ? { timestamp } : {}),
		targetId,
		label: checkedLabel(label),
	};
}

export function createBranchSummaryEntry(
	branchFromId: string | null,
	fromId: string,
	summary: string,
	details: unknown,
	usage: Usage | undefined,
	fromHook: boolean | undefined,
	byId: { has(id: string): boolean; preferFullIds?: boolean },
): BranchSummaryEntry {
	return {
		type: "branch_summary",
		...entryBase(byId, branchFromId),
		fromId,
		summary,
		details,
		usage,
		fromHook,
	};
}

export function getEntriesWithoutHeader(fileEntries: FileEntry[]): SessionEntry[] {
	return fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
}
