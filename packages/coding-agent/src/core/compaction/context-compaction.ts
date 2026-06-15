import { Agent, type AgentMessage, type AgentTool, type AgentToolResult, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	isContextOverflow,
	streamSimple,
	StringEnum,
} from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createBranchSummaryMessage, createCustomMessage } from "../messages.ts";
import {
	isAssistantThinkingBlockType,
	messageHasAssistantThinkingContentBlock,
} from "../thinking-blocks.ts";
import {
	buildContextDeletionFilteredPath,
	buildEffectiveContextDeletionFilters,
	type ContextCompactionStats,
	type ContextDeletionTarget,
	type SessionEntry,
} from "../session-manager.ts";
import type { CompactionSettings } from "./compaction.ts";
import { estimateTokens } from "./compaction.ts";

export const CONTEXT_COMPACTION_PROMPT_VERSION = 1 as const;

export type ContextCompactionMode = "standard" | "critical_overflow";

export interface ContextDeletionRequest {
	deletions: Array<{
		kind: "entry" | "content_block";
		entryId: string;
		blockIndex?: number;
		rationale?: string;
	}>;
}

export interface CompactableContentBlock {
	entryId: string;
	blockIndex: number;
	type: string;
	text: string;
	tokenEstimate: number;
	protected: boolean;
	toolCallId?: string;
}

export interface CompactableTranscriptEntry {
	entryId: string;
	entryType: SessionEntry["type"];
	role: AgentMessage["role"];
	text: string;
	tokenEstimate: number;
	protected: boolean;
	contentBlocks: CompactableContentBlock[];
	message: AgentMessage;
	toolCallIds: string[];
	toolResultFor?: string;
}

export interface CompactableTranscript {
	entries: CompactableTranscriptEntry[];
	protectedEntryIds: string[];
	tokensBefore: number;
	settings: CompactionSettings;
}

export interface ContextCompactionPreparation {
	transcript: CompactableTranscript;
	branchEntries: SessionEntry[];
	mode?: ContextCompactionMode;
}

export interface ValidatedContextDeletionResult {
	deletedTargets: ContextDeletionTarget[];
	protectedEntryIds: string[];
	stats: ContextCompactionStats;
}

export interface ContextCompactionResult extends ValidatedContextDeletionResult {
	promptVersion: typeof CONTEXT_COMPACTION_PROMPT_VERSION;
	backupPath?: string;
}

const CONTEXT_DELETE_TOOL_NAME = "context_delete";
const CONTEXT_GREP_DELETE_TOOL_NAME = "context_grep_delete";
const CONTEXT_SEARCH_TRANSCRIPT_TOOL_NAME = "context_search_transcript";
const CONTEXT_READ_ENTRY_TOOL_NAME = "context_read_entry";
export const CONTEXT_COMPACTION_MAX_TURNS = 50 as const;
const CONTEXT_GREP_DELETE_DEFAULT_MAX_MATCHES = 50;
const CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS = 512;
const CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS = 250_000;
const CONTEXT_MANIFEST_MAX_ENTRIES = 80;
const CONTEXT_MANIFEST_PREVIEW_CHARS = 240;
const CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT = 5;
const CONTEXT_READ_ENTRY_DEFAULT_MAX_CHARS = 4000;
const CONTEXT_READ_ENTRY_MAX_CHARS = 12_000;
const CONTEXT_SEARCH_DEFAULT_MAX_MATCHES = 20;
const CONTEXT_SEARCH_MAX_MATCHES = 100;
const CONTEXT_SEARCH_DEFAULT_CONTEXT_CHARS = 160;
const CONTEXT_SEARCH_MAX_CONTEXT_CHARS = 500;

const ContextDeleteToolParameters = Type.Object(
	{
		deletions: Type.Array(
			Type.Object(
				{
					kind: StringEnum(["entry", "content_block"] as const, {
						description: "Delete an entire transcript entry or a single content block within one entry.",
					}),
					entryId: Type.String({ minLength: 1, description: "Stable transcript entry id to delete from." }),
					blockIndex: Type.Optional(
						Type.Integer({
							minimum: 0,
							description: "Required when kind is content_block; omit when kind is entry.",
						}),
					),
				},
				{ additionalProperties: false },
			),
			{ description: "Deletion targets only. Protected entries and recent active context must not be included." },
		),
	},
	{ additionalProperties: false },
);

const ContextGrepDeleteToolParameters = Type.Object(
	{
		pattern: Type.String({ minLength: 1, description: "Literal text or regular expression to match in transcript text." }),
		regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a JavaScript regular expression. Defaults to false." })),
		caseSensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching. Defaults to false." })),
		target: Type.Optional(
			StringEnum(["entry", "content_block"] as const, {
				description: "Delete whole matching entries or matching content blocks. Defaults to entry.",
			}),
		),
		maxMatches: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 200,
				description:
					"Safety cap. If more unprotected, not-yet-deleted candidate targets are found, no deletions are applied. Defaults to 50.",
			}),
		),
		expectedMatchCount: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "Optional safety check. If the match count differs, no deletions are applied.",
			}),
		),
	},
	{ additionalProperties: false },
);

const ContextSearchTranscriptToolParameters = Type.Object(
	{
		pattern: Type.String({ minLength: 1, description: "Literal text or regular expression to search for." }),
		regex: Type.Optional(Type.Boolean({ description: "Treat pattern as a JavaScript regular expression. Defaults to false." })),
		caseSensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching. Defaults to false." })),
		target: Type.Optional(
			StringEnum(["entry", "content_block"] as const, {
				description: "Search whole entry text or individual content-block text. Defaults to entry.",
			}),
		),
		maxMatches: Type.Optional(
			Type.Integer({ minimum: 1, maximum: CONTEXT_SEARCH_MAX_MATCHES, description: "Maximum matches to return. Defaults to 20." }),
		),
		contextChars: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: CONTEXT_SEARCH_MAX_CONTEXT_CHARS,
				description: "Characters of context to include before and after each match. Defaults to 160.",
			}),
		),
	},
	{ additionalProperties: false },
);

const ContextReadEntryToolParameters = Type.Object(
	{
		entryId: Type.String({ minLength: 1, description: "Stable transcript entry id to read." }),
		blockIndex: Type.Optional(
			Type.Integer({ minimum: 0, description: "Optional content block index to read instead of the whole entry text." }),
		),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to begin reading. Defaults to 0." })),
		maxChars: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: CONTEXT_READ_ENTRY_MAX_CHARS,
				description: "Maximum characters to return. Defaults to 4000; keep reads small to avoid overflowing context.",
			}),
		),
	},
	{ additionalProperties: false },
);

const CONTEXT_DELETE_TOOL = {
	name: CONTEXT_DELETE_TOOL_NAME,
	description: "Record context compaction deletion targets directly against the transcript.",
	parameters: ContextDeleteToolParameters,
} as const;

const CONTEXT_GREP_DELETE_TOOL = {
	name: CONTEXT_GREP_DELETE_TOOL_NAME,
	description: "Bulk-delete transcript entries or content blocks matching a guarded grep/regex query.",
	parameters: ContextGrepDeleteToolParameters,
} as const;

const CONTEXT_SEARCH_TRANSCRIPT_TOOL = {
	name: CONTEXT_SEARCH_TRANSCRIPT_TOOL_NAME,
	description: "Search the full transcript working copy and return small snippets without mutating deletion state.",
	parameters: ContextSearchTranscriptToolParameters,
} as const;

const CONTEXT_READ_ENTRY_TOOL = {
	name: CONTEXT_READ_ENTRY_TOOL_NAME,
	description: "Read a small slice of one transcript entry or content block from the full transcript working copy.",
	parameters: ContextReadEntryToolParameters,
} as const;

export interface ContextDeletionToolDetails {
	deletions: ContextDeletionRequest["deletions"];
	deletedTargets: ContextDeletionTarget[];
	stats: ContextCompactionStats;
	callCount: number;
	error?: string;
}

export interface ContextGrepDeletionMatch {
	entryId: string;
	target: "entry" | "content_block";
	blockIndex?: number;
	text: string;
}

export interface ContextGrepDeletionSkipped {
	entryId?: string;
	target?: "entry" | "content_block";
	blockIndex?: number;
	reason:
		| "protected_entry"
		| "protected_block"
		| "assistant_thinking_entry"
		| "assistant_thinking_block"
		| "already_deleted"
		| "max_matches_exceeded"
		| "expected_match_count_mismatch";
	text?: string;
}

export interface ContextGrepDeletionToolDetails {
	pattern: string;
	regex: boolean;
	caseSensitive: boolean;
	target: "entry" | "content_block";
	matches: ContextGrepDeletionMatch[];
	skipped: ContextGrepDeletionSkipped[];
	deletedTargets: ContextDeletionTarget[];
	stats: ContextCompactionStats;
	callCount: number;
	error?: string;
}

export interface ContextTranscriptSearchMatch {
	entryId: string;
	target: "entry" | "content_block";
	blockIndex?: number;
	matchIndex: number;
	snippet: string;
	protected: boolean;
}

export interface ContextTranscriptSearchToolDetails {
	pattern: string;
	regex: boolean;
	caseSensitive: boolean;
	target: "entry" | "content_block";
	matches: ContextTranscriptSearchMatch[];
	truncated: boolean;
	callCount: number;
	error?: string;
}

export interface ContextReadEntryToolDetails {
	entryId: string;
	blockIndex?: number;
	offset: number;
	maxChars: number;
	totalChars: number;
	text: string;
	truncatedBefore: boolean;
	truncatedAfter: boolean;
	callCount: number;
	error?: string;
}

export interface ContextDeletionToolController {
	tool: AgentTool<typeof ContextDeleteToolParameters, ContextDeletionToolDetails>;
	grepTool: AgentTool<typeof ContextGrepDeleteToolParameters, ContextGrepDeletionToolDetails>;
	searchTool: AgentTool<typeof ContextSearchTranscriptToolParameters, ContextTranscriptSearchToolDetails>;
	readEntryTool: AgentTool<typeof ContextReadEntryToolParameters, ContextReadEntryToolDetails>;
	tools: AgentTool[];
	getDeletionRequest(): ContextDeletionRequest;
	getValidatedResult(): ValidatedContextDeletionResult | undefined;
	getLastError(): string | undefined;
	getCallCount(): number;
}

export interface ContextCompactionRunOptions {
	mode?: ContextCompactionMode;
}

const CONTEXT_COMPACTION_SYSTEM_PROMPT = `You are a context compaction assistant.

Your task is to read relevant parts of a conversation between a user and an AI assistant provided via a transcript file, then run a series of tools to apply deletion-only verbatim compaction using the exact context_delete or context_grep_delete format specified.`;

const CONTEXT_COMPACTION_FIXED_PROMPT = `Reference the provided transcript file transcript and use your search/read tools for small inspections, then use context_delete or context_grep_delete for deletions.

You MUST NOT summarize.
You MUST NOT paraphrase.
You MUST NOT generate replacement context.
You MUST NOT mutate retained transcript objects or content.
Deletion tool calls are the compaction action; record only deletion targets by stable ID.

What Gets Deleted:
- Redundant tool outputs: file reads already acted on, grep/search results already processed, passing test output no longer needed.
- Exploratory dead ends: irrelevant files read, unhelpful or empty searches.
- Verbose boilerplate: license headers, import blocks the agent isn't modifying, configuration files read for reference.
- Superseded information: earlier versions of files that have since been edited, old error messages from bugs already fixed.

What Survives:
- Active file paths and line numbers: Any reference the agent might need to navigate.
- Current error messages: Unresolved bugss and their exact text.
- Reasoning decisions: Why the agent chose approach A over B. An agent's chain of thought (why it chose this file, what pattern it noticed, what fix it decided on) carries more information-per-token than the raw grep output or file content that informed those decisions.
- Recent tool calls and their results: The last 3-5 operations.
- User instructions: The original task and any clarifications.

<output_format>
Call the context_delete tool one or more times with deletion targets in this shape:
{ "deletions": [{ "kind": "entry", "entryId": "..." }] }

For content-block deletions, use:
{ "kind": "content_block", "entryId": "...", "blockIndex": 0 }

The tool applies and validates deletion targets immediately. You can continue calling it for additional deletions if useful.

For guarded bulk deletion by text match, call context_grep_delete with a literal pattern or regex. It skips protected context, enforces maxMatches and expectedMatchCount, and validates through the same tool-call/tool-result safety rules.

The full transcript is available as a JSONL file path in the prompt, but do NOT try to load the whole file into context. Use context_search_transcript to find candidate entry IDs and context_read_entry to read only small slices (for example maxChars 1000-4000) before deleting.

When you are done, reply with a brief plain-text completion message. Do not write deletion JSON or deletion target IDs outside tool calls.
</output_format>`;

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.excludeFromContext,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

function isExcludedFromLlmContext(message: AgentMessage): boolean {
	switch (message.role) {
		case "bashExecution":
			return Boolean(message.excludeFromContext);
		case "custom":
			return (message as { excludeFromContext?: boolean }).excludeFromContext === true;
		default:
			return false;
	}
}

function getContextEligibleMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	const message = getMessageFromEntry(entry);
	if (!message || isExcludedFromLlmContext(message)) return undefined;
	return message;
}

function textFromUnknownContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content);
	return content.map((block) => textFromContentBlock(block)).join("\n");
}

function textFromContentBlock(block: unknown): string {
	if (!block || typeof block !== "object") return String(block);
	const record = block as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") return record.text;
	if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
	if (record.type === "toolCall") {
		const name = typeof record.name === "string" ? record.name : "tool";
		const id = typeof record.id === "string" ? record.id : "unknown";
		const args = "arguments" in record ? JSON.stringify(record.arguments) : "";
		return `toolCall ${id} ${name} ${args}`.trim();
	}
	if (record.type === "image") return "[image]";
	return JSON.stringify(record);
}

function assistantEntryHasThinkingContentBlock(entry: CompactableTranscriptEntry): boolean {
	return (
		entry.role === "assistant" &&
		(entry.contentBlocks.some((block) => isAssistantThinkingBlockType(block.type)) ||
			messageHasAssistantThinkingContentBlock(entry.message))
	);
}

const IMAGE_BLOCK_CHAR_ESTIMATE = 4800;
const IMAGE_BLOCK_TOKEN_ESTIMATE = Math.ceil(IMAGE_BLOCK_CHAR_ESTIMATE / 4);

function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function estimateContentBlockTokens(block: unknown, text: string): number {
	if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
		return IMAGE_BLOCK_TOKEN_ESTIMATE;
	}
	return estimateTextTokens(text);
}

function getToolCallIdFromBlock(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	const record = block as Record<string, unknown>;
	if (record.type !== "toolCall") return undefined;
	return typeof record.id === "string" ? record.id : undefined;
}

function getToolResultCallId(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult") return undefined;
	const callId = (message as { toolCallId?: unknown }).toolCallId;
	return typeof callId === "string" ? callId : undefined;
}

function contentBlocksForEntry(
	entryId: string,
	message: AgentMessage,
	protectedEntry: boolean,
	existingDeletedBlocks: ReadonlySet<number> | undefined,
): CompactableContentBlock[] {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content
		.map((block, blockIndex): CompactableContentBlock | undefined => {
			if (existingDeletedBlocks?.has(blockIndex)) {
				return undefined;
			}
			const type =
				block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string"
					? ((block as { type: string }).type)
					: "unknown";
			const text = textFromContentBlock(block);
			return {
				entryId,
				blockIndex,
				type,
				text,
				tokenEstimate: estimateContentBlockTokens(block, text),
				protected: protectedEntry,
				toolCallId: getToolCallIdFromBlock(block),
			};
		})
		.filter((block): block is CompactableContentBlock => block !== undefined);
}

function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "bashExecution":
			return `Ran ${message.command}\n${message.output}`;
		case "branchSummary":
			return message.summary;
		case "custom":
		case "toolResult":
		case "user":
			return textFromUnknownContent(message.content);
		case "assistant":
			return textFromUnknownContent(message.content);
		case "compactionSummary":
			// Legacy summary-compaction message type retained in the upstream AgentMessage union
			// after summary compaction was removed; surface its archival summary text.
			return message.summary;
		default: {
			// Exhaustiveness guard: adding a new AgentMessage role must fail the build here instead
			// of silently degrading to an empty string.
			const _exhaustiveCheck: never = message;
			void _exhaustiveCheck;
			return "";
		}
	}
}

function hasAssistantError(message: AgentMessage): boolean {
	return message.role === "assistant" && (message as AssistantMessage).stopReason === "error";
}

function hasToolResultError(message: AgentMessage): boolean {
	return message.role === "toolResult" && (message as { isError?: unknown }).isError === true;
}

function hasFailedBashExecution(message: AgentMessage): boolean {
	return message.role === "bashExecution" && typeof message.exitCode === "number" && message.exitCode !== 0;
}

function isProtectedEntry(
	entry: SessionEntry,
	message: AgentMessage,
	recentEntryIds: ReadonlySet<string>,
): boolean {
	if (recentEntryIds.has(entry.id)) return true;
	if (message.role === "user") return true;
	if (message.role === "custom") return true;
	if (message.role === "branchSummary") return true;
	if (hasAssistantError(message) || hasToolResultError(message)) return true;
	if (hasFailedBashExecution(message)) return true;
	if (entry.type === "branch_summary") return true;
	return false;
}

export function prepareContextCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: ContextCompactionRunOptions = {},
): ContextCompactionPreparation | undefined {
	if (pathEntries.length === 0) return undefined;

	const effectiveDeletionFilters = buildEffectiveContextDeletionFilters(pathEntries);
	const filteredPathEntries = buildContextDeletionFilteredPath(pathEntries, effectiveDeletionFilters);
	const rawEntryById = new Map(pathEntries.map((entry) => [entry.id, entry]));
	const messageEntryIds = filteredPathEntries
		.filter((entry) => entry.type !== "context_compaction" && getContextEligibleMessageFromEntry(entry) !== undefined)
		.map((entry) => entry.id);
	const recentEntryIds = new Set(messageEntryIds.slice(-CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT));
	const protectedEntryIds = new Set<string>();
	const entries: CompactableTranscriptEntry[] = [];

	for (const entry of filteredPathEntries) {
		if (entry.type === "context_compaction") continue;
		const message = getContextEligibleMessageFromEntry(entry);
		if (!message) continue;
		const rawEntry = rawEntryById.get(entry.id) ?? entry;
		const protectedEntry = isProtectedEntry(entry, message, recentEntryIds);
		if (protectedEntry) protectedEntryIds.add(entry.id);
		const rawMessage = getContextEligibleMessageFromEntry(rawEntry) ?? message;
		const contentBlocks = contentBlocksForEntry(
			entry.id,
			rawMessage,
			protectedEntry,
			effectiveDeletionFilters.deletedContentBlocks.get(entry.id),
		);
		const toolCallIds = contentBlocks.map((block) => block.toolCallId).filter((id): id is string => id !== undefined);
		const text = contentBlocks.length > 0 ? contentBlocks.map((block) => block.text).join("\n") : messageText(message);
		entries.push({
			entryId: entry.id,
			entryType: entry.type,
			role: message.role,
			text,
			tokenEstimate: estimateTokens(message),
			protected: protectedEntry,
			contentBlocks,
			message,
			toolCallIds,
			toolResultFor: getToolResultCallId(message),
		});
	}

	if (entries.length < 2) return undefined;

	return {
		branchEntries: pathEntries,
		mode: options.mode ?? "standard",
		transcript: {
			entries,
			protectedEntryIds: [...protectedEntryIds],
			tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
			settings,
		},
	};
}

function targetKey(target: ContextDeletionTarget): string {
	return target.kind === "entry" ? `entry:${target.entryId}` : `content_block:${target.entryId}:${target.blockIndex}`;
}

function rawTargetKey(target: ContextDeletionRequest["deletions"][number]): string {
	return target.kind === "entry" ? `entry:${target.entryId}` : `content_block:${target.entryId}:${target.blockIndex}`;
}

function normalizeRawTarget(target: ContextDeletionRequest["deletions"][number]): ContextDeletionTarget {
	if (target.kind === "entry") return { kind: "entry", entryId: target.entryId };
	return { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex as number };
}

function rawDeletionFromTarget(target: ContextDeletionTarget): ContextDeletionRequest["deletions"][number] {
	if (target.kind === "entry") return { kind: "entry", entryId: target.entryId };
	return { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex };
}

function deletionRequestFromTargets(targets: readonly ContextDeletionTarget[]): ContextDeletionRequest {
	return { deletions: targets.map(rawDeletionFromTarget) };
}

function getDeletedEntryIds(targets: readonly ContextDeletionTarget[]): Set<string> {
	return new Set(targets.filter((target) => target.kind === "entry").map((target) => target.entryId));
}

function getDeletedContentBlocks(targets: readonly ContextDeletionTarget[]): Map<string, Set<number>> {
	const blocksByEntry = new Map<string, Set<number>>();
	for (const target of targets) {
		if (target.kind !== "content_block") continue;
		const blocks = blocksByEntry.get(target.entryId) ?? new Set<number>();
		blocks.add(target.blockIndex);
		blocksByEntry.set(target.entryId, blocks);
	}
	return blocksByEntry;
}

function assertNoAssistantThinkingDeletionTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): void {
	const entryById = new Map(transcript.entries.map((entry) => [entry.entryId, entry]));
	for (const target of targets) {
		const entry = entryById.get(target.entryId);
		if (!entry || entry.role !== "assistant") continue;
		if (target.kind === "entry") {
			if (assistantEntryHasThinkingContentBlock(entry)) {
				throw new Error(
					`Cannot delete assistant entry ${target.entryId} because it contains thinking/redacted_thinking content blocks`,
				);
			}
			continue;
		}
		if (assistantEntryHasThinkingContentBlock(entry)) {
			throw new Error(
				`Cannot delete content block ${target.entryId}:${target.blockIndex} because assistant entry ${target.entryId} contains thinking/redacted_thinking content blocks that must be preserved verbatim`,
			);
		}
	}
}

function assertNoLatestRetainedThinkingAssistantContentBlockDeletionTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): void {
	const deletedEntryIds = getDeletedEntryIds(targets);
	let latestRetainedAssistant: CompactableTranscriptEntry | undefined;
	for (let index = transcript.entries.length - 1; index >= 0; index--) {
		const entry = transcript.entries[index];
		if (entry.role !== "assistant" || deletedEntryIds.has(entry.entryId)) continue;
		latestRetainedAssistant = entry;
		break;
	}
	if (!latestRetainedAssistant || !assistantEntryHasThinkingContentBlock(latestRetainedAssistant)) return;

	const unsafeTarget = targets.find(
		(target) => target.kind === "content_block" && target.entryId === latestRetainedAssistant.entryId,
	);
	if (!unsafeTarget || unsafeTarget.kind !== "content_block") return;
	throw new Error(
		`Content block ${unsafeTarget.entryId}:${unsafeTarget.blockIndex} is not deletable during critical_overflow because latest retained assistant entry ${latestRetainedAssistant.entryId} contains thinking/redacted_thinking blocks and must be preserved verbatim. Choose an older assistant entry or older thinking block instead.`,
	);
}

function isToolCallBlockDeleted(
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

function toolCallBlockIndexes(entry: CompactableTranscriptEntry, callId: string): number[] {
	return entry.contentBlocks
		.filter((block) => block.toolCallId === callId)
		.map((block) => block.blockIndex);
}

function addTarget(targets: ContextDeletionTarget[], target: ContextDeletionTarget): boolean {
	if (targets.some((existing) => targetKey(existing) === targetKey(target))) return false;
	targets.push(target);
	return true;
}

function deleteEntryTarget(targets: ContextDeletionTarget[], entryId: string): boolean {
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

function removeEntryDeletion(targets: ContextDeletionTarget[], entryId: string): boolean {
	const originalLength = targets.length;
	for (let index = targets.length - 1; index >= 0; index--) {
		const target = targets[index];
		if (target.kind === "entry" && target.entryId === entryId) targets.splice(index, 1);
	}
	return targets.length !== originalLength;
}

function mergeContextDeletionTargets(
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

function canonicalizeEntryTargets(targets: ContextDeletionTarget[], entry: CompactableTranscriptEntry): boolean {
	if (entry.protected || getDeletedEntryIds(targets).has(entry.entryId)) return false;
	const deletedBlocks = getDeletedContentBlocks(targets).get(entry.entryId);
	if (!deletedBlocks || !entry.contentBlocks.every((block) => deletedBlocks.has(block.blockIndex))) return false;
	// Only repair/promote when dependency reconciliation reaches this entry. Non-tool entries that
	// request every block individually stay invalid so the assistant must choose explicit entry deletion.
	return deleteEntryTarget(targets, entry.entryId);
}

function removeToolCallDeletion(
	targets: ContextDeletionTarget[],
	entry: CompactableTranscriptEntry,
	callId: string,
): boolean {
	let changed = removeEntryDeletion(targets, entry.entryId);
	const blockIndexes = new Set(toolCallBlockIndexes(entry, callId));
	for (let index = targets.length - 1; index >= 0; index--) {
		const target = targets[index];
		if (target.kind === "content_block" && target.entryId === entry.entryId && blockIndexes.has(target.blockIndex)) {
			targets.splice(index, 1);
			changed = true;
		}
	}
	return changed;
}

function addToolCallDeletion(targets: ContextDeletionTarget[], entry: CompactableTranscriptEntry, callId: string): boolean {
	if (entry.protected) return false;
	let changed = false;
	for (const blockIndex of toolCallBlockIndexes(entry, callId)) {
		if (!getDeletedEntryIds(targets).has(entry.entryId)) {
			changed = addTarget(targets, { kind: "content_block", entryId: entry.entryId, blockIndex }) || changed;
		}
	}
	return canonicalizeEntryTargets(targets, entry) || changed;
}

let warnedReconciliationNonConvergence = false;

function reconcileToolDependencies(
	transcript: CompactableTranscript,
	initialTargets: readonly ContextDeletionTarget[],
): ContextDeletionTarget[] {
	const targets = [...initialTargets];
	const callEntries = new Map<string, CompactableTranscriptEntry>();
	const entriesWithToolCalls = new Set<CompactableTranscriptEntry>();
	const resultEntries = new Map<string, CompactableTranscriptEntry[]>();

	for (const entry of transcript.entries) {
		for (const callId of entry.toolCallIds) {
			callEntries.set(callId, entry);
			entriesWithToolCalls.add(entry);
		}
		if (entry.toolResultFor) {
			const results = resultEntries.get(entry.toolResultFor) ?? [];
			results.push(entry);
			resultEntries.set(entry.toolResultFor, results);
		}
	}

	// Bounded fixpoint repair: each pass can add/remove paired call/result targets. In practice this
	// converges within one or two passes; the cap protects against accidental oscillation.
	let changed = true;
	let remainingPasses = Math.max(1, transcript.entries.length * 2);
	while (changed && remainingPasses > 0) {
		changed = false;
		remainingPasses -= 1;
		let deletedEntryIds = getDeletedEntryIds(targets);
		let deletedContentBlocks = getDeletedContentBlocks(targets);
		const recordChange = (nextChanged: boolean): void => {
			if (!nextChanged) return;
			changed = true;
			deletedEntryIds = getDeletedEntryIds(targets);
			deletedContentBlocks = getDeletedContentBlocks(targets);
		};

		for (const [callId, callEntry] of callEntries) {
			const callDeleted = isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks);
			const results = resultEntries.get(callId) ?? [];

			if (callDeleted) {
				const retainedProtectedResult = results.find((entry) => entry.protected && !deletedEntryIds.has(entry.entryId));
				if (retainedProtectedResult) {
					recordChange(removeToolCallDeletion(targets, callEntry, callId));
				} else {
					for (const result of results) {
						recordChange(deleteEntryTarget(targets, result.entryId));
					}
				}
			}

			if (isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks)) continue;

			for (const result of results) {
				if (!deletedEntryIds.has(result.entryId)) continue;
				recordChange(deleteEntryTarget(targets, result.entryId));
				if (callEntry.protected) {
					recordChange(removeEntryDeletion(targets, result.entryId));
					continue;
				}
				recordChange(addToolCallDeletion(targets, callEntry, callId));
			}
		}

		for (const entry of entriesWithToolCalls) {
			recordChange(canonicalizeEntryTargets(targets, entry));
		}
	}

	if (changed && !warnedReconciliationNonConvergence) {
		warnedReconciliationNonConvergence = true;
		console.warn(
			`Context compaction tool dependency reconciliation did not converge within the bounded pass limit; validation will continue with the last reconciled target set. entries=${transcript.entries.length} callEntries=${callEntries.size} targets=${targets.length}`,
		);
	}

	return targets;
}

function validateToolDependencies(transcript: CompactableTranscript, targets: readonly ContextDeletionTarget[]): void {
	const deletedEntryIds = getDeletedEntryIds(targets);
	const deletedContentBlocks = getDeletedContentBlocks(targets);
	const callEntries = new Map<string, CompactableTranscriptEntry>();
	const resultEntries = new Map<string, CompactableTranscriptEntry[]>();

	for (const entry of transcript.entries) {
		for (const callId of entry.toolCallIds) {
			callEntries.set(callId, entry);
		}
		if (entry.toolResultFor) {
			const results = resultEntries.get(entry.toolResultFor) ?? [];
			results.push(entry);
			resultEntries.set(entry.toolResultFor, results);
		}
	}

	for (const [callId, callEntry] of callEntries) {
		const callDeleted = isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks);
		const results = resultEntries.get(callId) ?? [];
		if (callDeleted) {
			const danglingResult = results.find((entry) => !deletedEntryIds.has(entry.entryId));
			if (danglingResult) {
				throw new Error(`Deleting tool call ${callId} would leave tool result entry ${danglingResult.entryId} orphaned`);
			}
			continue;
		}

		const deletedResult = results.find((entry) => deletedEntryIds.has(entry.entryId));
		if (deletedResult) {
			throw new Error(`Deleting tool result entry ${deletedResult.entryId} would leave tool call ${callId} dangling`);
		}
	}
}

function computeContextCompactionStats(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): ContextCompactionStats {
	const entryById = new Map(transcript.entries.map((entry) => [entry.entryId, entry]));
	const deletedEntryIds = getDeletedEntryIds(targets);
	let deletedTokens = 0;
	let objectsDeleted = 0;

	for (const entryId of deletedEntryIds) {
		const entry = entryById.get(entryId);
		if (!entry) continue;
		deletedTokens += entry.tokenEstimate;
		objectsDeleted += 1 + entry.contentBlocks.length;
	}

	for (const target of targets) {
		if (target.kind !== "content_block" || deletedEntryIds.has(target.entryId)) continue;
		const entry = entryById.get(target.entryId);
		if (!entry) continue;
		const block = entry.contentBlocks.find((item) => item.blockIndex === target.blockIndex);
		if (!block) continue;
		deletedTokens += block.tokenEstimate;
		objectsDeleted += 1;
	}

	const objectsBefore = transcript.entries.length + transcript.entries.reduce((total, entry) => total + entry.contentBlocks.length, 0);
	const tokensBefore = transcript.tokensBefore;
	const tokensAfter = Math.max(0, tokensBefore - deletedTokens);
	const percentReduction = tokensBefore > 0 ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 1000) / 10 : 0;
	return {
		objectsBefore,
		objectsAfter: Math.max(0, objectsBefore - objectsDeleted),
		objectsDeleted,
		tokensBefore,
		tokensAfter,
		percentReduction,
	};
}

interface ContextDeletionValidationOptions {
	mode?: ContextCompactionMode;
}

/**
 * An entry "bears task context" when it carries the user's intent for the session: a real `user`
 * message, an extension-injected `custom` message, or a branch summary (`branchSummary` role /
 * `branch_summary` entry type) that recaps an earlier branch's task.
 *
 * Verbatim compaction must always leave at least one task-bearing entry in context. The same set
 * also defines which protected entries `critical_overflow` may delete, because the intent each one
 * carries is recoverable from any other surviving task-bearing entry. As a deliberate consequence,
 * `critical_overflow` MAY delete every literal `user` message as long as a branch summary or custom
 * entry survives — branch summaries intentionally carry the task forward.
 */
function isTaskBearingEntry(entry: CompactableTranscriptEntry): boolean {
	return (
		entry.role === "user" ||
		entry.role === "custom" ||
		entry.role === "branchSummary" ||
		entry.entryType === "branch_summary"
	);
}

function isCriticalOverflowProtectedEntryDeletable(
	entry: CompactableTranscriptEntry,
	transcript: CompactableTranscript,
): boolean {
	if (!entry.protected) return true;
	const entryIndex = transcript.entries.findIndex((candidate) => candidate.entryId === entry.entryId);
	if (entryIndex < 0) return false;
	const recentBoundary = Math.max(0, transcript.entries.length - CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT);
	if (entryIndex >= recentBoundary) return false;
	if (hasAssistantError(entry.message) || hasToolResultError(entry.message) || hasFailedBashExecution(entry.message)) {
		return false;
	}
	return isTaskBearingEntry(entry);
}

function canDeleteProtectedTargetInMode(
	transcript: CompactableTranscript,
	target: ContextDeletionTarget,
	mode: ContextCompactionMode,
): boolean {
	if (mode !== "critical_overflow") return false;
	const entry = transcript.entries.find((candidate) => candidate.entryId === target.entryId);
	if (!entry || !isCriticalOverflowProtectedEntryDeletable(entry, transcript)) return false;
	if (target.kind === "entry") return true;
	const block = entry.contentBlocks.find((candidate) => candidate.blockIndex === target.blockIndex);
	return block !== undefined;
}

export function validateContextDeletionRequest(
	request: ContextDeletionRequest,
	transcript: CompactableTranscript,
	options: ContextDeletionValidationOptions = {},
): ValidatedContextDeletionResult {
	const mode = options.mode ?? "standard";
	if (!request || typeof request !== "object" || !Array.isArray(request.deletions)) {
		throw new Error("Context deletion request must be an object with a deletions array");
	}

	const entryById = new Map(transcript.entries.map((entry) => [entry.entryId, entry]));
	const seen = new Set<string>();
	const deletedTargets: ContextDeletionTarget[] = [];

	for (const deletion of request.deletions) {
		if (!deletion || typeof deletion !== "object") {
			throw new Error("Deletion target must be an object");
		}
		if (deletion.kind !== "entry" && deletion.kind !== "content_block") {
			throw new Error(`Unsupported deletion target kind: ${String((deletion as { kind?: unknown }).kind)}`);
		}
		if (typeof deletion.entryId !== "string" || deletion.entryId.length === 0) {
			throw new Error("Deletion target entryId must be a non-empty string");
		}
		const entry = entryById.get(deletion.entryId);
		if (!entry) {
			throw new Error(`Unknown deletion target entryId: ${deletion.entryId}`);
		}
		const normalized = normalizeRawTarget(deletion);
		if (mode !== "critical_overflow" && deletion.kind === "entry" && assistantEntryHasThinkingContentBlock(entry)) {
			throw new Error(
				`Cannot delete assistant entry ${deletion.entryId} because it contains thinking/redacted_thinking content blocks`,
			);
		}
		if (entry.protected && !canDeleteProtectedTargetInMode(transcript, normalized, mode)) {
			throw new Error(`Deletion target ${deletion.entryId} is protected`);
		}
		if (deletion.kind === "content_block") {
			if (typeof deletion.blockIndex !== "number" || !Number.isInteger(deletion.blockIndex) || deletion.blockIndex < 0) {
				throw new Error(`Invalid content block index for entry ${deletion.entryId}`);
			}
			const block = entry.contentBlocks.find((item) => item.blockIndex === deletion.blockIndex);
			if (!block) {
				throw new Error(`Unknown content block ${deletion.blockIndex} for entry ${deletion.entryId}`);
			}
			if (mode !== "critical_overflow" && assistantEntryHasThinkingContentBlock(entry)) {
				throw new Error(
					`Cannot delete content block ${deletion.entryId}:${deletion.blockIndex} because assistant entry ${deletion.entryId} contains thinking/redacted_thinking content blocks that must be preserved verbatim`,
				);
			}
			if (block.protected && !canDeleteProtectedTargetInMode(transcript, normalized, mode)) {
				throw new Error(`Content block ${deletion.entryId}:${deletion.blockIndex} is protected`);
			}
			if (entry.contentBlocks.length <= 1) {
				throw new Error(`Deleting the only content block of ${deletion.entryId} must be an entry deletion`);
			}
		}

		const key = rawTargetKey(deletion);
		if (seen.has(key)) {
			throw new Error(`Duplicate deletion target: ${key}`);
		}
		seen.add(key);
		deletedTargets.push(normalized);
	}

	const reconciledTargets = reconcileToolDependencies(transcript, deletedTargets);
	if (mode === "critical_overflow") {
		assertNoLatestRetainedThinkingAssistantContentBlockDeletionTargets(transcript, reconciledTargets);
	} else {
		// Tool reconciliation can add targets after the per-request checks above, so
		// this post-reconcile assertion remains authoritative for standard mode.
		assertNoAssistantThinkingDeletionTargets(transcript, reconciledTargets);
	}
	const reconciledDeletedEntryIds = getDeletedEntryIds(reconciledTargets);

	for (const target of reconciledTargets) {
		if (target.kind === "content_block" && reconciledDeletedEntryIds.has(target.entryId)) {
			throw new Error(`Deletion target ${targetKey(target)} overlaps with entry deletion`);
		}
	}

	const deletedContentBlocks = getDeletedContentBlocks(reconciledTargets);
	for (const [entryId, blockIndexes] of deletedContentBlocks) {
		const entry = entryById.get(entryId);
		if (entry?.contentBlocks.every((block) => blockIndexes.has(block.blockIndex))) {
			throw new Error(`Content-block deletions for ${entryId} would remove every content block`);
		}
	}

	validateToolDependencies(transcript, reconciledTargets);

	const remainingEntries = transcript.entries.filter((entry) => !reconciledDeletedEntryIds.has(entry.entryId));
	if (remainingEntries.length === 0) {
		throw new Error("Deletion request would remove all context entries");
	}
	const hasTaskBearingContext = remainingEntries.some(isTaskBearingEntry);
	if (!hasTaskBearingContext) {
		throw new Error("Deletion request would leave no user task in context");
	}

	return {
		deletedTargets: reconciledTargets,
		protectedEntryIds: [...transcript.protectedEntryIds],
		stats: computeContextCompactionStats(transcript, reconciledTargets),
	};
}

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;

	const firstLineEnd = trimmed.indexOf("\n");
	if (firstLineEnd < 0) return trimmed;

	const fenceInfo = trimmed.slice(3, firstLineEnd).trim().toLowerCase();
	if (fenceInfo !== "" && fenceInfo !== "json") return trimmed;

	return trimmed.slice(firstLineEnd + 1, -3).trim();
}

function contextDeletionRequestFromObject(value: unknown, source: string): ContextDeletionRequest {
	if (!value || typeof value !== "object" || !Array.isArray((value as { deletions?: unknown }).deletions)) {
		throw new Error(`${source} must contain a deletions array`);
	}
	return value as ContextDeletionRequest;
}

function escapeRegExpLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createContextDeletionToolResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return { content: [{ type: "text", text }], details, terminate: false };
}

function assertSafeRegexPattern(pattern: string): void {
	if (pattern.length > CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS) {
		throw new Error(
			`Regex pattern is too long (${pattern.length} characters); maximum is ${CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS}`,
		);
	}

	// Heuristic ReDoS guard for common catastrophic-backtracking shapes. JavaScript's RegExp engine
	// does not expose a timeout, so reject nested quantified groups and backreferences instead of
	// relying only on transcript scan-size caps.
	const hasNestedQuantifiedGroup = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/u.test(pattern);
	const hasQuantifiedAlternation = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/u.test(pattern);
	const hasBackreference = /\\[1-9]/u.test(pattern);
	if (hasNestedQuantifiedGroup || hasQuantifiedAlternation || hasBackreference) {
		throw new Error(
			"Regex pattern is not allowed because it may cause excessive backtracking; use a literal pattern or exact deletion targets instead.",
		);
	}
}

function createGrepMatcher(pattern: string, regex: boolean, caseSensitive: boolean): RegExp {
	if (regex) {
		assertSafeRegexPattern(pattern);
	}

	try {
		return new RegExp(regex ? pattern : escapeRegExpLiteral(pattern), caseSensitive ? "u" : "iu");
	} catch (error) {
		throw new Error(`Invalid grep ${regex ? "regex" : "pattern"}: ${formatErrorMessage(error)}`);
	}
}

function assertSafeRegexScan(scanChars: number): void {
	if (scanChars <= CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS) return;
	throw new Error(
		`Regex grep would scan ${scanChars} characters; maximum is ${CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS}. Use a literal pattern or exact deletion targets instead.`,
	);
}

function clampInteger(value: number | undefined, defaultValue: number, minimum: number, maximum: number): number {
	if (value === undefined) return defaultValue;
	return Math.max(minimum, Math.min(maximum, value));
}

function textSlice(text: string, offset: number, maxChars: number): string {
	return text.slice(offset, Math.min(text.length, offset + maxChars));
}

function findMatchIndex(matcher: RegExp, text: string): number {
	const match = matcher.exec(text);
	matcher.lastIndex = 0;
	return match?.index ?? -1;
}

function snippetForMatch(text: string, matchIndex: number, contextChars: number): string {
	const start = Math.max(0, matchIndex - contextChars);
	const end = Math.min(text.length, matchIndex + contextChars);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < text.length ? "…" : "";
	return `${prefix}${text.slice(start, end)}${suffix}`;
}

function currentTargetDeleted(targets: readonly ContextDeletionTarget[], target: ContextDeletionTarget): boolean {
	const deletedEntryIds = getDeletedEntryIds(targets);
	if (deletedEntryIds.has(target.entryId)) return true;
	if (target.kind === "entry") return false;
	return getDeletedContentBlocks(targets).get(target.entryId)?.has(target.blockIndex) === true;
}

function addGrepCandidate(
	candidates: ContextDeletionTarget[],
	matches: ContextGrepDeletionMatch[],
	seenTargets: Set<string>,
	candidate: ContextDeletionTarget,
	match: ContextGrepDeletionMatch,
): void {
	const key = targetKey(candidate);
	if (seenTargets.has(key)) return;
	seenTargets.add(key);
	candidates.push(candidate);
	matches.push(match);
}

interface EntryTextRow {
	entry_id: string;
	text: string;
	is_protected: number;
	has_assistant_thinking_blocks: number;
}

interface EntryReadRow extends EntryTextRow {
	role: string;
	token_estimate: number;
}

interface ContentBlockTextRow {
	entry_id: string;
	block_index: number;
	role: AgentMessage["role"];
	type: string;
	text: string;
	entry_protected: number;
	block_protected: number;
	block_count: number;
	has_assistant_thinking_blocks: number;
}

interface ContentBlockReadRow extends ContentBlockTextRow {
	token_estimate: number;
}

interface StoredTranscriptEntry {
	entryId: string;
	role: AgentMessage["role"];
	protected: boolean;
	hasAssistantThinkingBlocks: boolean;
	tokenEstimate: number;
	text: string;
}

interface StoredContentBlock {
	entryPosition: number;
	entryId: string;
	blockIndex: number;
	role: AgentMessage["role"];
	type: string;
	protected: boolean;
	hasAssistantThinkingBlocks: boolean;
	tokenEstimate: number;
	text: string;
}

interface ContextDeletionMemorySnapshot {
	deletionTargets: ContextDeletionTarget[];
	callCount: number;
	lastError?: string;
}

function copyDeletionTarget(target: ContextDeletionTarget): ContextDeletionTarget {
	return target.kind === "entry"
		? { kind: "entry", entryId: target.entryId }
		: { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex };
}

class ContextDeletionMemoryStore {
	private readonly entries: StoredTranscriptEntry[];
	private readonly entriesById: Map<string, StoredTranscriptEntry>;
	private readonly contentBlocks: StoredContentBlock[];
	private readonly contentBlockCountByEntryId: Map<string, number>;
	private deletionTargets: ContextDeletionTarget[] = [];
	private callCount = 0;
	private lastError: string | undefined;

	constructor(transcript: CompactableTranscript) {
		const entryIds = new Set<string>();
		const blockKeys = new Set<string>();
		this.entries = transcript.entries.map((entry) => {
			if (entryIds.has(entry.entryId)) {
				throw new Error(`Duplicate transcript entry id: ${entry.entryId}`);
			}
			entryIds.add(entry.entryId);
			return {
				entryId: entry.entryId,
				role: entry.role,
				protected: entry.protected,
				hasAssistantThinkingBlocks: assistantEntryHasThinkingContentBlock(entry),
				tokenEstimate: entry.tokenEstimate,
				text: entry.text,
			};
		});
		this.entriesById = new Map<string, StoredTranscriptEntry>(this.entries.map((entry) => [entry.entryId, entry] as const));
		this.contentBlocks = transcript.entries.flatMap((entry, entryPosition) => {
			const hasAssistantThinkingBlocks = assistantEntryHasThinkingContentBlock(entry);
			return entry.contentBlocks.map((block) => {
				if (block.entryId !== entry.entryId) {
					throw new Error(`Transcript content block ${block.entryId}:${block.blockIndex} does not belong to entry ${entry.entryId}`);
				}
				const blockKey = `${block.entryId}:${block.blockIndex}`;
				if (blockKeys.has(blockKey)) {
					throw new Error(`Duplicate transcript content block: ${blockKey}`);
				}
				blockKeys.add(blockKey);
				return {
					entryPosition,
					entryId: block.entryId,
					blockIndex: block.blockIndex,
					role: entry.role,
					type: block.type,
					protected: block.protected,
					hasAssistantThinkingBlocks,
					tokenEstimate: block.tokenEstimate,
					text: block.text,
				};
			});
		});
		this.contentBlockCountByEntryId = new Map();
		for (const block of this.contentBlocks) {
			this.contentBlockCountByEntryId.set(block.entryId, (this.contentBlockCountByEntryId.get(block.entryId) ?? 0) + 1);
		}
	}

	transaction<T>(operation: () => T): T {
		const snapshot = this.snapshot();
		try {
			return operation();
		} catch (error) {
			this.restore(snapshot);
			throw error;
		}
	}

	readTargets(): ContextDeletionTarget[] {
		return this.deletionTargets.map(copyDeletionTarget);
	}

	replaceTargets(targets: readonly ContextDeletionTarget[]): void {
		this.deletionTargets = targets.map(copyDeletionTarget);
	}

	listEntriesForGrep(): EntryTextRow[] {
		return this.entries.map((entry) => ({
			entry_id: entry.entryId,
			text: entry.text,
			is_protected: entry.protected ? 1 : 0,
			has_assistant_thinking_blocks: entry.hasAssistantThinkingBlocks ? 1 : 0,
		}));
	}

	listContentBlocksForGrep(): ContentBlockTextRow[] {
		return [...this.contentBlocks]
			.sort((a, b) => a.entryPosition - b.entryPosition || a.blockIndex - b.blockIndex)
			.map((block) => ({
				entry_id: block.entryId,
				block_index: block.blockIndex,
				role: block.role,
				type: block.type,
				text: block.text,
				entry_protected: this.entriesById.get(block.entryId)?.protected ? 1 : 0,
				block_protected: block.protected ? 1 : 0,
				block_count: this.contentBlockCountByEntryId.get(block.entryId) ?? 0,
				has_assistant_thinking_blocks: block.hasAssistantThinkingBlocks ? 1 : 0,
			}));
	}

	getEntryForRead(entryId: string): EntryReadRow | undefined {
		const entry = this.entriesById.get(entryId);
		if (!entry) return undefined;
		return {
			entry_id: entry.entryId,
			role: entry.role,
			is_protected: entry.protected ? 1 : 0,
			has_assistant_thinking_blocks: entry.hasAssistantThinkingBlocks ? 1 : 0,
			token_estimate: entry.tokenEstimate,
			text: entry.text,
		};
	}

	getContentBlockForRead(entryId: string, blockIndex: number): ContentBlockReadRow | undefined {
		const block = this.contentBlocks.find((candidate) => candidate.entryId === entryId && candidate.blockIndex === blockIndex);
		if (!block) return undefined;
		return {
			entry_id: block.entryId,
			block_index: block.blockIndex,
			role: block.role,
			type: block.type,
			token_estimate: block.tokenEstimate,
			text: block.text,
			entry_protected: this.entriesById.get(block.entryId)?.protected ? 1 : 0,
			block_protected: block.protected ? 1 : 0,
			block_count: this.contentBlockCountByEntryId.get(block.entryId) ?? 0,
			has_assistant_thinking_blocks: block.hasAssistantThinkingBlocks ? 1 : 0,
		};
	}

	getGrepScanTextLength(target: "entry" | "content_block"): number {
		const texts = target === "entry" ? this.entries : this.contentBlocks;
		return texts.reduce((sum, item) => sum + item.text.length, 0);
	}

	incrementCallCount(): number {
		this.callCount += 1;
		return this.callCount;
	}

	getCallCount(): number {
		return this.callCount;
	}

	setLastError(message: string): void {
		this.lastError = message;
	}

	clearLastError(): void {
		this.lastError = undefined;
	}

	getLastError(): string | undefined {
		return this.lastError;
	}

	private snapshot(): ContextDeletionMemorySnapshot {
		return {
			deletionTargets: this.readTargets(),
			callCount: this.callCount,
			...(this.lastError === undefined ? {} : { lastError: this.lastError }),
		};
	}

	private restore(snapshot: ContextDeletionMemorySnapshot): void {
		this.deletionTargets = snapshot.deletionTargets.map(copyDeletionTarget);
		this.callCount = snapshot.callCount;
		this.lastError = snapshot.lastError;
	}
}

function createContextDeletionStore(transcript: CompactableTranscript): ContextDeletionMemoryStore {
	return new ContextDeletionMemoryStore(transcript);
}

export function createContextDeletionTool(
	transcript: CompactableTranscript,
	options: ContextCompactionRunOptions = {},
): ContextDeletionToolController {
	const mode = options.mode ?? "standard";
	const store = createContextDeletionStore(transcript);
	let validatedResult: ValidatedContextDeletionResult | undefined;

	function readTargets(): ContextDeletionTarget[] {
		return store.readTargets();
	}

	function applyValidatedTargets(additionalTargets: readonly ContextDeletionTarget[]): ValidatedContextDeletionResult {
		const mergedTargets = mergeContextDeletionTargets(readTargets(), additionalTargets);
		validatedResult = validateContextDeletionRequest(deletionRequestFromTargets(mergedTargets), transcript, { mode });
		store.replaceTargets(validatedResult.deletedTargets);
		return validatedResult;
	}

	function currentStats(): ContextCompactionStats {
		return validatedResult?.stats ?? computeContextCompactionStats(transcript, readTargets());
	}

	function canDeleteProtectedTarget(target: ContextDeletionTarget): boolean {
		return canDeleteProtectedTargetInMode(transcript, target, mode);
	}

	const tool: AgentTool<typeof ContextDeleteToolParameters, ContextDeletionToolDetails> = {
		...CONTEXT_DELETE_TOOL,
		label: "context deletion request",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				try {
					const incomingRequest = contextDeletionRequestFromObject(params, `${CONTEXT_DELETE_TOOL_NAME} arguments`);
					const incomingValidated = validateContextDeletionRequest(incomingRequest, transcript, { mode });
					const applied = applyValidatedTargets(incomingValidated.deletedTargets);
					store.clearLastError();
					const deletedTargets = readTargets();

					const details: ContextDeletionToolDetails = {
						deletions: deletionRequestFromTargets(deletedTargets).deletions,
						deletedTargets,
						stats: applied.stats,
						callCount,
					};
					const text = `Recorded ${incomingValidated.deletedTargets.length} deletion target(s); ${deletedTargets.length} total validated deletion target(s) are selected. Continue calling ${CONTEXT_DELETE_TOOL_NAME} or ${CONTEXT_GREP_DELETE_TOOL_NAME} for additional deletions, or respond done when finished.`;
					return createContextDeletionToolResult(text, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const deletedTargets = readTargets();
					const details: ContextDeletionToolDetails = {
						deletions: deletionRequestFromTargets(deletedTargets).deletions,
						deletedTargets,
						stats: currentStats(),
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(
						`Error recording context deletion targets: ${message}. No new deletion targets were applied; continue with a corrected tool call.`,
						details,
					);
				}
			});
		},
	};

	const grepTool: AgentTool<typeof ContextGrepDeleteToolParameters, ContextGrepDeletionToolDetails> = {
		...CONTEXT_GREP_DELETE_TOOL,
		label: "context grep delete",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				const pattern = params.pattern;
				const regex = params.regex === true;
				const caseSensitive = params.caseSensitive === true;
				const target = params.target ?? "entry";
				const maxMatches = params.maxMatches ?? CONTEXT_GREP_DELETE_DEFAULT_MAX_MATCHES;
				const candidates: ContextDeletionTarget[] = [];
				const matches: ContextGrepDeletionMatch[] = [];
				const skipped: ContextGrepDeletionSkipped[] = [];
				const seenTargets = new Set<string>();

				try {
					if (regex) {
						assertSafeRegexScan(store.getGrepScanTextLength(target));
					}
					const matcher = createGrepMatcher(pattern, regex, caseSensitive);
					const currentTargets = readTargets();

					if (target === "entry") {
						for (const entry of store.listEntriesForGrep()) {
							if (!matcher.test(entry.text)) continue;
							const candidate: ContextDeletionTarget = { kind: "entry", entryId: entry.entry_id };
							if (mode !== "critical_overflow" && entry.has_assistant_thinking_blocks === 1) {
								skipped.push({ entryId: entry.entry_id, target, reason: "assistant_thinking_entry", text: entry.text });
								continue;
							}
							if (entry.is_protected === 1 && !canDeleteProtectedTarget(candidate)) {
								skipped.push({ entryId: entry.entry_id, target, reason: "protected_entry", text: entry.text });
								continue;
							}
							if (currentTargetDeleted(currentTargets, candidate)) {
								skipped.push({ entryId: entry.entry_id, target, reason: "already_deleted", text: entry.text });
								continue;
							}
							addGrepCandidate(candidates, matches, seenTargets, candidate, {
								entryId: entry.entry_id,
								target,
								text: entry.text,
							});
						}
					} else {
						for (const block of store.listContentBlocksForGrep()) {
							if (!matcher.test(block.text)) continue;
							if (mode !== "critical_overflow" && block.role === "assistant" && isAssistantThinkingBlockType(block.type)) {
								skipped.push({
									entryId: block.entry_id,
									target,
									blockIndex: block.block_index,
									reason: "assistant_thinking_block",
									text: block.text,
								});
								continue;
							}
							// Non-thinking sibling blocks in a thinking-bearing assistant are also
							// skipped in standard mode so block indexes are not reflowed around
							// provider-managed thinking/redacted_thinking content.
							if (mode !== "critical_overflow" && block.role === "assistant" && block.has_assistant_thinking_blocks === 1) {
								skipped.push({
									entryId: block.entry_id,
									target,
									blockIndex: block.block_index,
									reason: "assistant_thinking_entry",
									text: block.text,
								});
								continue;
							}
							const candidate: ContextDeletionTarget =
								block.block_count <= 1
									? { kind: "entry", entryId: block.entry_id }
									: { kind: "content_block", entryId: block.entry_id, blockIndex: block.block_index };
							if (block.entry_protected === 1 && !canDeleteProtectedTarget(candidate)) {
								skipped.push({
									entryId: block.entry_id,
									target,
									blockIndex: block.block_index,
									reason: "protected_entry",
									text: block.text,
								});
								continue;
							}
							if (block.block_protected === 1 && !canDeleteProtectedTarget(candidate)) {
								skipped.push({
									entryId: block.entry_id,
									target,
									blockIndex: block.block_index,
									reason: "protected_block",
									text: block.text,
								});
								continue;
							}
							if (currentTargetDeleted(currentTargets, candidate)) {
								skipped.push({
									entryId: block.entry_id,
									target: candidate.kind,
									...(candidate.kind === "content_block" ? { blockIndex: candidate.blockIndex } : {}),
									reason: "already_deleted",
									text: block.text,
								});
								continue;
							}
							addGrepCandidate(candidates, matches, seenTargets, candidate, {
								entryId: block.entry_id,
								target: candidate.kind,
								...(candidate.kind === "content_block" ? { blockIndex: candidate.blockIndex } : {}),
								text: block.text,
							});
						}
					}

					let applied: ValidatedContextDeletionResult | undefined;
					if (params.expectedMatchCount !== undefined && candidates.length !== params.expectedMatchCount) {
						skipped.push({ reason: "expected_match_count_mismatch" });
					} else if (candidates.length > maxMatches) {
						skipped.push({ reason: "max_matches_exceeded" });
					} else if (candidates.length > 0) {
						applied = applyValidatedTargets(candidates);
					}
					store.clearLastError();
					const deletedTargets = readTargets();

					const details: ContextGrepDeletionToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches,
						skipped,
						deletedTargets,
						stats: applied?.stats ?? currentStats(),
						callCount,
					};
					const text = `Matched ${matches.length} deletion target(s), skipped ${skipped.length}, and ${applied ? "applied" : "did not apply"} grep deletion for pattern ${JSON.stringify(pattern)}. Total validated deletion target(s): ${deletedTargets.length}.`;
					return createContextDeletionToolResult(text, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const deletedTargets = readTargets();
					const details: ContextGrepDeletionToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches,
						skipped,
						deletedTargets,
						stats: currentStats(),
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(
						`Error applying grep deletion for pattern ${JSON.stringify(pattern)}: ${message}. No new deletion targets were applied; continue with a corrected tool call.`,
						details,
					);
				}
			});
		},
	};

	const searchTool: AgentTool<typeof ContextSearchTranscriptToolParameters, ContextTranscriptSearchToolDetails> = {
		...CONTEXT_SEARCH_TRANSCRIPT_TOOL,
		label: "context transcript search",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				const pattern = params.pattern;
				const regex = params.regex === true;
				const caseSensitive = params.caseSensitive === true;
				const target = params.target ?? "entry";
				const maxMatches = clampInteger(params.maxMatches, CONTEXT_SEARCH_DEFAULT_MAX_MATCHES, 1, CONTEXT_SEARCH_MAX_MATCHES);
				const contextChars = clampInteger(
					params.contextChars,
					CONTEXT_SEARCH_DEFAULT_CONTEXT_CHARS,
					0,
					CONTEXT_SEARCH_MAX_CONTEXT_CHARS,
				);
				const matches: ContextTranscriptSearchMatch[] = [];
				let truncated = false;

				try {
					if (regex) {
						assertSafeRegexScan(store.getGrepScanTextLength(target));
					}
					const matcher = createGrepMatcher(pattern, regex, caseSensitive);
					if (target === "entry") {
						for (const entry of store.listEntriesForGrep()) {
							const matchIndex = findMatchIndex(matcher, entry.text);
							if (matchIndex < 0) continue;
							if (matches.length >= maxMatches) {
								truncated = true;
								break;
							}
							matches.push({
								entryId: entry.entry_id,
								target,
								matchIndex,
								snippet: snippetForMatch(entry.text, matchIndex, contextChars),
								protected: entry.is_protected === 1,
							});
						}
					} else {
						for (const block of store.listContentBlocksForGrep()) {
							const matchIndex = findMatchIndex(matcher, block.text);
							if (matchIndex < 0) continue;
							if (matches.length >= maxMatches) {
								truncated = true;
								break;
							}
							matches.push({
								entryId: block.entry_id,
								target,
								blockIndex: block.block_index,
								matchIndex,
								snippet: snippetForMatch(block.text, matchIndex, contextChars),
								protected: block.entry_protected === 1 || block.block_protected === 1,
							});
						}
					}
					store.clearLastError();
					const details: ContextTranscriptSearchToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches,
						truncated,
						callCount,
					};
					const text = `Found ${matches.length}${truncated ? "+" : ""} ${target} match(es) for ${JSON.stringify(pattern)}. Use ${CONTEXT_READ_ENTRY_TOOL_NAME} with small maxChars to inspect exact content before deleting.`;
					return createContextDeletionToolResult(text, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const details: ContextTranscriptSearchToolDetails = {
						pattern,
						regex,
						caseSensitive,
						target,
						matches,
						truncated,
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(
						`Error searching transcript for ${JSON.stringify(pattern)}: ${message}. Try a literal pattern or narrower query.`,
						details,
					);
				}
			});
		},
	};

	const readEntryTool: AgentTool<typeof ContextReadEntryToolParameters, ContextReadEntryToolDetails> = {
		...CONTEXT_READ_ENTRY_TOOL,
		label: "context read entry",
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			return store.transaction(() => {
				const callCount = store.incrementCallCount();
				const offset = clampInteger(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
				const maxChars = clampInteger(
					params.maxChars,
					CONTEXT_READ_ENTRY_DEFAULT_MAX_CHARS,
					1,
					CONTEXT_READ_ENTRY_MAX_CHARS,
				);
				try {
					const row =
						params.blockIndex === undefined
							? store.getEntryForRead(params.entryId)
							: store.getContentBlockForRead(params.entryId, params.blockIndex);
					if (!row) {
						throw new Error(
							params.blockIndex === undefined
								? `Unknown transcript entry: ${params.entryId}`
								: `Unknown transcript content block: ${params.entryId}:${params.blockIndex}`,
						);
					}
					const text = row.text;
					const slice = textSlice(text, offset, maxChars);
					store.clearLastError();
					const details: ContextReadEntryToolDetails = {
						entryId: params.entryId,
						...(params.blockIndex === undefined ? {} : { blockIndex: params.blockIndex }),
						offset,
						maxChars,
						totalChars: text.length,
						text: slice,
						truncatedBefore: offset > 0,
						truncatedAfter: offset + maxChars < text.length,
						callCount,
					};
					const textResult = `Read ${slice.length} of ${text.length} characters from ${params.blockIndex === undefined ? params.entryId : `${params.entryId}:${params.blockIndex}`}. Keep reads small; increase offset for the next slice if needed.`;
					return createContextDeletionToolResult(textResult, details);
				} catch (error) {
					const message = formatErrorMessage(error);
					store.setLastError(message);
					const details: ContextReadEntryToolDetails = {
						entryId: params.entryId,
						...(params.blockIndex === undefined ? {} : { blockIndex: params.blockIndex }),
						offset,
						maxChars,
						totalChars: 0,
						text: "",
						truncatedBefore: false,
						truncatedAfter: false,
						callCount,
						error: message,
					};
					return createContextDeletionToolResult(`Error reading transcript entry: ${message}`, details);
				}
			});
		},
	};

	return {
		tool,
		grepTool,
		searchTool,
		readEntryTool,
		tools: [tool, grepTool, searchTool, readEntryTool],
		getDeletionRequest: () => deletionRequestFromTargets(readTargets()),
		getValidatedResult: () => validatedResult,
		getLastError: () => store.getLastError(),
		getCallCount: () => store.getCallCount(),
	};
}

export function parseContextDeletionRequest(text: string): ContextDeletionRequest {
	const stripped = stripJsonFence(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch (error) {
		throw new Error(`Failed to parse context deletion request JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return contextDeletionRequestFromObject(parsed, "Context deletion request JSON");
}

function isContextDeleteToolCall(content: AssistantMessage["content"][number]): content is ToolCall {
	return content.type === "toolCall" && content.name === CONTEXT_DELETE_TOOL_NAME;
}

function textContentFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

export function parseContextDeletionResponse(response: AssistantMessage): ContextDeletionRequest {
	const toolCalls = response.content.filter(isContextDeleteToolCall);
	if (toolCalls.length > 1) {
		throw new Error(`Context compaction assistant called ${CONTEXT_DELETE_TOOL_NAME} more than once`);
	}
	const toolCall = toolCalls[0];
	if (toolCall) {
		return contextDeletionRequestFromObject(toolCall.arguments, `${CONTEXT_DELETE_TOOL_NAME} arguments`);
	}

	const textContent = textContentFromResponse(response);
	if (textContent.trim().length === 0) {
		throw new Error(`Context compaction assistant did not call ${CONTEXT_DELETE_TOOL_NAME}`);
	}
	return parseContextDeletionRequest(textContent);
}

function truncateForPrompt(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} more characters omitted from context compaction prompt]`;
}

function transcriptEntryFilePayload(entry: CompactableTranscriptEntry): unknown {
	return {
		entryId: entry.entryId,
		entryType: entry.entryType,
		role: entry.role,
		protected: entry.protected,
		tokenEstimate: entry.tokenEstimate,
		toolCallIds: entry.toolCallIds,
		toolResultFor: entry.toolResultFor,
		text: entry.text,
		contentBlocks: entry.contentBlocks.map((block) => ({
			blockIndex: block.blockIndex,
			type: block.type,
			protected: block.protected,
			toolCallId: block.toolCallId,
			tokenEstimate: block.tokenEstimate,
			text: block.text,
		})),
	};
}

interface ContextCompactionTranscriptFile {
	path: string;
	cleanup(): void;
}

function writeContextCompactionTranscriptFile(transcript: CompactableTranscript): ContextCompactionTranscriptFile {
	const directory = mkdtempSync(join(tmpdir(), "atomic-context-transcript-"));
	const path = join(directory, "transcript.jsonl");
	const lines = transcript.entries
		.filter((entry) => !isExcludedFromLlmContext(entry.message))
		.map((entry) => JSON.stringify(transcriptEntryFilePayload(entry)));
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return {
		path,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

function contextCompactionTranscriptManifest(transcript: CompactableTranscript, transcriptFilePath: string): unknown {
	const eligibleEntries = transcript.entries.filter((entry) => !isExcludedFromLlmContext(entry.message));
	const selectedEntryIds = new Set<string>();
	const selectedEntries: CompactableTranscriptEntry[] = [];
	const addEntry = (entry: CompactableTranscriptEntry): void => {
		if (selectedEntryIds.has(entry.entryId) || selectedEntries.length >= CONTEXT_MANIFEST_MAX_ENTRIES) return;
		selectedEntryIds.add(entry.entryId);
		selectedEntries.push(entry);
	};

	for (const entry of eligibleEntries.filter((entry) => entry.protected)) {
		addEntry(entry);
	}
	for (const entry of [...eligibleEntries]
		.filter((entry) => !entry.protected)
		.sort((left, right) => right.tokenEstimate - left.tokenEstimate)) {
		addEntry(entry);
	}
	selectedEntries.sort((left, right) => eligibleEntries.indexOf(left) - eligibleEntries.indexOf(right));

	return {
		transcriptFilePath,
		transcriptFileFormat: "jsonl: one compactable transcript entry per line with full text and contentBlocks text",
		totalEntries: eligibleEntries.length,
		manifestEntries: selectedEntries.length,
		omittedEntries: Math.max(0, eligibleEntries.length - selectedEntries.length),
		tokensBefore: transcript.tokensBefore,
		protectedEntryIds: transcript.protectedEntryIds,
		entries: selectedEntries.map((entry) => ({
			entryId: entry.entryId,
			role: entry.role,
			protected: entry.protected,
			tokenEstimate: entry.tokenEstimate,
			toolCallIds: entry.toolCallIds,
			toolResultFor: entry.toolResultFor,
			contentBlockCount: entry.contentBlocks.length,
			contentBlocks: entry.contentBlocks.map((block) => ({
				blockIndex: block.blockIndex,
				type: block.type,
				protected: block.protected,
				toolCallId: block.toolCallId,
				tokenEstimate: block.tokenEstimate,
			})),
			preview: truncateForPrompt(entry.text, CONTEXT_MANIFEST_PREVIEW_CHARS),
		})),
	};
}

function contextCompactionModePrompt(mode: ContextCompactionMode): string {
	if (mode === "critical_overflow") {
		return `\n<critical-overflow-mode>\nThe previous model request overflowed its context window. This is a critical LRU-style compaction pass. First delete stale unprotected context. If that is not enough, you may also delete the earliest protected entries or protected content shown in the manifest. Evict old low-signal context first, including old reasoning/thinking traces when they are not part of the latest retained assistant message, then older user/custom/summary context while preserving recent entries, unresolved errors, failed commands, and enough task-bearing context for the assistant to continue.\n\nSafety invariant: the latest retained assistant message cannot be modified when it contains content blocks with type "thinking" or "redacted_thinking". Do not delete, target, or suggest any content block in that latest thinking-bearing assistant message, including sibling text or tool-call blocks. Older non-latest thinking/redacted_thinking blocks may be deleted during critical overflow when validation allows it.\n</critical-overflow-mode>`;
	}
	return `\n<standard-mode>\nDo not delete entries or content blocks marked protected. Protected context is only eligible during critical overflow recovery, not during standard compaction.\n</standard-mode>`;
}

export function buildContextCompactionPrompt(
	transcript: CompactableTranscript,
	transcriptFilePath = "<transcript file will be written during context compaction>",
	mode: ContextCompactionMode = "standard",
): string {
	return `${CONTEXT_COMPACTION_FIXED_PROMPT}${contextCompactionModePrompt(mode)}\n\n<transcript-file>\n${transcriptFilePath}\n</transcript-file>\n\n<context-manifest>\n${JSON.stringify(contextCompactionTranscriptManifest(transcript, transcriptFilePath), null, 2)}\n</context-manifest>`;
}

function createContextCompactionAssistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage !== undefined ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function createContextCompactionStopStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = createContextCompactionAssistantMessage(model, [{ type: "text", text }], "stop");
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

function isContextCompactionOverflowError(model: Model<Api>, errorMessage: string): boolean {
	return isContextOverflow(
		createContextCompactionAssistantMessage(model, [], "error", errorMessage),
		model.contextWindow,
	);
}

interface ContextDeletionRun {
	validatedResult: ValidatedContextDeletionResult | undefined;
	lastToolError: string | undefined;
}

async function runContextDeletionAssistant(
	transcript: CompactableTranscript,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel: ThinkingLevel = "off",
	mode: ContextCompactionMode = "standard",
): Promise<ContextDeletionRun> {
	const maxTokens = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	if (signal?.aborted) {
		throw new Error("Context compaction failed: Request was aborted");
	}
	const transcriptFile = writeContextCompactionTranscriptFile(transcript);
	const promptMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: buildContextCompactionPrompt(transcript, transcriptFile.path, mode) }],
		timestamp: Date.now(),
	};
	const deletionTool = createContextDeletionTool(transcript, { mode });
	let compactionTurnCount = 0;
	const agent = new Agent({
		initialState: {
			systemPrompt: CONTEXT_COMPACTION_SYSTEM_PROMPT,
			model,
			thinkingLevel,
			tools: deletionTool.tools,
		},
		toolExecution: "parallel",
		streamFn: async (requestModel, context, streamOptions) => {
			compactionTurnCount += 1;
			if (compactionTurnCount > CONTEXT_COMPACTION_MAX_TURNS) {
				return createContextCompactionStopStream(
					requestModel,
					`Reached the context compaction turn cap (${CONTEXT_COMPACTION_MAX_TURNS}); using the deletions recorded so far.`,
				);
			}
			return streamSimple(requestModel, context, {
				...streamOptions,
				maxTokens,
				apiKey,
				headers: headers ?? streamOptions?.headers,
			});
		},
	});

	const abortOnSignal = () => agent.abort();
	signal?.addEventListener("abort", abortOnSignal, { once: true });
	try {
		await agent.prompt(promptMessage);
	} finally {
		signal?.removeEventListener("abort", abortOnSignal);
		transcriptFile.cleanup();
	}

	if (signal?.aborted) {
		throw new Error("Context compaction failed: Request was aborted");
	}
	if (agent.state.errorMessage) {
		if (isContextCompactionOverflowError(model, agent.state.errorMessage)) {
			return {
				validatedResult: deletionTool.getValidatedResult(),
				lastToolError: deletionTool.getLastError(),
			};
		}
		throw new Error(`Context compaction failed: ${agent.state.errorMessage}`);
	}
	if (deletionTool.getCallCount() === 0) {
		throw new Error(
			`Context compaction did not call any transcript inspection or deletion tools (${CONTEXT_SEARCH_TRANSCRIPT_TOOL_NAME}, ${CONTEXT_READ_ENTRY_TOOL_NAME}, ${CONTEXT_DELETE_TOOL_NAME}, or ${CONTEXT_GREP_DELETE_TOOL_NAME})`,
		);
	}
	return {
		validatedResult: deletionTool.getValidatedResult(),
		lastToolError: deletionTool.getLastError(),
	};
}

export async function contextCompact(
	preparation: ContextCompactionPreparation,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel: ThinkingLevel = "off",
	mode: ContextCompactionMode = preparation.mode ?? "standard",
): Promise<ValidatedContextDeletionResult> {
	const { validatedResult, lastToolError } = await runContextDeletionAssistant(
		preparation.transcript,
		model,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		mode,
	);
	if (!validatedResult || validatedResult.deletedTargets.length === 0) {
		throw new Error(
			lastToolError ? `No safe context deletions proposed; last deletion tool error: ${lastToolError}` : "No safe context deletions proposed",
		);
	}
	return validatedResult;
}
