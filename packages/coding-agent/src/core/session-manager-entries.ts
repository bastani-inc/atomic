import type { ImageContent, Message, TextContent, Usage } from "@earendil-works/pi-ai/compat";
import { join } from "path";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
import { validSessionWorkflowMetadata } from "./session-manager-classification.ts";
import {
	CURRENT_SESSION_VERSION,
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextWindowChangeEntry,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfoEntry,
	type SessionMessageEntry,
	type SessionWorkflowMetadata,
	type ThinkingLevelChangeEntry,
} from "./session-manager-types.ts";
import { generateId } from "./session-manager-validation.ts";

function entryBase(byId: { has(id: string): boolean }, parentId: string | null): Pick<SessionEntryBase, "id" | "parentId" | "timestamp"> {
	return {
		id: generateId(byId),
		parentId,
		timestamp: new Date().toISOString(),
	};
}

export function createSessionHeader(
	id: string,
	cwd: string,
	timestamp: string = new Date().toISOString(),
	parentSession?: string,
	internal?: boolean,
	workflow?: SessionWorkflowMetadata,
): SessionHeader {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp,
		cwd,
	};
	if (parentSession !== undefined) header.parentSession = parentSession;
	const validWorkflow = internal === true ? validSessionWorkflowMetadata(workflow) : undefined;
	if (validWorkflow) {
		header.internal = true;
		header.workflow = validWorkflow;
	}
	return header;
}

export function createSessionFilePath(sessionDir: string, timestamp: string, sessionId: string): string {
	const fileTimestamp = timestamp.replace(/[:.]/g, "-");
	return join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
}

export function createMessageEntry(
	message: Message | CustomMessage | BashExecutionMessage,
	byId: { has(id: string): boolean },
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
	byId: { has(id: string): boolean },
	parentId: string | null,
): ThinkingLevelChangeEntry {
	return {
		type: "thinking_level_change",
		...entryBase(byId, parentId),
		thinkingLevel,
	};
}

export function createContextWindowChangeEntry(
	contextWindow: number,
	byId: { has(id: string): boolean },
	parentId: string | null,
): ContextWindowChangeEntry {
	return {
		type: "context_window_change",
		...entryBase(byId, parentId),
		contextWindow,
	};
}

export function createModelChangeEntry(
	provider: string,
	modelId: string,
	byId: { has(id: string): boolean },
	parentId: string | null,
): ModelChangeEntry {
	return {
		type: "model_change",
		...entryBase(byId, parentId),
		provider,
		modelId,
	};
}

export function createCompactionEntry(
	compactedText: string,
	firstKeptEntryId: string | null,
	tokensBefore: number,
	details: VerbatimCompactionDetails,
	byId: { has(id: string): boolean },
	parentId: string | null,
): CompactionEntry<VerbatimCompactionDetails> {
	return {
		type: "compaction",
		...entryBase(byId, parentId),
		summary: compactedText,
		firstKeptEntryId,
		tokensBefore,
		details,
		fromHook: details.rung === "extension" || undefined,
	};
}


export function createCustomEntry(
	customType: string,
	data: unknown,
	byId: { has(id: string): boolean },
	parentId: string | null,
): CustomEntry {
	return {
		type: "custom",
		customType,
		data,
		...entryBase(byId, parentId),
	};
}

export function createSessionInfoEntry(
	name: string,
	byId: { has(id: string): boolean },
	parentId: string | null,
): SessionInfoEntry {
	return {
		type: "session_info",
		...entryBase(byId, parentId),
		name: name.trim(),
	};
}

export function getLatestSessionName(entries: SessionEntry[]): string | undefined {
	// Walk entries in reverse to find the latest session_info entry.
	// Empty names explicitly clear the session title.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "session_info") {
			return entry.name?.trim() || undefined;
		}
	}
	return undefined;
}

export function createCustomMessageEntry<T = unknown>(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: T | undefined,
	excludeFromContext: boolean | undefined,
	byId: { has(id: string): boolean },
	parentId: string | null,
): CustomMessageEntry<T> {
	return {
		type: "custom_message",
		customType,
		content,
		display,
		details,
		...(excludeFromContext === true ? { excludeFromContext: true } : {}),
		...entryBase(byId, parentId),
	};
}

export function createLabelEntry(
	targetId: string,
	label: string | undefined,
	byId: { has(id: string): boolean },
	parentId: string | null,
	timestamp?: string,
): LabelEntry {
	return {
		type: "label",
		...entryBase(byId, parentId),
		...(timestamp !== undefined ? { timestamp } : {}),
		targetId,
		label,
	};
}

export function createBranchSummaryEntry(
	branchFromId: string | null,
	summary: string,
	details: unknown,
	usage: Usage | undefined,
	fromHook: boolean | undefined,
	byId: { has(id: string): boolean },
): BranchSummaryEntry {
	return {
		type: "branch_summary",
		...entryBase(byId, branchFromId),
		fromId: branchFromId ?? "root",
		summary,
		details,
		usage,
		fromHook,
	};
}

export function getEntriesWithoutHeader(fileEntries: FileEntry[]): SessionEntry[] {
	return fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
}
