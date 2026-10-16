export type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
export { SessionManager } from "./session-manager-core.ts";
export { SessionEntryError, SessionIdError } from "./session-manager-errors.js";
export {
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	getLatestCompactionBoundaryEntry,
	sessionEntryToContextMessages,
} from "./session-manager-history.ts";
export { getDefaultSessionDir, getDefaultSessionDirPath } from "./session-manager-paths.ts";
export {
	findMostRecentSession,
	isInternalHeader,
	loadEntriesFromFile,
	parseSessionEntries,
} from "./session-manager-storage.ts";
export type {
	BranchSummaryEntry,
	CompactionEntry,
	ContextCompactionEntry,
	ContextCompactionStats,
	ContextEditableContent,
	ContextEditEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	LabelEntry,
	ModelChangeEntry,
	NewSessionOptions,
	ProjectedSessionEntry,
	ReadonlySessionManager,
	SessionContext,
	SessionEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionListProgress,
	SessionMessageEntry,
	SessionNameState,
	SessionProjection,
	SessionSummaryEntry,
	SessionTreeNode,
	SessionWorkflowMetadata,
	ThinkingLevelChangeEntry,
	UsageEntry,
} from "./session-manager-types.ts";
export { CURRENT_SESSION_VERSION } from "./session-manager-types.ts";
export { assertValidSessionId } from "./session-manager-validation.ts";
