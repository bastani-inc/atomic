import { Agent, type AgentMessage, type AgentTool, type AgentToolResult, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, streamSimple, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import {
	buildContextDeletionFilteredPath,
	buildContextDeletionFilters,
	type ContextCompactionStats,
	type ContextDeletionTarget,
	type SessionEntry,
} from "../session-manager.ts";
import type { CompactionSettings } from "./compaction.ts";
import { estimateTokens } from "./compaction.ts";

export const CONTEXT_COMPACTION_PROMPT_VERSION = 1 as const;

export interface RawContextDeletionPlan {
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
}

export interface ValidatedContextDeletionPlan {
	deletedTargets: ContextDeletionTarget[];
	protectedEntryIds: string[];
	stats: ContextCompactionStats;
}

export interface ContextCompactionResult extends ValidatedContextDeletionPlan {
	promptVersion: typeof CONTEXT_COMPACTION_PROMPT_VERSION;
	backupPath?: string;
}

const CONTEXT_DELETION_PLAN_TOOL_NAME = "context_deletion_plan";
const CONTEXT_GREP_DELETE_TOOL_NAME = "context_grep_delete";
export const CONTEXT_COMPACTION_PLANNER_MAX_TURNS = 8 as const;
const CONTEXT_GREP_DELETE_DEFAULT_MAX_MATCHES = 50;
const CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS = 512;
const CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS = 250_000;

const ContextDeletionPlanToolParameters = Type.Object(
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
				description: "Safety cap. If more matches are found, no deletions are applied. Defaults to 50.",
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

const CONTEXT_DELETION_PLAN_TOOL = {
	name: CONTEXT_DELETION_PLAN_TOOL_NAME,
	description: "Record context compaction deletion targets directly against the transcript.",
	parameters: ContextDeletionPlanToolParameters,
} as const;

const CONTEXT_GREP_DELETE_TOOL = {
	name: CONTEXT_GREP_DELETE_TOOL_NAME,
	description: "Bulk-delete transcript entries or content blocks matching a guarded grep/regex query.",
	parameters: ContextGrepDeleteToolParameters,
} as const;

export interface ContextDeletionPlannerToolDetails {
	deletions: RawContextDeletionPlan["deletions"];
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

export interface ContextDeletionPlannerToolController {
	tool: AgentTool<typeof ContextDeletionPlanToolParameters, ContextDeletionPlannerToolDetails>;
	grepTool: AgentTool<typeof ContextGrepDeleteToolParameters, ContextGrepDeletionToolDetails>;
	tools: AgentTool[];
	getPlan(): RawContextDeletionPlan;
	getValidatedPlan(): ValidatedContextDeletionPlan | undefined;
	getCallCount(): number;
}

const CONTEXT_COMPACTION_SYSTEM_PROMPT =
	"You are a context compaction planner for an AI coding assistant transcript. Use context_deletion_plan for exact deletions and context_grep_delete for guarded bulk deletion; do not write deletion JSON in prose.";

const CONTEXT_COMPACTION_FIXED_PROMPT = `You are a context compaction planner for an AI coding assistant transcript.

Your task is deletion-only verbatim compaction.

You MUST NOT summarize.
You MUST NOT paraphrase.
You MUST NOT generate replacement context.
You MUST NOT mutate retained transcript objects or content.
Another step will apply deletions locally. Return only deletion targets by stable ID.

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
Call the context_deletion_plan tool one or more times with deletion targets in this shape:
{ "deletions": [{ "kind": "entry", "entryId": "..." }] }

For content-block deletions, use:
{ "kind": "content_block", "entryId": "...", "blockIndex": 0 }

The tool applies and validates deletion targets immediately. You can continue calling it for additional deletions if useful.

For guarded bulk deletion by text match, call context_grep_delete with a literal pattern or regex. It skips protected context, enforces maxMatches and expectedMatchCount, and validates through the same tool-call/tool-result safety rules.

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
	if (message.role === "compactionSummary") {
		const text = message.summary;
		return [
			{
				entryId,
				blockIndex: 0,
				type: "summary",
				text,
				tokenEstimate: estimateTextTokens(text),
				protected: protectedEntry,
			},
		];
	}

	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];

	return content
		.map((block, blockIndex): CompactableContentBlock | undefined => {
			if (existingDeletedBlocks?.has(blockIndex)) return undefined;
			const text = textFromContentBlock(block);
			return {
				entryId,
				blockIndex,
				type:
					block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string"
						? ((block as { type: string }).type)
						: "unknown",
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
		case "compactionSummary":
			return message.summary;
		case "custom":
		case "toolResult":
		case "user":
			return textFromUnknownContent(message.content);
		case "assistant":
			return textFromUnknownContent(message.content);
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

function collectLatestSummaryCompactionIndex(pathEntries: SessionEntry[]): number {
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") return i;
	}
	return -1;
}

function collectActiveEntryIndices(pathEntries: SessionEntry[], latestCompactionIndex: number): number[] {
	if (latestCompactionIndex < 0) {
		return pathEntries.map((_, index) => index);
	}

	const latestCompaction = pathEntries[latestCompactionIndex];
	if (latestCompaction.type !== "compaction") return pathEntries.map((_, index) => index);

	const indices: number[] = [];
	let foundFirstKept = false;
	for (let i = 0; i < latestCompactionIndex; i++) {
		const entry = pathEntries[i];
		if (entry.id === latestCompaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) indices.push(i);
	}
	for (let i = latestCompactionIndex + 1; i < pathEntries.length; i++) {
		indices.push(i);
	}
	return indices;
}

function isProtectedEntry(
	entry: SessionEntry,
	message: AgentMessage,
	recentEntryIds: ReadonlySet<string>,
): boolean {
	if (recentEntryIds.has(entry.id)) return true;
	if (message.role === "user") return true;
	if (message.role === "custom") return true;
	if (message.role === "branchSummary" || message.role === "compactionSummary") return true;
	if (hasAssistantError(message) || hasToolResultError(message)) return true;
	if (hasFailedBashExecution(message)) return true;
	if (entry.type === "branch_summary") return true;
	return false;
}

export function prepareContextCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): ContextCompactionPreparation | undefined {
	if (pathEntries.length === 0) return undefined;

	const latestCompactionIndex = collectLatestSummaryCompactionIndex(pathEntries);
	const deletionFilters = buildContextDeletionFilters(pathEntries);
	const filteredPathEntries = buildContextDeletionFilteredPath(pathEntries, deletionFilters);
	const filteredEntryById = new Map(filteredPathEntries.map((entry) => [entry.id, entry]));
	const activeEntryIndices = collectActiveEntryIndices(pathEntries, latestCompactionIndex);
	const messageEntryIds = activeEntryIndices
		.map((index) => filteredEntryById.get(pathEntries[index].id))
		.filter((entry): entry is SessionEntry => entry !== undefined && getContextEligibleMessageFromEntry(entry) !== undefined)
		.map((entry) => entry.id);
	const recentEntryIds = new Set(messageEntryIds.slice(-5));
	const protectedEntryIds = new Set<string>();
	const entries: CompactableTranscriptEntry[] = [];

	if (latestCompactionIndex >= 0) {
		const latestCompaction = pathEntries[latestCompactionIndex];
		if (latestCompaction.type === "compaction") {
			const message = createCompactionSummaryMessage(
				latestCompaction.summary,
				latestCompaction.tokensBefore,
				latestCompaction.timestamp,
			);
			const contentBlocks = contentBlocksForEntry(latestCompaction.id, message, true, undefined);
			protectedEntryIds.add(latestCompaction.id);
			entries.push({
				entryId: latestCompaction.id,
				entryType: latestCompaction.type,
				role: message.role,
				text: messageText(message),
				tokenEstimate: estimateTokens(message),
				protected: true,
				contentBlocks,
				message,
				toolCallIds: [],
				toolResultFor: undefined,
			});
		}
	}

	for (const index of activeEntryIndices) {
		const rawEntry = pathEntries[index];
		const entry = filteredEntryById.get(rawEntry.id);
		if (!entry || entry.type === "context_compaction") continue;
		const message = getContextEligibleMessageFromEntry(entry);
		if (!message) continue;
		const protectedEntry = isProtectedEntry(entry, message, recentEntryIds);
		if (protectedEntry) protectedEntryIds.add(entry.id);
		const rawMessage = getContextEligibleMessageFromEntry(rawEntry) ?? message;
		const contentBlocks = contentBlocksForEntry(
			entry.id,
			rawMessage,
			protectedEntry,
			deletionFilters.deletedContentBlocks.get(entry.id),
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

function rawTargetKey(target: RawContextDeletionPlan["deletions"][number]): string {
	return target.kind === "entry" ? `entry:${target.entryId}` : `content_block:${target.entryId}:${target.blockIndex}`;
}

function normalizeRawTarget(target: RawContextDeletionPlan["deletions"][number]): ContextDeletionTarget {
	if (target.kind === "entry") return { kind: "entry", entryId: target.entryId };
	return { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex as number };
}

function rawDeletionFromTarget(target: ContextDeletionTarget): RawContextDeletionPlan["deletions"][number] {
	if (target.kind === "entry") return { kind: "entry", entryId: target.entryId };
	return { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex };
}

function planFromTargets(targets: readonly ContextDeletionTarget[]): RawContextDeletionPlan {
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

	let changed = true;
	let remainingPasses = Math.max(1, transcript.entries.length * 2);
	while (changed && remainingPasses > 0) {
		changed = false;
		remainingPasses -= 1;

		for (const [callId, callEntry] of callEntries) {
			let deletedEntryIds = getDeletedEntryIds(targets);
			let deletedContentBlocks = getDeletedContentBlocks(targets);
			const callDeleted = isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks);
			const results = resultEntries.get(callId) ?? [];

			if (callDeleted) {
				const retainedProtectedResult = results.find((entry) => entry.protected && !deletedEntryIds.has(entry.entryId));
				if (retainedProtectedResult) {
					changed = removeToolCallDeletion(targets, callEntry, callId) || changed;
				} else {
					for (const result of results) {
						changed = deleteEntryTarget(targets, result.entryId) || changed;
					}
				}
			}

			deletedEntryIds = getDeletedEntryIds(targets);
			deletedContentBlocks = getDeletedContentBlocks(targets);
			if (isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks)) continue;

			for (const result of results) {
				if (!deletedEntryIds.has(result.entryId)) continue;
				changed = deleteEntryTarget(targets, result.entryId) || changed;
				if (callEntry.protected) {
					changed = removeEntryDeletion(targets, result.entryId) || changed;
					continue;
				}
				changed = addToolCallDeletion(targets, callEntry, callId) || changed;
			}
		}

		for (const entry of entriesWithToolCalls) {
			changed = canonicalizeEntryTargets(targets, entry) || changed;
		}
	}

	if (changed) {
		console.warn(
			"Context compaction tool dependency reconciliation did not converge within the bounded pass limit; validation will continue with the last reconciled target set.",
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

export function validateContextDeletionPlan(
	plan: RawContextDeletionPlan,
	transcript: CompactableTranscript,
): ValidatedContextDeletionPlan {
	if (!plan || typeof plan !== "object" || !Array.isArray(plan.deletions)) {
		throw new Error("Context deletion plan must be an object with a deletions array");
	}

	const entryById = new Map(transcript.entries.map((entry) => [entry.entryId, entry]));
	const seen = new Set<string>();
	const deletedTargets: ContextDeletionTarget[] = [];

	for (const deletion of plan.deletions) {
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
		if (entry.protected) {
			throw new Error(`Deletion target ${deletion.entryId} is protected`);
		}

		if (deletion.kind === "content_block") {
			if (!Number.isInteger(deletion.blockIndex) || deletion.blockIndex === undefined || deletion.blockIndex < 0) {
				throw new Error(`Invalid content block index for entry ${deletion.entryId}`);
			}
			const block = entry.contentBlocks.find((item) => item.blockIndex === deletion.blockIndex);
			if (!block) {
				throw new Error(`Unknown content block ${deletion.blockIndex} for entry ${deletion.entryId}`);
			}
			if (block.protected) {
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
		const normalized = normalizeRawTarget(deletion);
		deletedTargets.push(normalized);
	}

	const reconciledTargets = reconcileToolDependencies(transcript, deletedTargets);
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
		throw new Error("Deletion plan would remove all context entries");
	}
	const hasTaskBearingContext = remainingEntries.some(
		(entry) => entry.role === "user" || (entry.role === "compactionSummary" && entry.protected),
	);
	if (!hasTaskBearingContext) {
		throw new Error("Deletion plan would leave no user task in context");
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

function rawContextDeletionPlanFromObject(value: unknown, source: string): RawContextDeletionPlan {
	if (!value || typeof value !== "object" || !Array.isArray((value as { deletions?: unknown }).deletions)) {
		throw new Error(`${source} must contain a deletions array`);
	}
	return value as RawContextDeletionPlan;
}

function escapeRegExpLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createPlannerToolResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return { content: [{ type: "text", text }], details, terminate: false };
}

function createGrepMatcher(pattern: string, regex: boolean, caseSensitive: boolean): RegExp {
	if (regex && pattern.length > CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS) {
		throw new Error(
			`Regex pattern is too long (${pattern.length} characters); maximum is ${CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS}`,
		);
	}

	try {
		return new RegExp(regex ? pattern : escapeRegExpLiteral(pattern), caseSensitive ? "u" : "iu");
	} catch (error) {
		throw new Error(`Invalid grep ${regex ? "regex" : "pattern"}: ${formatErrorMessage(error)}`);
	}
}

function getGrepScanTextLength(transcript: CompactableTranscript, target: "entry" | "content_block"): number {
	if (target === "entry") {
		return transcript.entries.reduce((total, entry) => total + entry.text.length, 0);
	}
	return transcript.entries.reduce(
		(total, entry) => total + entry.contentBlocks.reduce((entryTotal, block) => entryTotal + block.text.length, 0),
		0,
	);
}

function assertSafeRegexScan(transcript: CompactableTranscript, target: "entry" | "content_block"): void {
	const scanChars = getGrepScanTextLength(transcript, target);
	if (scanChars <= CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS) return;
	throw new Error(
		`Regex grep would scan ${scanChars} characters; maximum is ${CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS}. Use a literal pattern or exact deletion targets instead.`,
	);
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

export function createContextDeletionPlannerTool(
	transcript: CompactableTranscript,
): ContextDeletionPlannerToolController {
	let deletedTargets: ContextDeletionTarget[] = [];
	let validatedPlan: ValidatedContextDeletionPlan | undefined;
	let callCount = 0;

	function applyValidatedTargets(additionalTargets: readonly ContextDeletionTarget[]): ValidatedContextDeletionPlan {
		const mergedTargets = mergeContextDeletionTargets(deletedTargets, additionalTargets);
		validatedPlan = validateContextDeletionPlan(planFromTargets(mergedTargets), transcript);
		deletedTargets = validatedPlan.deletedTargets;
		return validatedPlan;
	}

	function currentStats(): ContextCompactionStats {
		return validatedPlan?.stats ?? computeContextCompactionStats(transcript, deletedTargets);
	}

	const tool: AgentTool<typeof ContextDeletionPlanToolParameters, ContextDeletionPlannerToolDetails> = {
		...CONTEXT_DELETION_PLAN_TOOL,
		label: "context deletion plan",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			callCount += 1;
			try {
				const incomingPlan = rawContextDeletionPlanFromObject(params, `${CONTEXT_DELETION_PLAN_TOOL_NAME} arguments`);
				const incomingValidated = validateContextDeletionPlan(incomingPlan, transcript);
				const applied = applyValidatedTargets(incomingValidated.deletedTargets);

				const details: ContextDeletionPlannerToolDetails = {
					deletions: planFromTargets(deletedTargets).deletions,
					deletedTargets,
					stats: applied.stats,
					callCount,
				};
				const text = `Recorded ${incomingValidated.deletedTargets.length} deletion target(s); ${deletedTargets.length} total validated deletion target(s) are selected. Continue calling ${CONTEXT_DELETION_PLAN_TOOL_NAME} or ${CONTEXT_GREP_DELETE_TOOL_NAME} for additional deletions, or respond done when finished.`;
				return createPlannerToolResult(text, details);
			} catch (error) {
				const message = formatErrorMessage(error);
				const details: ContextDeletionPlannerToolDetails = {
					deletions: planFromTargets(deletedTargets).deletions,
					deletedTargets,
					stats: currentStats(),
					callCount,
					error: message,
				};
				return createPlannerToolResult(
					`Error recording context deletion targets: ${message}. No new deletion targets were applied; continue with a corrected tool call.`,
					details,
				);
			}
		},
	};

	const grepTool: AgentTool<typeof ContextGrepDeleteToolParameters, ContextGrepDeletionToolDetails> = {
		...CONTEXT_GREP_DELETE_TOOL,
		label: "context grep delete",
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			callCount += 1;
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
					assertSafeRegexScan(transcript, target);
				}
				const matcher = createGrepMatcher(pattern, regex, caseSensitive);

				for (const entry of transcript.entries) {
					if (target === "entry") {
						if (!matcher.test(entry.text)) continue;
						if (entry.protected) {
							skipped.push({ entryId: entry.entryId, target, reason: "protected_entry", text: entry.text });
							continue;
						}
						const candidate: ContextDeletionTarget = { kind: "entry", entryId: entry.entryId };
						if (currentTargetDeleted(deletedTargets, candidate)) {
							skipped.push({ entryId: entry.entryId, target, reason: "already_deleted", text: entry.text });
							continue;
						}
						addGrepCandidate(candidates, matches, seenTargets, candidate, {
							entryId: entry.entryId,
							target,
							text: entry.text,
						});
						continue;
					}

					for (const block of entry.contentBlocks) {
						if (!matcher.test(block.text)) continue;
						if (entry.protected) {
							skipped.push({
								entryId: entry.entryId,
								target,
								blockIndex: block.blockIndex,
								reason: "protected_entry",
								text: block.text,
							});
							continue;
						}
						if (block.protected) {
							skipped.push({
								entryId: entry.entryId,
								target,
								blockIndex: block.blockIndex,
								reason: "protected_block",
								text: block.text,
							});
							continue;
						}
						const candidate: ContextDeletionTarget =
							entry.contentBlocks.length <= 1
								? { kind: "entry", entryId: entry.entryId }
								: { kind: "content_block", entryId: entry.entryId, blockIndex: block.blockIndex };
						if (currentTargetDeleted(deletedTargets, candidate)) {
							skipped.push({
								entryId: entry.entryId,
								target: candidate.kind,
								...(candidate.kind === "content_block" ? { blockIndex: candidate.blockIndex } : {}),
								reason: "already_deleted",
								text: block.text,
							});
							continue;
						}
						addGrepCandidate(candidates, matches, seenTargets, candidate, {
							entryId: entry.entryId,
							target: candidate.kind,
							...(candidate.kind === "content_block" ? { blockIndex: candidate.blockIndex } : {}),
							text: block.text,
						});
					}
				}

				let applied: ValidatedContextDeletionPlan | undefined;
				if (params.expectedMatchCount !== undefined && candidates.length !== params.expectedMatchCount) {
					skipped.push({ reason: "expected_match_count_mismatch" });
				} else if (candidates.length > maxMatches) {
					skipped.push({ reason: "max_matches_exceeded" });
				} else if (candidates.length > 0) {
					applied = applyValidatedTargets(candidates);
				}

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
				const text = `Matched ${matches.length} unprotected target(s), skipped ${skipped.length}, and ${applied ? "applied" : "did not apply"} grep deletion for pattern ${JSON.stringify(pattern)}. Total validated deletion target(s): ${deletedTargets.length}.`;
				return createPlannerToolResult(text, details);
			} catch (error) {
				const message = formatErrorMessage(error);
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
				return createPlannerToolResult(
					`Error applying grep deletion for pattern ${JSON.stringify(pattern)}: ${message}. No new deletion targets were applied; continue with a corrected tool call.`,
					details,
				);
			}
		},
	};

	return {
		tool,
		grepTool,
		tools: [tool, grepTool],
		getPlan: () => planFromTargets(deletedTargets),
		getValidatedPlan: () => validatedPlan,
		getCallCount: () => callCount,
	};
}

export function parseContextDeletionPlan(text: string): RawContextDeletionPlan {
	const stripped = stripJsonFence(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch (error) {
		throw new Error(`Failed to parse context deletion plan JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return rawContextDeletionPlanFromObject(parsed, "Context deletion plan JSON");
}

function isContextDeletionPlanToolCall(content: AssistantMessage["content"][number]): content is ToolCall {
	return content.type === "toolCall" && content.name === CONTEXT_DELETION_PLAN_TOOL_NAME;
}

function textContentFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

export function parseContextDeletionPlanResponse(response: AssistantMessage): RawContextDeletionPlan {
	const toolCalls = response.content.filter(isContextDeletionPlanToolCall);
	if (toolCalls.length > 1) {
		throw new Error(`Context compaction planner called ${CONTEXT_DELETION_PLAN_TOOL_NAME} more than once`);
	}
	const toolCall = toolCalls[0];
	if (toolCall) {
		return rawContextDeletionPlanFromObject(toolCall.arguments, `${CONTEXT_DELETION_PLAN_TOOL_NAME} arguments`);
	}

	const textContent = textContentFromResponse(response);
	if (textContent.trim().length === 0) {
		throw new Error(`Context compaction planner did not call ${CONTEXT_DELETION_PLAN_TOOL_NAME}`);
	}
	return parseContextDeletionPlan(textContent);
}

function truncateForPrompt(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} more characters omitted from planner prompt]`;
}

function plannerTranscriptPayload(transcript: CompactableTranscript): unknown {
	return transcript.entries
		.filter((entry) => !isExcludedFromLlmContext(entry.message))
		.map((entry) => ({
			entryId: entry.entryId,
			role: entry.role,
			protected: entry.protected,
			tokenEstimate: entry.tokenEstimate,
			toolCallIds: entry.toolCallIds,
			toolResultFor: entry.toolResultFor,
			contentBlocks: entry.contentBlocks.map((block) => ({
				blockIndex: block.blockIndex,
				type: block.type,
				protected: block.protected,
				toolCallId: block.toolCallId,
				text: truncateForPrompt(block.text, 2000),
			})),
			text: truncateForPrompt(entry.text, 4000),
		}));
}

export function buildContextCompactionPrompt(transcript: CompactableTranscript): string {
	return `${CONTEXT_COMPACTION_FIXED_PROMPT}\n\n<transcript-json>\n${JSON.stringify(plannerTranscriptPayload(transcript), null, 2)}\n</transcript-json>`;
}

function createContextCompactionPlannerErrorStream(model: Model<Api>, errorMessage: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
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
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: message });
		stream.end(message);
	});
	return stream;
}

interface ContextDeletionPlanningRun {
	plan: RawContextDeletionPlan;
	validatedPlan: ValidatedContextDeletionPlan | undefined;
}

async function runContextDeletionPlanner(
	transcript: CompactableTranscript,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<ContextDeletionPlanningRun> {
	const maxTokens = Math.min(4096, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
	const promptMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: buildContextCompactionPrompt(transcript) }],
		timestamp: Date.now(),
	};
	const plannerTool = createContextDeletionPlannerTool(transcript);
	const effectiveThinkingLevel = model.reasoning && thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : "off";
	let plannerTurnCount = 0;
	const agent = new Agent({
		initialState: {
			systemPrompt: CONTEXT_COMPACTION_SYSTEM_PROMPT,
			model,
			thinkingLevel: effectiveThinkingLevel,
			tools: plannerTool.tools,
		},
		toolExecution: "sequential",
		streamFn: async (requestModel, context, streamOptions) => {
			plannerTurnCount += 1;
			if (plannerTurnCount > CONTEXT_COMPACTION_PLANNER_MAX_TURNS) {
				return createContextCompactionPlannerErrorStream(
					requestModel,
					`planner exceeded ${CONTEXT_COMPACTION_PLANNER_MAX_TURNS} turns without finishing`,
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

	if (signal?.aborted) {
		throw new Error("Context compaction planning failed: Request was aborted");
	}
	const abortOnSignal = () => agent.abort();
	signal?.addEventListener("abort", abortOnSignal, { once: true });
	try {
		await agent.prompt(promptMessage);
	} finally {
		signal?.removeEventListener("abort", abortOnSignal);
	}

	if (signal?.aborted) {
		throw new Error("Context compaction planning failed: Request was aborted");
	}
	if (agent.state.errorMessage) {
		throw new Error(`Context compaction planning failed: ${agent.state.errorMessage}`);
	}
	if (plannerTool.getCallCount() === 0) {
		throw new Error(`Context compaction planner did not call ${CONTEXT_DELETION_PLAN_TOOL_NAME} or ${CONTEXT_GREP_DELETE_TOOL_NAME}`);
	}
	return { plan: plannerTool.getPlan(), validatedPlan: plannerTool.getValidatedPlan() };
}

export async function planContextDeletions(
	transcript: CompactableTranscript,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RawContextDeletionPlan> {
	return (await runContextDeletionPlanner(transcript, model, apiKey, headers, signal, thinkingLevel)).plan;
}

export async function contextCompact(
	preparation: ContextCompactionPreparation,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<ValidatedContextDeletionPlan> {
	const { validatedPlan } = await runContextDeletionPlanner(
		preparation.transcript,
		model,
		apiKey,
		headers,
		signal,
		thinkingLevel,
	);
	if (!validatedPlan || validatedPlan.deletedTargets.length === 0) {
		throw new Error("No safe context deletions proposed");
	}
	return validatedPlan;
}
