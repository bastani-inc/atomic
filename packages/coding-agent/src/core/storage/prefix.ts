import { postgresDialect, type StorageDialectName } from "./dialect.js";
import { StoragePrefixError } from "./errors.js";

/**
 * What follows the prefix in every identifier Atomic names on PostgreSQL: the tables, indexes, triggers and trigger
 * functions of sessions, worktree snapshots and the Intercom broker state (#5067), the Intercom lease order sequence
 * and the lease table's address indexes (#6560), and those the workflow run journal and
 * worker pools (#4793) of earlier releases left under the same prefix, pooled-stage sessions under
 * `POSTGRES_POOL_SESSION_PREFIX` included. Prefixes stay checked against them all, so a database those releases share
 * keeps every name whole. The storage adapters name none of their own, and
 * Postgres chooses constraint names and the sequences of serial columns itself. Longer pool names are in
 * `POSTGRES_HASHED_STORAGE_IDENTIFIER_SUFFIXES`.
 */
export const POSTGRES_STORAGE_IDENTIFIER_SUFFIXES: readonly string[] = Object.freeze([
	"atomic_migrations",
	"intercom_ended_child_bodies",
	"intercom_ended_child_meta",
	"intercom_ended_child_queue",
	"intercom_ended_child_queue_departure",
	"intercom_ended_child_queue_home",
	"intercom_ended_child_wakes",
	"intercom_ended_child_wakes_home",
	"intercom_held_sends",
	"intercom_held_sends_reservation",
	"intercom_known_sessions",
	"intercom_known_sessions_alias_id",
	"intercom_known_sessions_atomic_id",
	"intercom_known_sessions_intercom_id",
	"intercom_known_sessions_name",
	"intercom_known_sessions_recorded",
	"intercom_leases",
	"intercom_leases_order",
	"intercom_leases_presence_alias",
	"intercom_leases_presence_host",
	"intercom_leases_presence_id",
	"intercom_leases_presence_id_head",
	"intercom_leases_presence_name",
	"intercom_outbox",
	"intercom_outbox_target",
	"intercom_outbox_target_bytes",
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
	"intercom_settled_asks",
	"intercom_settled_asks_at",
	"intercom_wakeups",
	"intercom_wakeups_broker",
	"intercom_wakeups_created",
	"session_blob_chunks",
	"session_blobs",
	"session_chat_v1",
	"session_chat_v1_anchor",
	"session_entries",
	"session_entries_fork_links_v1",
	"session_entries_fork_links_v1_fn",
	"session_entries_search_forget",
	"session_entries_search_forget_fn",
	"session_entries_snapshot_links",
	"session_entries_snapshot_links_fn",
	"session_entries_snapshot_pending",
	"session_entries_snapshot_pending_fn",
	"session_entries_snapshot_refs",
	"session_entries_snapshot_refs_delete",
	"session_entries_snapshot_refs_delete_fn",
	"session_entries_snapshot_refs_fn",
	"session_entry_chunks",
	"session_fork_detach",
	"session_fork_lineage",
	"session_fork_segments",
	"session_fork_segments_source",
	"session_fork_staging",
	"session_fork_staging_name",
	"session_fork_tombstones",
	"session_meta",
	"session_open",
	"session_search_entries",
	"session_search_state",
	"session_search_texts",
	"session_search_trgm",
	"session_sessions",
	"snapshot_blob_chunks",
	"snapshot_blobs",
	"snapshot_blobs_age",
	"snapshot_blobs_chunks_delete_all",
	"snapshot_blobs_chunks_delete_all_fn",
	"snapshot_blobs_inline_size",
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
	"wf_ps_atomic_migrations",
	"wf_ps_session_blob_chunks",
	"wf_ps_session_blobs",
	"wf_ps_session_entries",
	"wf_ps_session_entries_search_forget",
	"wf_ps_session_entries_search_forget_fn",
	"wf_ps_session_entries_snapshot_links",
	"wf_ps_session_entries_snapshot_links_fn",
	"wf_ps_session_entries_snapshot_pending",
	"wf_ps_session_entries_snapshot_refs",
	"wf_ps_session_entries_snapshot_refs_fn",
	"wf_ps_session_entry_chunks",
	"wf_ps_session_meta",
	"wf_ps_session_open",
	"wf_ps_session_owners",
	"wf_ps_session_search_entries",
	"wf_ps_session_search_state",
	"wf_ps_session_search_texts",
	"wf_ps_session_search_trgm",
	"wf_ps_session_sessions",
	"wf_ps_snapshot_blob_chunks",
	"wf_ps_snapshot_blobs",
	"wf_ps_snapshot_blobs_age",
	"wf_ps_snapshot_blobs_chunks_delete_all",
	"wf_ps_snapshot_blobs_inline_size",
	"wf_ps_snapshot_carried_refs",
	"wf_ps_snapshot_carried_refs_hash",
	"wf_ps_snapshot_collection",
	"wf_ps_snapshot_index_sources",
	"wf_ps_snapshot_run_refs",
	"wf_ps_snapshot_run_refs_hash",
	"wf_ps_snapshot_run_state",
	"wf_ps_snapshot_session_links",
	"wf_ps_snapshot_session_links_broken",
	"wf_ps_snapshot_session_links_entry",
	"wf_ps_snapshot_session_links_leaves",
	"wf_ps_snapshot_session_records",
	"wf_ps_snapshot_session_records_hash",
	"wf_ps_snapshot_session_refs",
	"wf_runs",
	"wf_runs_fleet_controller",
	"wf_runs_fleet_drains",
	"wf_runs_fleet_events",
	"wf_runs_pool",
	"wf_runs_pool_activity",
	"wf_runs_pool_activity_version",
	"wf_runs_pool_control",
	"wf_runs_pool_fence",
	"wf_runs_pool_fence_abort",
	"wf_runs_pool_fence_abort_fn",
	"wf_runs_pool_hosts",
	"wf_runs_pool_meta",
	"wf_runs_pool_operations",
	"wf_runs_pool_restore_backoffs",
	"wf_runs_pool_root_snapshot",
	"wf_runs_pool_shared",
	"wf_runs_pool_usage",
	"wf_runs_pool_usage_totals",
	"wf_runs_pool_usage_totals_delete",
	"wf_runs_pool_usage_totals_delete_fn",
	"wf_runs_pool_usage_totals_insert",
	"wf_runs_pool_usage_totals_insert_fn",
	"wf_runs_pool_usage_totals_update",
	"wf_runs_pool_usage_totals_update_fn",
	"wf_runs_pool_usage_totals_work_delete",
	"wf_runs_rate_buckets",
	"wf_runs_rate_waiting",
	"wf_runs_rate_waiting_age",
	"wf_runs_resource_limits",
	"wf_runs_resource_owners",
	"wf_runs_resource_permits",
	"wf_runs_resource_permits_active",
	"wf_runs_resource_permits_owner",
	"wf_runs_resource_permits_state",
	"wf_runs_ship_batches",
	"wf_runs_ship_batches_work",
	"wf_runs_ship_watermarks",
	"wf_runs_snapshot_refs_delete",
	"wf_runs_snapshot_refs_delete_fn",
	"wf_runs_snapshot_state_insert",
	"wf_runs_snapshot_state_insert_fn",
	"wf_runs_snapshot_state_status",
	"wf_runs_snapshot_state_status_fn",
	"wf_runs_stage_inputs",
	"wf_runs_stage_inputs_pending",
	"wf_runs_stage_leases",
	"wf_runs_stage_workspaces",
	"wf_runs_work",
	"wf_runs_work_child",
	"wf_runs_work_expiry",
	"wf_runs_work_input_chunks",
	"wf_runs_work_ready",
	"wf_runs_work_result_chunks",
	"wf_runs_work_results",
	"wf_runs_work_scope",
	"wf_runs_work_snapshot_carried_delete",
	"wf_runs_work_snapshot_carried_delete_fn",
	"wf_runs_work_snapshot_carried_insert",
	"wf_runs_work_snapshot_carried_insert_fn",
	"wf_runs_work_snapshot_carried_update",
	"wf_runs_work_snapshot_carried_update_fn",
]);

/**
 * What follows the prefix in the triggers and trigger functions of a worker pool (#4793) whose names are longer than
 * `POSTGRES_STORAGE_IDENTIFIER_SUFFIXES` allows. Under a prefix that makes one longer than 63 bytes, Postgres knows it by
 * `postgresDialect.identifier` of the whole name (its head and a hash), in every statement and catalog probe alike; under
 * a shorter prefix, by the whole name. They do not limit the prefix.
 */
export const POSTGRES_HASHED_STORAGE_IDENTIFIER_SUFFIXES: readonly string[] = Object.freeze([
	"wf_ps_session_entries_snapshot_pending_fn",
	"wf_ps_session_entries_snapshot_refs_delete",
	"wf_ps_session_entries_snapshot_refs_delete_fn",
	"wf_ps_snapshot_blobs_chunks_delete_all_fn",
	"wf_runs_pool_root_snapshot_snapshot_carried_delete",
	"wf_runs_pool_root_snapshot_snapshot_carried_delete_fn",
	"wf_runs_pool_root_snapshot_snapshot_carried_insert",
	"wf_runs_pool_root_snapshot_snapshot_carried_insert_fn",
	"wf_runs_pool_root_snapshot_snapshot_carried_update",
	"wf_runs_pool_root_snapshot_snapshot_carried_update_fn",
	"wf_runs_pool_usage_totals_work_delete_fn",
]);

/**
 * The longest storage prefix PostgreSQL takes: Postgres truncates an identifier longer than 63 bytes, so a longer
 * prefix would cut the longest name Atomic gives it, or make two names one. Prefixes are ASCII, one byte a character.
 */
export const POSTGRES_MAX_STORAGE_PREFIX_LENGTH =
	63 - Math.max(...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES.map((suffix) => suffix.length));

/**
 * What a worker pool of an earlier release added to the journal's prefix for the stores it carried on PostgreSQL: its
 * pooled-stage sessions and their snapshot index live under `<prefix>wf_ps_` (#4793). The length limit applies to the
 * prefix before it.
 */
export const POSTGRES_POOL_SESSION_PREFIX = "wf_ps_";

/**
 * Check a storage prefix, and with `dialect`, that the backend can name every identifier under it. SQLite and libSQL
 * have no identifier limit. On PostgreSQL the limit applies to the prefix a user chose: a worker pool's session prefix
 * (`<prefix>wf_ps_`) is checked as the prefix before it.
 */
export function validateStoragePrefix(prefix = "", dialect?: StorageDialectName): string {
	if (prefix !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		throw new StoragePrefixError(prefix, "pattern");
	}
	if (/^sqlite_/i.test(prefix)) throw new StoragePrefixError(prefix, "reserved");
	const chosen = prefix.endsWith(POSTGRES_POOL_SESSION_PREFIX)
		? prefix.slice(0, -POSTGRES_POOL_SESSION_PREFIX.length)
		: prefix;
	if (dialect === "postgres" && /[A-Z]/.test(prefix)) throw new StoragePrefixError(prefix, "uppercase");
	if (dialect === "postgres" && chosen.length > POSTGRES_MAX_STORAGE_PREFIX_LENGTH)
		throw new StoragePrefixError(prefix, "too-long", POSTGRES_MAX_STORAGE_PREFIX_LENGTH);
	if (dialect === "postgres") {
		const collision = postgresIdentifierCollision(chosen);
		if (collision !== undefined) throw new StoragePrefixError(prefix, "identifier-collision", undefined, collision);
	}
	return prefix;
}

const postgresCollisions = new Map<string, string | undefined>();

/**
 * The identifier PostgreSQL would know two of the names under `prefix` by, if any (#5219): a name too long to keep whole
 * is its head and a hash of the whole name, so two names that share their head differ only in that hash.
 */
function postgresIdentifierCollision(prefix: string): string | undefined {
	if (postgresCollisions.has(prefix)) return postgresCollisions.get(prefix);
	const seen = new Set<string>();
	let collision: string | undefined;
	for (const suffix of [...POSTGRES_STORAGE_IDENTIFIER_SUFFIXES, ...POSTGRES_HASHED_STORAGE_IDENTIFIER_SUFFIXES]) {
		const identifier = postgresDialect.identifier(`${prefix}${suffix}`);
		if (seen.has(identifier)) {
			collision = identifier;
			break;
		}
		seen.add(identifier);
	}
	postgresCollisions.set(prefix, collision);
	return collision;
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
