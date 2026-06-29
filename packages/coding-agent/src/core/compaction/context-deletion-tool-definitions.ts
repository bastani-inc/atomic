import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type { ContextCompactionStats, ContextDeletionTarget } from "../session-manager.ts";
import type { ContextDeletionRequest, ValidatedContextDeletionResult } from "./context-compaction-types.ts";

export const CONTEXT_DELETE_TOOL_NAME = "context_delete";
export const CONTEXT_GREP_DELETE_TOOL_NAME = "context_grep_delete";
export const CONTEXT_SEARCH_TRANSCRIPT_TOOL_NAME = "context_search_transcript";
export const CONTEXT_READ_ENTRY_TOOL_NAME = "context_read_entry";
export const CONTEXT_COMPACTION_BUDGET_TOOL_NAME = "context_compaction_budget";
export const CONTEXT_GREP_DELETE_DEFAULT_MAX_MATCHES = 50;
export const CONTEXT_GREP_DELETE_MAX_REGEX_PATTERN_CHARS = 512;
export const CONTEXT_GREP_DELETE_MAX_REGEX_SCAN_CHARS = 250_000;
export const CONTEXT_READ_ENTRY_DEFAULT_MAX_CHARS = 4000;
export const CONTEXT_READ_ENTRY_MAX_CHARS = 12_000;
export const CONTEXT_SEARCH_DEFAULT_MAX_MATCHES = 20;
export const CONTEXT_SEARCH_MAX_MATCHES = 100;
export const CONTEXT_SEARCH_DEFAULT_CONTEXT_CHARS = 160;
export const CONTEXT_SEARCH_MAX_CONTEXT_CHARS = 500;


export const ContextDeleteToolParameters = Type.Object(
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
			{
				description:
					"ID-only deletion targets. Include only kind, entryId, and blockIndex when needed; do not include transcript text, block contents, summaries, or replacement content. Invalid targets are rejected by the tool with correction guidance.",
			},
		),
	},
	{ additionalProperties: false },
);

export const ContextGrepDeleteToolParameters = Type.Object(
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
					"Per-call safety cap. If more not-yet-deleted candidate targets are found in this tool call, no deletions are applied. Defaults to 50. This is not a cumulative compaction cap; call the tool again for additional batches.",
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

export const ContextSearchTranscriptToolParameters = Type.Object(
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

export const ContextReadEntryToolParameters = Type.Object(
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

export const ContextCompactionBudgetToolParameters = Type.Object({}, { additionalProperties: false });

export const CONTEXT_DELETE_TOOL = {
	name: CONTEXT_DELETE_TOOL_NAME,
	description: "Record context compaction deletion targets directly against the transcript.",
	parameters: ContextDeleteToolParameters,
} as const;

export const CONTEXT_GREP_DELETE_TOOL = {
	name: CONTEXT_GREP_DELETE_TOOL_NAME,
	description: "Bulk-delete transcript entries or content blocks matching a guarded grep/regex query.",
	parameters: ContextGrepDeleteToolParameters,
} as const;

export const CONTEXT_SEARCH_TRANSCRIPT_TOOL = {
	name: CONTEXT_SEARCH_TRANSCRIPT_TOOL_NAME,
	description: "Search the full transcript working copy and return small snippets without mutating deletion state.",
	parameters: ContextSearchTranscriptToolParameters,
} as const;

export const CONTEXT_READ_ENTRY_TOOL = {
	name: CONTEXT_READ_ENTRY_TOOL_NAME,
	description: "Read a small slice of one transcript entry or content block from the full transcript working copy.",
	parameters: ContextReadEntryToolParameters,
} as const;

export const CONTEXT_COMPACTION_BUDGET_TOOL = {
	name: CONTEXT_COMPACTION_BUDGET_TOOL_NAME,
	description:
		"Report current context-window fullness and reduction progress for the selected deletion targets without mutating deletion state.",
	parameters: ContextCompactionBudgetToolParameters,
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

export interface ContextCompactionBudgetToolDetails {
	contextWindow?: number;
	compression_ratio: number;
	tokensBefore: number;
	currentTokensAfter: number;
	deletedTokens: number;
	currentReductionPercent: number;
	targetReductionPercent: number;
	targetTokensAfter: number;
	tokensToDeleteForTarget: number;
	contextWindowBeforePercent?: number;
	contextWindowAfterPercent?: number;
	/** Total estimated tokens consumed by image content blocks still remaining after selected deletions. */
	remainingImageTokens: number;
	/** Number of image content blocks still remaining after selected deletions. */
	imageBlockCount: number;
	/** Image tokens as a percentage of the remaining context (post-deletion token total). */
	imageTokenPercent: number;
	callCount: number;
}

export interface ContextDeletionToolController {
	tool: AgentTool<typeof ContextDeleteToolParameters, ContextDeletionToolDetails>;
	grepTool: AgentTool<typeof ContextGrepDeleteToolParameters, ContextGrepDeletionToolDetails>;
	searchTool: AgentTool<typeof ContextSearchTranscriptToolParameters, ContextTranscriptSearchToolDetails>;
	readEntryTool: AgentTool<typeof ContextReadEntryToolParameters, ContextReadEntryToolDetails>;
	budgetTool: AgentTool<typeof ContextCompactionBudgetToolParameters, ContextCompactionBudgetToolDetails>;
	tools: AgentTool[];
	getDeletionRequest(): ContextDeletionRequest;
	getValidatedResult(): ValidatedContextDeletionResult | undefined;
	getLastError(): string | undefined;
	getCallCount(): number;
}
