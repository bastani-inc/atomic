export type { SnapshotIndexTables } from "../worktree-snapshot/blob-store.ts";
export { MemorySnapshotBlobStore, SqlSnapshotBlobStore, snapshotIndexTables } from "../worktree-snapshot/blob-store.ts";
export type { SnapshotBlob, SnapshotBlobStore } from "../worktree-snapshot/types.ts";
export type {
	FencedPathId,
	SqliteBatchOptions,
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteRunResult,
	SqliteStatement,
	SqliteTransactionOptions,
	SqliteValue,
	StorageDescriptor,
	StorageListenerState,
	StorageNotificationEvent,
	StorageNotificationSubscription,
	StorageNotifications,
	TransactionConcurrency,
} from "./database.js";
export * from "./dialect.js";
export * from "./errors.js";
export * from "./fenced-paths.js";
export {
	claimFileAtomically,
	claimFileAtomicallyAsync,
	defaultJournalStoreDirectoryAsync,
	defaultSessionDatabasePath,
	defaultSessionDatabasePathAsync,
	defaultSharedStoragePath,
	defaultSharedStoragePathAsync,
	readClaimFile,
	readClaimFileAsync,
	type StorageHomeSettings,
	sameDirectory,
	sameDirectoryAsync,
	storageHomeDir,
	storageHomeDirAsync,
	storagePathBaseDir,
	storagePathBaseDirAsync,
	workflowsStorageDir,
	workflowsStorageDirAsync,
} from "./file-identity.js";
export * from "./journal-adoption.js";
export * from "./journal-catalog.js";
export * from "./migrations.js";
export {
	DEFAULT_GROUP_COMMIT_HOLD_MS,
	getWriterQueueDegradation,
	getWriterQueueStats,
	openNodeSqliteDatabase,
	sqliteFilePath,
	type WriterQueueStats,
	wrapNodeSqliteDatabase,
} from "./node-sqlite.js";
export {
	POSTGRES_HASHED_STORAGE_IDENTIFIER_SUFFIXES,
	POSTGRES_MAX_STORAGE_PREFIX_LENGTH,
	POSTGRES_POOL_SESSION_PREFIX,
	POSTGRES_STORAGE_IDENTIFIER_SUFFIXES,
	renderStorageIdentifiers,
	storageMigrationTable,
	validateStoragePrefix,
} from "./prefix.js";
export * from "./provider.js";
export * from "./run-journal.js";
export { assertStorageSchemaVersion, assertStoredSchemaVersion } from "./schema.js";
export {
	getTeamProfile,
	type InMemorySecretRef,
	inMemorySecret,
	isPostgresUrl,
	joinTeam,
	LIBSQL_ADAPTER_PACKAGE,
	LOCAL_SESSIONS_STORAGE,
	leaveTeam,
	POSTGRES_ADAPTER_PACKAGE,
	REDACTED_SECRET,
	type StorageInputSelection,
	type StorageSettingsSelection,
	selectStorage,
	selectStorageAsync,
	selectsDefaultJournalStore,
	TEAM_PREFIX_ENV,
	TEAM_PROFILE_ENV,
	TEAM_TOKEN_ENV,
	TEAM_TOKEN_FILE_ENV,
	TEAM_URL_ENV,
	type TeamProfileSelectionOptions,
	type TeamStorageSelection,
	teamProfileSelection,
} from "./selection.js";
export async function readSessionChildCatalog(
	...args: Parameters<typeof import("./session/child-reader.js").readSessionChildCatalog>
) {
	return (await import("./session/child-reader.js")).readSessionChildCatalog(...args);
}
// Ordinary storage setup does not open a transcript reader or import its encoders.
export async function* readSessionHistory(
	...args: Parameters<typeof import("./session/history-pages.js").readSessionHistory>
) {
	yield* (await import("./session/history-pages.js")).readSessionHistory(...args);
}
export async function* readSessionHistoryChunks(
	...args: Parameters<typeof import("./session/history-pages.js").readSessionHistoryChunks>
) {
	yield* (await import("./session/history-pages.js")).readSessionHistoryChunks(...args);
}
export type {
	ArchivedChildCatalogEntry,
	OversizedSessionEntry,
	SessionBlob,
	SessionCompactionPoint,
	SessionEntriesPage,
	SessionEntriesQuery,
	SessionEntryAt,
	SessionEntryRange,
	SessionEntrySizes,
	SessionHistoryItem,
	SessionHistoryPage,
	SessionHistoryReadOptions,
	SessionHistoryTotals,
	SessionRecoveryState,
	SessionResume,
	SessionSearchCoverage,
	SessionSearchExtendOptions,
	SessionSearchIndex,
	SessionSearchText,
	SessionStateEntry,
	SessionStore,
	SessionStoredEntry,
	SessionTail,
	SessionTaskReferenceCandidate,
	SessionTaskReferenceDuplicatePage,
	SessionTaskReferenceDuplicateQuery,
	SessionUsageTotals,
} from "./session/types.js";
export * from "./sqlite-facade.js";
export type {
	JoinTeamOptions,
	LeaveTeamOptions,
	TeamBrokerRestart,
	TeamJoinResult,
	TeamKeptSetting,
	TeamLeaveResult,
	TeamProfile,
	TeamProfileName,
	TeamProfileOptions,
	TeamSettingKey,
} from "./team.js";
export { switchToWriteAheadLog } from "./write-ahead-log.js";
