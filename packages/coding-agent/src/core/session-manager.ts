export type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
export { SessionManager } from "./session-manager-core.ts";
export {
	SESSION_ALREADY_OPEN_EXIT_CODE,
	SessionAlreadyOpenError,
	SessionDeletedError,
	SessionEntryError,
	SessionHistoryNotLoadedError,
	SessionIdError,
	SessionOpenElsewhereError,
} from "./session-manager-errors.js";
export {
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	getLatestCompactionBoundaryEntry,
	getSessionLeafId,
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
	LatestBranchSetting,
	LatestBranchSettings,
	ModelChangeEntry,
	ModelFallbackRecord,
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
	SessionOpenOptions,
	SessionProjection,
	SessionSummaryEntry,
	SessionTreeNode,
	ThinkingLevelChangeEntry,
	UsageEntry,
	WorktreeRestoreHostWarning,
	WorktreeSnapshotEntry,
} from "./session-manager-types.ts";
export { CURRENT_SESSION_VERSION } from "./session-manager-types.ts";
export { assertValidSessionId } from "./session-manager-validation.ts";
