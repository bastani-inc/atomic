export type { SnapshotIndexTables } from "../worktree-snapshot/blob-store.ts";
export { MemorySnapshotBlobStore, SqlSnapshotBlobStore, snapshotIndexTables } from "../worktree-snapshot/blob-store.ts";
export type { SnapshotBlob, SnapshotBlobStore } from "../worktree-snapshot/types.ts";
/** @internal How a transaction of a pipelined connection sends its last writes with its commit (#6560). */
export { transactionFinisher } from "./added-exports.js";
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
	StorageOpenedCatalog,
	TransactionConcurrency,
} from "./database.js";
export * from "./dialect.js";
export * from "./errors.js";
export * from "./fenced-paths.js";
export {
	claimFileAtomically,
	claimFileAtomicallyAsync,
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
// Removed with libSQL support; see libsql-removed.ts for why they are still exported.
export {
	joinTeam,
	LIBSQL_ADAPTER_PACKAGE,
	leaveTeam,
	SHARED_STORAGE_JOIN_HINT,
	TEAM_PREFIX_ENV,
	TEAM_PROFILE_ENV,
	TEAM_TOKEN_ENV,
	TEAM_TOKEN_FILE_ENV,
	TEAM_URL_ENV,
	teamProfileSelection,
} from "./libsql-removed.js";
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
	POSTGRES_STORAGE_IDENTIFIER_SUFFIXES,
	renderStorageIdentifiers,
	storageMigrationTable,
	validateStoragePrefix,
} from "./prefix.js";
export * from "./provider.js";
export { assertStorageSchemaVersion, assertStoredSchemaVersion } from "./schema.js";
export * from "./schema-catalog.js";
export {
	getTeamProfile,
	type InMemorySecretRef,
	inMemorySecret,
	isPostgresUrl,
	LOCAL_SESSIONS_STORAGE,
	POSTGRES_ADAPTER_PACKAGE,
	REDACTED_SECRET,
	type StorageInputSelection,
	type StorageSettingsSelection,
	selectStorage,
	selectStorageAsync,
} from "./selection.js";
export type { ExpandedChildCall, ExpandedChildDetails } from "./session/expanded-child-details.js";
export async function readExpandedChildDetails(
	...args: Parameters<typeof import("./session/expanded-child-details.js").readExpandedChildDetails>
) {
	return (await import("./session/expanded-child-details.js")).readExpandedChildDetails(...args);
}
export async function readSavedChildLaunch(
	...args: Parameters<typeof import("./session/expanded-child-details.js").readSavedChildLaunch>
) {
	return (await import("./session/expanded-child-details.js")).readSavedChildLaunch(...args);
}
export async function readSessionChildCatalog(
	...args: Parameters<typeof import("./session/child-reader.js").readSessionChildCatalog>
) {
	return (await import("./session/child-reader.js")).readSessionChildCatalog(...args);
}
export async function findInSessionHistory(
	...args: Parameters<typeof import("./session/history-pages.js").findInSessionHistory>
) {
	return (await import("./session/history-pages.js")).findInSessionHistory(...args);
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
	SessionForkWindow,
	SessionHistoryItem,
	SessionHistoryPage,
	SessionHistoryReadOptions,
	SessionHistoryTotals,
	SessionRecoveryState,
	SessionResume,
	SessionResumeRetainedSetting,
	SessionResumeRetainedSettings,
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
export type { TeamProfile, TeamProfileName, TeamProfileOptions } from "./team.js";
export { switchToWriteAheadLog } from "./write-ahead-log.js";
