import type { VerbatimCompactionDetails, VerbatimCompactionPreparation, VerbatimCompactionResult } from "../compaction/index.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry } from "../session-manager.ts";

// ============================================================================
// Resource Events
// ============================================================================

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// Session Events
// ============================================================================

/** Fired before CLI model resolution so dynamic providers can install authenticated catalogs. */
export interface ModelCatalogDiscoverEvent {
	type: "model_catalog_discover";
}

/** Fired when a session is started, loaded, or reloaded */
export interface SessionStartEvent {
	type: "session_start";
	/** Why this session start happened. */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** Previously active session file. Present for "new", "resume", and "fork". */
	previousSessionFile?: string;
}

/** Fired when the current session metadata changes. */
export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	/** Current normalized session name. Undefined when the name is cleared. */
	name: string | undefined;
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

/** Fired before forking a session (can be cancelled) */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	reason: "manual" | "threshold" | "overflow";
	parameters: VerbatimCompactionPreparation["parameters"];
	preparation: VerbatimCompactionPreparation;
	branchEntries: SessionEntry[];
	signal: AbortSignal;
}

/** Fired after context compaction */
export interface SessionCompactEvent {
	type: "session_compact";
	reason: "manual" | "threshold" | "overflow";
	parameters: VerbatimCompactionPreparation["parameters"];
	result: VerbatimCompactionResult;
	compactionEntry: CompactionEntry<VerbatimCompactionDetails>;
	fromExtension: boolean;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** Destination session file when shutting down due to session replacement. */
	targetSessionFile?: string;
}

/** Preparation data for tree navigation */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	/** Custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Label to attach to the branch summary entry */
	label?: string;
}

/** Fired before navigating in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** Fired after navigating in the session tree */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| ModelCatalogDiscoverEvent
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;
