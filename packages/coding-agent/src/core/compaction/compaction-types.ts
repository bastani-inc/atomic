import type { Usage } from "@bastani/atomic-ai/compat";
import type { CompactionSettings } from "./compaction.ts";

export const VERBATIM_COMPACTION_PROMPT_VERSION = 7 as const;
/** First prompt version whose durable transcripts carry no `[Assistant thinking]: ` sections. */
export const THINKING_FREE_PROMPT_VERSION = 5;
/** First prompt version whose boundary text is the whole `Context cleared` or `Context compacted` message. */
export const CONTEXT_CLEARED_PROMPT_VERSION = 7;
export const VERBATIM_COMPACTION_STRATEGY = "verbatim-lines" as const;

export interface VerbatimCompactionParameters {
	/** The `/compact` instructions, or else the latest user request. */
	query: string;
}

export interface LineRange {
	/** One-based inclusive first line. */
	start: number;
	/** One-based inclusive last line. */
	end: number;
}

/** The conversation since the last boundary, serialized one line per element, for extension hooks. */
export interface NumberedRegion {
	readonly __brand: "NumberedRegion";
	lines: string[];
	/**
	 * Where each serialized message lies, as the serializer recorded it. `previousSummary` marks the prior boundary's
	 * text.
	 */
	messageSpans?: { role: "user" | "assistant" | "tool"; start: number; end: number; previousSummary?: true }[];
	tokenEstimate: number;
}

export interface VerbatimCompactionStats {
	linesBefore: number;
	linesDeleted: number;
	linesKept: number;
	rangeCount: number;
	tokensBefore: number;
	tokensAfter: number;
	percentReduction: number;
}

/**
 * How a boundary replaced the context window.
 *
 * `cleared`: no model call; the boundary message tells the agent to recover from this session's history.
 * `compacted`: a compactor model or an extension supplied replacement text, followed by the same recovery instructions.
 */
export type CompactionForm = "cleared" | "compacted";

/** Who supplied the replacement text of a `compacted` boundary. */
export type CompactionBackend = "compactor" | "extension";

/** Where the boundary sits in `history://sessions/<sessionId>`, as advertised to the agent. */
export interface CompactionHistoryLocation {
	sessionId: string;
	/** The last line of the earlier conversation; the boundary starts on the next line. */
	linesBefore: number;
	/** The first line of the boundary entry. */
	boundaryLine: number;
	/** The number of lines in the history right after the boundary was written. */
	totalLines: number;
}

/** How the agent reaches its history after a boundary: its own `read` and `search` tools, or the restricted history tool. */
export type HistoryAccess = "read-search" | "session-history-tool";

export interface VerbatimCompactionDetails {
	strategy: typeof VERBATIM_COMPACTION_STRATEGY;
	promptVersion: typeof VERBATIM_COMPACTION_PROMPT_VERSION;
	parameters: VerbatimCompactionParameters;
	stats: VerbatimCompactionStats;
	form: CompactionForm;
	backend?: CompactionBackend;
	/** The compactor model, as `provider/model`, when one produced the text. */
	model?: string;
	/** Why the configured compactor was not used and the context was cleared instead. */
	fallbackReason?: string;
	history?: CompactionHistoryLocation;
	/** How the boundary told the agent to reach its history; a resumed session restores the history tool from it. */
	historyAccess?: HistoryAccess;
	/**
	 * Authoritative whole-context count, projected for display only. Populated by
	 * `createVerbatimCompactionMessage` on the rendered message; it is not
	 * persisted here — the durable entry already carries it as
	 * `CompactionEntry.tokensBefore`.
	 */
	tokensBefore?: number;
	backupPath?: string;
}

export interface VerbatimCompactionPreparation {
	/** Always null: a boundary keeps no earlier message in context. */
	firstKeptEntryId: string | null;
	/** Everything in context since the previous boundary, serialized for extension hooks. */
	region: NumberedRegion;
	regionEntryIds: string[];
	keptTailMessageCount: number;
	tokensBefore: number;
	parameters: VerbatimCompactionParameters;
	settings: CompactionSettings;
}

export interface VerbatimCompactionResult {
	/** The whole boundary message the model sees after the boundary. */
	compactedText: string;
	firstKeptEntryId: string | null;
	tokensBefore: number;
	stats: VerbatimCompactionStats;
	parameters: VerbatimCompactionParameters;
	promptVersion: typeof VERBATIM_COMPACTION_PROMPT_VERSION;
	form: CompactionForm;
	backend?: CompactionBackend;
	model?: string;
	/** Why the configured compactor was not used and the context was cleared instead. */
	fallbackReason?: string;
	history?: CompactionHistoryLocation;
	/** Usage reported by the compactor endpoint, when it ran. */
	usage?: Usage;
	backupPath?: string;
}
