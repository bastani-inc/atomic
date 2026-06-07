import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
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

const CONTEXT_COMPACTION_SYSTEM_PROMPT =
	"You are a context compaction planner for an AI coding assistant transcript. Return deletion targets only.";

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
Return JSON only in this exact shape:
{ "deletions": [{ "kind": "entry", "entryId": "..." }] }

For content-block deletions, use:
{ "kind": "content_block", "entryId": "...", "blockIndex": 0 }

Do not include prose outside the JSON object.
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
	const deletedEntryIds = new Set<string>();
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
		if (normalized.kind === "entry") deletedEntryIds.add(normalized.entryId);
	}

	for (const target of deletedTargets) {
		if (target.kind === "content_block" && deletedEntryIds.has(target.entryId)) {
			throw new Error(`Deletion target ${targetKey(target)} overlaps with entry deletion`);
		}
	}

	const deletedContentBlocks = getDeletedContentBlocks(deletedTargets);
	for (const [entryId, blockIndexes] of deletedContentBlocks) {
		const entry = entryById.get(entryId);
		if (entry?.contentBlocks.every((block) => blockIndexes.has(block.blockIndex))) {
			throw new Error(`Content-block deletions for ${entryId} would remove every content block`);
		}
	}

	validateToolDependencies(transcript, deletedTargets);

	const remainingEntries = transcript.entries.filter((entry) => !deletedEntryIds.has(entry.entryId));
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
		deletedTargets,
		protectedEntryIds: [...transcript.protectedEntryIds],
		stats: computeContextCompactionStats(transcript, deletedTargets),
	};
}

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenceMatch?.[1]?.trim() ?? trimmed;
}

export function parseContextDeletionPlan(text: string): RawContextDeletionPlan {
	const stripped = stripJsonFence(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch (error) {
		throw new Error(`Failed to parse context deletion plan JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { deletions?: unknown }).deletions)) {
		throw new Error("Context deletion plan JSON must contain a deletions array");
	}
	return parsed as RawContextDeletionPlan;
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

export async function planContextDeletions(
	transcript: CompactableTranscript,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RawContextDeletionPlan> {
	const maxTokens = Math.min(4096, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: buildContextCompactionPrompt(transcript) }],
			timestamp: Date.now(),
		},
	];
	const options =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, apiKey, headers, reasoning: thinkingLevel }
			: { maxTokens, signal, apiKey, headers };
	const response = await completeSimple(model, { systemPrompt: CONTEXT_COMPACTION_SYSTEM_PROMPT, messages }, options);
	if (response.stopReason === "error") {
		throw new Error(`Context compaction planning failed: ${response.errorMessage || "Unknown error"}`);
	}
	const textContent = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseContextDeletionPlan(textContent);
}

export async function contextCompact(
	preparation: ContextCompactionPreparation,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<ValidatedContextDeletionPlan> {
	const plan = await planContextDeletions(preparation.transcript, model, apiKey, headers, signal, thinkingLevel);
	const validated = validateContextDeletionPlan(plan, preparation.transcript);
	if (validated.deletedTargets.length === 0) {
		throw new Error("No safe context deletions proposed");
	}
	return validated;
}
