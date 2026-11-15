import type { StorageDialectName } from "./dialect.js";
import { StoragePrefixError } from "./errors.js";

/**
 * What follows the prefix in every identifier Atomic names on PostgreSQL: the tables, indexes, triggers and trigger
 * functions of sessions, the run journal, worktree snapshots and the Intercom broker state (#5067). The storage
 * adapters name none of their own, and Postgres chooses constraint and sequence names itself. Worker pools do not run on
 * PostgreSQL yet, so their tables are not here.
 */
export const POSTGRES_STORAGE_IDENTIFIER_SUFFIXES: readonly string[] = Object.freeze([
	"atomic_migrations",
	"intercom_held_sends",
	"intercom_held_sends_reservation",
	"intercom_known_sessions",
	"intercom_known_sessions_atomic_id",
	"intercom_known_sessions_intercom_id",
	"intercom_known_sessions_name",
	"intercom_known_sessions_recorded",
	"intercom_leases",
	"intercom_outbox",
	"intercom_outbox_target",
	"intercom_pending_asks",
	"intercom_pending_asks_target",
	"intercom_released_asks",
	"intercom_restoring_reservation_counters",
	"intercom_restoring_reservations",
	"intercom_restoring_reservations_active",
	"intercom_restoring_reservations_child",
	"intercom_restoring_reservations_wake",
	"intercom_restoring_wake_claims",
	"intercom_sent_messages",
	"intercom_sent_messages_recorded",
	"intercom_session_bindings",
	"intercom_session_bindings_recorded",
	"intercom_wakeups",
	"intercom_wakeups_broker",
	"intercom_wakeups_created",
	"session_blob_chunks",
	"session_blobs",
	"session_entries",
	"session_entries_snapshot_links",
	"session_entries_snapshot_links_fn",
	"session_entries_snapshot_pending",
	"session_entries_snapshot_pending_fn",
	"session_entries_snapshot_refs",
	"session_entries_snapshot_refs_delete",
	"session_entries_snapshot_refs_delete_fn",
	"session_entries_snapshot_refs_fn",
	"session_entry_chunks",
	"session_meta",
	"session_open",
	"session_search_texts",
	"session_sessions",
	"snapshot_blob_chunks",
	"snapshot_blobs",
	"snapshot_blobs_age",
	"snapshot_blobs_chunks_delete",
	"snapshot_blobs_chunks_delete_fn",
	"snapshot_carried_refs",
	"snapshot_carried_refs_hash",
	"snapshot_collection",
	"snapshot_index_sources",
	"snapshot_run_refs",
	"snapshot_run_refs_hash",
	"snapshot_run_state",
	"snapshot_session_links",
	"snapshot_session_links_broken",
	"snapshot_session_links_entry",
	"snapshot_session_links_leaves",
	"snapshot_session_records",
	"snapshot_session_records_hash",
	"snapshot_session_refs",
	"wf_event_chunks",
	"wf_events",
	"wf_events_snapshot_refs",
	"wf_events_snapshot_refs_fn",
	"wf_events_snapshot_state",
	"wf_events_snapshot_state_fn",
	"wf_lease_builds",
	"wf_leases",
	"wf_meta",
	"wf_runs",
	"wf_runs_snapshot_refs_delete",
	"wf_runs_snapshot_refs_delete_fn",
	"wf_runs_snapshot_state_insert",
	"wf_runs_snapshot_state_insert_fn",
	"wf_runs_snapshot_state_status",
	"wf_runs_snapshot_state_status_fn",
]);

/**
 * The longest storage prefix PostgreSQL takes: Postgres truncates an identifier longer than 63 bytes, so a longer
 * prefix would cut the longest name Atomic gives it, or make two names one. Prefixes are ASCII, one byte a character.
 */
export const POSTGRES_MAX_STORAGE_PREFIX_LENGTH =
	63 - Math.max(...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES.map((suffix) => suffix.length));

/**
 * Check a storage prefix, and with `dialect`, that the backend can name every identifier under it. SQLite and libSQL
 * have no identifier limit.
 */
export function validateStoragePrefix(prefix = "", dialect?: StorageDialectName): string {
	if (prefix !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		throw new StoragePrefixError(prefix, "pattern");
	}
	if (/^sqlite_/i.test(prefix)) throw new StoragePrefixError(prefix, "reserved");
	if (dialect === "postgres" && prefix.length > POSTGRES_MAX_STORAGE_PREFIX_LENGTH)
		throw new StoragePrefixError(prefix, "too-long", POSTGRES_MAX_STORAGE_PREFIX_LENGTH);
	return prefix;
}

export function renderStorageIdentifiers<T extends Readonly<Record<string, string>>>(
	domain: "journal" | "sessions",
	names: T,
	prefix = "",
): Readonly<{ [K in keyof T]: string }> {
	const validated = validateStoragePrefix(prefix);
	const domainPrefix = domain === "journal" ? "wf_" : "session_";
	return Object.freeze(
		Object.fromEntries(Object.entries(names).map(([key, name]) => [key, `${validated}${domainPrefix}${name}`])),
	) as Readonly<{ [K in keyof T]: string }>;
}

/**
 * The ledger `applyStorageMigrations` records each domain's applied versions in, one per prefix: the Postgres schema
 * of every domain under `prefix` (#4793). SQLite keeps no ledger, so its schema is unchanged.
 */
export function storageMigrationTable(prefix = ""): string {
	return `${validateStoragePrefix(prefix)}atomic_migrations`;
}
