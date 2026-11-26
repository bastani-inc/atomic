import {
	dialectOf,
	type StorageDialect,
	type StorageSchemaCatalog,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import type {
	IntercomBrokerStateOptions,
	InvalidStateInput,
	LeaseStaleResult,
	RestoringReservation,
	RestoringReservationConsumeResult,
	RestoringReservationEnd,
	RestoringReservationLease,
	RestoringReservationLookupResult,
	RestoringReservationReadResult,
	RestoringReservationRegistration,
	RestoringReservationReleaseResult,
	RestoringReservationRenewResult,
	RestoringReservationRequestWakeResult,
	RestoringReservationReserveResult,
	RestoringReservationStore,
	RestoringReservationTakeWakeResult,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";
import { reservationAdmitsSender } from "./group-membership.js";
import { isReleasedReservationKey } from "./released-children.js";
import { addMissingColumns } from "./sql-add-column.js";
import {
	ensureBrokerSchema,
	foundInCatalogAgain,
	openCatalogOf,
	RETRY_UNAPPLIED,
	setUpBrokerSchemaOnce,
	withBrokerSchemaCatalog,
} from "./sql-schema.js";

type ReservationRow = SqliteRow & {
	reservation_key: string;
	owner_session_id: string;
	owner_broker_id: string;
	child_name_json: string;
	child_target: string;
	targets_json: string;
	reservation_group: string;
	dormant: number;
	wake: number;
	wake_generation: number;
	fencing_token: number;
	reservation_order: number;
	gone_json: string | null;
	end_json: string | null;
	age_ms: number;
};

type Counter = "order" | "token";

type RenewedReservationRow = SqliteRow & {
	reservation_key: string | null;
	owner_session_id: string | null;
	fencing_token: number | bigint | null;
};

type MissedReservationRow = SqliteRow & {
	reservation_key: string;
	end_json: string | null;
	fencing_token: number | bigint;
};

/** The setting a PostgreSQL batched reservation renewal sets when any reservation missed, so its follow-up read runs. */
const RESERVATION_RENEW_MISSES = "atomic.intercom_reservation_renew_misses";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function wellFormed(_key: string, value: unknown): unknown {
	return typeof value === "string" ? value.toWellFormed() : value;
}

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });

function reservationOf(row: ReservationRow): RestoringReservation {
	return {
		reservationKey: row.reservation_key,
		ownerSessionId: row.owner_session_id,
		ownerBrokerId: row.owner_broker_id,
		childName: JSON.parse(row.child_name_json) as string,
		childTarget: row.child_target,
		targets: JSON.parse(row.targets_json) as string[],
		group: row.reservation_group,
		dormant: row.dormant === 1,
		wake: row.wake === 1,
		wakeGeneration: row.wake_generation,
		fencingToken: row.fencing_token,
		...(row.gone_json === null ? {} : { gone: JSON.parse(row.gone_json) as string }),
	};
}

function endOf(endJson: string): RestoringReservationEnd {
	const end = JSON.parse(endJson) as RestoringReservationEnd;
	if (end.outcome === "consumed") return { outcome: "consumed" };
	if (end.outcome === "superseded") return { outcome: "superseded", by: end.by };
	return end.refusal === undefined ? { outcome: "released" } : { outcome: "released", refusal: end.refusal };
}

function endsWithRegistration(row: ReservationRow, registered: RestoringReservationRegistration): boolean {
	if (registered.insertedBy !== undefined && row.reservation_order > registered.insertedBy) return false;
	if (isReleasedReservationKey(row.reservation_key)) return row.owner_session_id === registered.authorizedBy;
	return row.dormant === 1 && registered.releasedOnly !== true;
}

function replacementTargets(childTarget: string, aliases: readonly string[]): string[] {
	return mergeTargets([childTarget], aliases);
}

function mergeTargets(targets: string[], added: readonly string[]): string[] {
	for (const target of added) if (!targets.includes(target)) targets.push(target);
	return targets;
}

function invalidLease(lease: RestoringReservationLease): InvalidStateInput | undefined {
	if (lease.reservationKey.length === 0) return invalid("empty-reservation-key");
	return lease.ownerSessionId.length === 0 ? invalid("empty-session-id") : undefined;
}

/**
 * The index of the reservations whose owner should wake its child, `<table>_wake`. It was `<table>_wake_requested`,
 * which PostgreSQL cut short at 63 bytes under a prefix longer than 17 characters (#5067). A store an earlier version
 * created converges here, whichever name it holds: PostgreSQL renames the index, SQLite (which cannot) rebuilds it,
 * and an index an earlier broker recreated beside the new one is dropped.
 */
async function renameWakeIndex(tx: SqliteExecutor, dialect: StorageDialect, table: string): Promise<void> {
	const index = `${table}_wake`;
	const earlier = `${table}_wake_requested`.slice(0, dialect.name === "postgres" ? 63 : undefined);
	const probe = dialect.schemaObjects([earlier, index]);
	const found = new Set((await tx.all(probe.sql, ...probe.params)).map((row) => row.name));
	if (found.has(earlier)) {
		if (dialect.name === "postgres" && !found.has(index)) {
			await tx.exec(`ALTER INDEX IF EXISTS ${earlier} RENAME TO ${index}`);
			return;
		}
		await tx.exec(`DROP INDEX IF EXISTS ${earlier}`);
	}
	// Probed first, so a current schema runs no DDL (#5218).
	if (!found.has(index))
		await tx.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(owner_broker_id) WHERE wake_requested = 1`);
}

/**
 * S3: `RestoringReservationStore` on the shared storage adapter's database, table
 * `<prefix>intercom_restoring_reservations`. Insertion order and fencing tokens come from
 * `<prefix>intercom_restoring_reservation_counters`, so both keep increasing after `prune` deletes rows.
 */
export function openSqlRestoringReservationStore(options: IntercomBrokerStateOptions): Promise<RestoringReservationStore> {
	// Its schema checks answer from one read of the catalog, shared with an open around it: a current schema costs
	// no transaction and no lock, also when the store is opened on its own (#6560).
	return withBrokerSchemaCatalog(options.database, options.prefix, () => openRestoringReservationStoreInCatalog(options));
}

async function openRestoringReservationStoreInCatalog({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<RestoringReservationStore> {
	const validPrefix = validateStoragePrefix(prefix, dialectOf(database).name);
	const table = `${validPrefix}intercom_restoring_reservations`;
	const counters = `${validPrefix}intercom_restoring_reservation_counters`;
	const wakeClaims = `${validPrefix}intercom_restoring_wake_claims`;
	const { types, nowMs, greatest, jsonValues, name: dialect } = dialectOf(database);
	/**
	 * Its transactions read and write this table, its counters and its wake claims alone, which no other store
	 * touches, so they exclude one another, not every writer of the database (#6560).
	 */
	const serial = { ...RETRY_UNAPPLIED, concurrency: { kind: "serial", domain: table } } as const;
	await ensureBrokerSchema(database, prefix, "restoring-reservations", (tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				reservation_key TEXT PRIMARY KEY,
				"order" ${types.int} NOT NULL,
				owner_session_id TEXT NOT NULL,
				owner_broker_id TEXT NOT NULL,
				child_name TEXT NOT NULL,
				child_target TEXT NOT NULL,
				targets_json TEXT NOT NULL,
				"group" TEXT NOT NULL,
				dormant ${types.int} NOT NULL,
				fencing_token ${types.int} NOT NULL,
				gone TEXT,
				renewed_at ${types.int} NOT NULL,
				end_json TEXT,
				ended_at ${types.int}
			);
			CREATE INDEX IF NOT EXISTS ${table}_active ON ${table}(end_json, "order");
			CREATE TABLE IF NOT EXISTS ${counters}(name TEXT PRIMARY KEY, value ${types.int} NOT NULL);
			INSERT INTO ${counters}(name, value) VALUES ('order', 0), ('token', 0) ON CONFLICT(name) DO NOTHING;
			CREATE TABLE IF NOT EXISTS ${wakeClaims}(
				reservation_key TEXT NOT NULL,
				fencing_token ${types.int} NOT NULL,
				message_id TEXT NOT NULL,
				PRIMARY KEY(reservation_key, fencing_token, message_id)
			);
		`),
	);
	// #4326: added later; a table from an older broker gets the columns, and an older broker ignores them.
	const wakeColumn = `${types.int} NOT NULL DEFAULT 0`;
	await addMissingColumns(database, table, {
		wake: wakeColumn,
		wake_requested: wakeColumn,
		wake_generation: wakeColumn,
	});
	// In a serial transaction, so brokers opening a new store at once take turns creating them (#5054).
	await ensureBrokerSchema(database, prefix, "restoring-reservation-indexes", (tx) =>
		tx.exec(`CREATE INDEX IF NOT EXISTS ${table}_child ON ${table}(child_target) WHERE end_json IS NULL`),
	);
	// Probed every time, as an earlier broker may recreate its index meanwhile; a current one runs no DDL (#5218). The
	// catalog an open read answers that probe, so a current index costs no transaction (#6560).
	const wakeIndexCurrent = (catalog: StorageSchemaCatalog) =>
		catalog.hasObject(`${table}_wake`) &&
		!catalog.hasObject(`${table}_wake_requested`.slice(0, dialectOf(database).name === "postgres" ? 63 : undefined));
	const catalog = await openCatalogOf(database);
	// Brokers that open a new database at once create it once; the others wait for it without its lock (#6560).
	if (catalog === undefined || !wakeIndexCurrent(catalog))
		await setUpBrokerSchemaOnce(
			database,
			`${table}:wake-index`,
			() => foundInCatalogAgain(database, wakeIndexCurrent),
			(tx) => renameWakeIndex(tx, dialectOf(database), table),
		);
	const columns = `reservation_key, owner_session_id, owner_broker_id, child_name AS child_name_json, child_target,
		targets_json, "group" AS reservation_group, dormant, wake, wake_generation, fencing_token, "order" AS reservation_order,
		gone AS gone_json, end_json,
		${greatest("0", `${nowMs} - renewed_at`)} AS age_ms`;
	const readRow = (executor: SqliteExecutor, reservationKey: string) =>
		executor.get<ReservationRow>(`SELECT ${columns} FROM ${table} WHERE reservation_key = ?`, reservationKey);
	const activeRows = (executor: SqliteExecutor) =>
		executor.all<ReservationRow>(`SELECT ${columns} FROM ${table} WHERE end_json IS NULL ORDER BY "order"`);
	const activeRowsForChild = (executor: SqliteExecutor, childTarget: string, reservationKey?: string) =>
		executor.all<ReservationRow>(
			`SELECT ${columns} FROM ${table}
			 WHERE end_json IS NULL AND (child_target = ? OR reservation_key = ?) ORDER BY "order"`,
			childTarget,
			reservationKey ?? childTarget,
		);
	const next = async (executor: SqliteExecutor, counter: Counter): Promise<number> => {
		const row = await executor.get<SqliteRow & { value: number }>(
			`UPDATE ${counters} SET value = value + 1 WHERE name = ? RETURNING value`,
			counter,
		);
		if (row === undefined) throw new Error(`Missing ${counters} row ${counter}`);
		return row.value;
	};
	const end = (executor: SqliteExecutor, reservationKey: string, outcome: RestoringReservationEnd) =>
		executor.run(
			`UPDATE ${table} SET end_json = ?, ended_at = ${nowMs} WHERE reservation_key = ?`,
			JSON.stringify(outcome),
			reservationKey,
		);
	const owned = async (
		executor: SqliteExecutor,
		lease: RestoringReservationLease,
	): Promise<LeaseStaleResult | undefined> => {
		const row = await readRow(executor, lease.reservationKey);
		if (row === undefined || row.end_json !== null) return { status: "stale" };
		if (row.owner_session_id !== lease.ownerSessionId || row.fencing_token !== lease.fencingToken) {
			return { status: "stale", currentFencingToken: row.fencing_token };
		}
		return undefined;
	};

	return {
		async reserve(request): Promise<RestoringReservationReserveResult> {
			if (request.reservationKey.length === 0) return invalid("empty-reservation-key");
			if (request.ownerSessionId.length === 0) return invalid("empty-session-id");
			if (request.ownerBrokerId.length === 0) return invalid("empty-broker-id");
			if (request.childName.length === 0) return invalid("empty-child-name");
			if (request.childTarget.length === 0 || request.aliases.some((alias) => alias.length === 0)) {
				return invalid("empty-target");
			}
			if (request.group.length === 0) return invalid("empty-group");
			return database.transaction(async (tx) => {
				const existing = await readRow(tx, request.reservationKey);
				if (
					existing !== undefined &&
					existing.end_json === null &&
					existing.owner_session_id !== request.ownerSessionId &&
					isReleasedReservationKey(request.reservationKey) &&
					(request.staleAfterMs === undefined || existing.age_ms <= request.staleAfterMs)
				) {
					return { status: "not-owner", ownerSessionId: existing.owner_session_id };
				}
				const superseded: string[] = [];
				// Parking starts a new wake epoch; moving brokers replays any wake a broker crash lost.
				const newWakeGeneration = existing !== undefined &&
					((existing.wake === 1 && request.wake !== true) || existing.owner_broker_id !== request.ownerBrokerId);
				if (existing === undefined || existing.end_json !== null || newWakeGeneration) {
					await tx.run(`DELETE FROM ${wakeClaims} WHERE reservation_key = ?`, request.reservationKey);
				}
				let fencingToken: number;
				if (existing !== undefined && existing.end_json === null) {
					fencingToken =
						existing.owner_session_id === request.ownerSessionId
							? existing.fencing_token
							: await next(tx, "token");
					await tx.run(
						`UPDATE ${table} SET owner_session_id = ?, owner_broker_id = ?, "group" = ?, dormant = ?, wake = ?,
						 wake_generation = ?, wake_requested = CASE WHEN ? = 1 THEN 0 ELSE wake_requested END,
						 fencing_token = ?, targets_json = ?, renewed_at = ${nowMs} WHERE reservation_key = ?`,
						request.ownerSessionId,
						request.ownerBrokerId,
						request.group,
						request.dormant ? 1 : 0,
						request.wake ? 1 : 0,
						newWakeGeneration ? existing.wake_generation + 1 : existing.wake_generation,
						newWakeGeneration ? 1 : 0,
						fencingToken,
						JSON.stringify(
							request.replaceAliases === true
								? replacementTargets(request.childTarget, request.aliases)
								: mergeTargets(JSON.parse(existing.targets_json) as string[], request.aliases),
						),
						request.reservationKey,
					);
				} else {
					const order = await next(tx, "order");
					fencingToken = await next(tx, "token");
					const targets = [request.childTarget];
					for (const previous of await activeRowsForChild(tx, request.childTarget)) {
						if (previous.child_target !== request.childTarget) continue;
						const sameOwner = previous.owner_session_id === request.ownerSessionId;
						const dormantInGroup = previous.dormant === 1 && previous.reservation_group === request.group;
						if (!sameOwner && !dormantInGroup) continue;
						await end(tx, previous.reservation_key, { outcome: "superseded", by: request.reservationKey });
						mergeTargets(targets, JSON.parse(previous.targets_json) as string[]);
						superseded.push(previous.reservation_key);
					}
					await tx.run(
						// An ended row under the same key is replaced whole: the columns this insert leaves out start from their defaults.
						`INSERT INTO ${table}(reservation_key, "order", owner_session_id, owner_broker_id,
						 child_name, child_target, targets_json, "group", dormant, wake, fencing_token, gone, renewed_at,
						 end_json, ended_at, wake_requested, wake_generation)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ${nowMs}, NULL, NULL, 0, 0)
						 ON CONFLICT(reservation_key) DO UPDATE SET "order" = excluded."order",
						 owner_session_id = excluded.owner_session_id, owner_broker_id = excluded.owner_broker_id,
						 child_name = excluded.child_name, child_target = excluded.child_target,
						 targets_json = excluded.targets_json, "group" = excluded."group", dormant = excluded.dormant,
						 wake = excluded.wake, fencing_token = excluded.fencing_token, gone = excluded.gone,
						 renewed_at = excluded.renewed_at, end_json = excluded.end_json, ended_at = excluded.ended_at,
						 wake_requested = excluded.wake_requested, wake_generation = excluded.wake_generation`,
						request.reservationKey,
						order,
						request.ownerSessionId,
						request.ownerBrokerId,
						JSON.stringify(request.childName),
						request.childTarget,
						JSON.stringify(mergeTargets(targets, request.aliases)),
						request.group,
						request.dormant ? 1 : 0,
						request.wake ? 1 : 0,
						fencingToken,
					);
				}
				return {
					status: "reserved",
					lease: {
						reservationKey: request.reservationKey,
						ownerSessionId: request.ownerSessionId,
						fencingToken,
					},
					superseded,
				};
			}, serial);
		},
		async lookup(target, sender, staleAfterMs): Promise<RestoringReservationLookupResult> {
			if (target.length === 0) return invalid("empty-target");
			if (sender.sessionId.length === 0) return invalid("empty-session-id");
			const found = (await activeRows(database)).find(
				(row) =>
					row.age_ms <= staleAfterMs &&
					(JSON.parse(row.targets_json) as string[]).includes(target) &&
					(row.owner_session_id === sender.sessionId || reservationAdmitsSender(sender, row.reservation_group)),
			);
			if (found === undefined) return { status: "none" };
			return { status: found.gone_json === null ? "reserved" : "gone", reservation: reservationOf(found) };
		},
		async requestWake(reservationKey, claim): Promise<RestoringReservationRequestWakeResult> {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			return database.transaction(async (tx) => {
				if (claim !== undefined) {
					const { changes } = await tx.run(
						`INSERT INTO ${wakeClaims}(reservation_key, fencing_token, message_id)
						 SELECT reservation_key, fencing_token, ? FROM ${table}
						 WHERE reservation_key = ? AND fencing_token = ? AND wake_generation = ?
						 AND end_json IS NULL AND gone IS NULL AND wake = 1
						 ON CONFLICT DO NOTHING`,
						claim.messageId,
						reservationKey,
						claim.fencingToken,
						claim.wakeGeneration,
					);
					if (changes === 0) return { status: "not-wakeable" };
				}
				const { changes } = await tx.run(
					`UPDATE ${table} SET wake_requested = 1
					 WHERE reservation_key = ? AND end_json IS NULL AND gone IS NULL AND wake = 1`,
					reservationKey,
				);
				return { status: changes > 0 ? "requested" : "not-wakeable" };
			}, serial);
		},
		async takeWakeRequests(ownerBrokerId): Promise<RestoringReservationTakeWakeResult> {
			if (ownerBrokerId.length === 0) return invalid("empty-broker-id");
			return database.transaction(async (tx) => {
				const rows = await tx.all<ReservationRow>(
					`SELECT ${columns} FROM ${table}
					 WHERE owner_broker_id = ? AND wake_requested = 1 AND end_json IS NULL ORDER BY "order"`,
					ownerBrokerId,
				);
				for (const row of rows) {
					await tx.run(`UPDATE ${table} SET wake_requested = 0 WHERE reservation_key = ?`, row.reservation_key);
				}
				return {
					status: "taken",
					requests: rows.map((row) => ({
						reservationKey: row.reservation_key,
						ownerSessionId: row.owner_session_id,
						childName: JSON.parse(row.child_name_json) as string,
					})),
				};
			}, serial);
		},
		async renew(lease): Promise<RestoringReservationRenewResult> {
			const bad = invalidLease(lease);
			if (bad !== undefined) return bad;
			// Renewed again within the renewal interval, far inside the staleness limit: a renewal lost in a crash of the
			// database server leaves the reservation a renewal older and still held, so its commit does not wait for the disk.
			return database.transaction(async (tx) => {
				const stale = await owned(tx, lease);
				if (stale !== undefined) return stale;
				await tx.run(
					`UPDATE ${table} SET renewed_at = ${nowMs} WHERE reservation_key = ?`,
					lease.reservationKey,
				);
				return { status: "renewed" };
			}, { ...serial, relaxedDurability: true });
		},
		async renewMany(leases): Promise<RestoringReservationRenewResult[]> {
			if (leases.length === 0) return [];
			const invalidResults: Array<InvalidStateInput | undefined> = new Array(leases.length);
			let validCount = 0;
			for (let i = 0; i < leases.length; i++) {
				const bad = invalidLease(leases[i]!);
				if (bad !== undefined) invalidResults[i] = bad;
				else validCount++;
			}
			if (validCount === 0) return invalidResults as RestoringReservationRenewResult[];
			const tupleKey = (reservationKey: string, ownerSessionId: string, fencingToken: number) =>
				JSON.stringify([reservationKey.toWellFormed(), ownerSessionId.toWellFormed(), fencingToken]);
			const byTuple = new Map<string, RestoringReservationLease>();
			const validKeys = new Set<string>();
			let hasNonSafeIntToken = false;
			for (let i = 0; i < leases.length; i++) {
				if (invalidResults[i] !== undefined) continue;
				const lease = leases[i]!;
				validKeys.add(lease.reservationKey.toWellFormed());
				if (!Number.isSafeInteger(lease.fencingToken)) {
					hasNonSafeIntToken = true;
					continue;
				}
				const tKey = tupleKey(lease.reservationKey, lease.ownerSessionId, lease.fencingToken);
				if (!byTuple.has(tKey)) byTuple.set(tKey, lease);
			}
			const entries = [...byTuple.values()].sort((a, b) => compare(a.reservationKey, b.reservationKey));
			const answer = (
				renewed: ReadonlySet<string>,
				found: ReadonlyMap<string, MissedReservationRow>,
			): RestoringReservationRenewResult[] =>
				leases.map((lease, index): RestoringReservationRenewResult => {
					const bad = invalidResults[index];
					if (bad !== undefined) return bad;
					if (
						Number.isSafeInteger(lease.fencingToken) &&
						renewed.has(tupleKey(lease.reservationKey, lease.ownerSessionId, lease.fencingToken))
					)
						return { status: "renewed" };
					const row = found.get(lease.reservationKey.toWellFormed());
					if (row === undefined || row.end_json !== null) return { status: "stale" };
					return { status: "stale", currentFencingToken: Number(row.fencing_token) };
				});
			if (dialect === "postgres") {
				const keysParam = JSON.stringify([...validKeys], wellFormed);
				if (entries.length === 0) {
					const readAll: SqliteStatement = {
						sql: `SELECT reservation_key, end_json, fencing_token FROM ${table}
							WHERE reservation_key = ANY(ARRAY(SELECT value FROM ${jsonValues("?")}))`,
						params: [keysParam],
					};
					return database.transaction(
						async (tx) => {
							const found = new Map<string, MissedReservationRow>();
							for (const row of await tx.all<MissedReservationRow>(readAll.sql, ...readAll.params))
								found.set(row.reservation_key, row);
							return answer(new Set(), found);
						},
						{ ...serial, leading: [readAll], leadingOnly: true, relaxedDurability: true },
					);
				}
				const write: SqliteStatement = {
					sql: `WITH requested AS MATERIALIZED (
							SELECT
								entry ->> 0 AS reservation_key,
								entry ->> 1 AS owner_session_id,
								(entry ->> 2)::bigint AS fencing_token
							FROM jsonb_array_elements((?)::jsonb) AS entry
						),
						locked AS MATERIALIZED (
							SELECT t.reservation_key, requested.owner_session_id, requested.fencing_token
							FROM ${table} AS t
							JOIN requested
								ON t.reservation_key = requested.reservation_key
								AND t.owner_session_id = requested.owner_session_id
								AND t.fencing_token = requested.fencing_token
							WHERE t.reservation_key = ANY(ARRAY(SELECT DISTINCT reservation_key FROM requested))
								AND t.end_json IS NULL
							ORDER BY t.reservation_key
							FOR UPDATE OF t
						),
						renewed AS (
							UPDATE ${table} AS t
							SET renewed_at = ${nowMs}
							FROM locked
							WHERE t.reservation_key = locked.reservation_key
								AND t.owner_session_id = locked.owner_session_id
								AND t.fencing_token = locked.fencing_token
								AND t.end_json IS NULL
							RETURNING t.reservation_key, t.owner_session_id, t.fencing_token
						),
						gate AS MATERIALIZED (
							SELECT set_config('${RESERVATION_RENEW_MISSES}',
								CASE WHEN (SELECT COUNT(*) FROM renewed) < CAST(? AS ${types.int}) THEN '1' ELSE '' END,
								true) AS misses
						)
						SELECT renewed.reservation_key, renewed.owner_session_id, renewed.fencing_token
						FROM gate LEFT JOIN renewed ON TRUE`,
					params: [
						JSON.stringify(
							entries.map((lease) => [lease.reservationKey, lease.ownerSessionId, lease.fencingToken]),
							wellFormed,
						),
						entries.length + (hasNonSafeIntToken ? 1 : 0),
					],
				};
				const readMisses: SqliteStatement = {
					sql: `SELECT reservation_key, end_json, fencing_token FROM ${table}
						WHERE current_setting('${RESERVATION_RENEW_MISSES}', true) = '1'
							AND reservation_key = ANY(ARRAY(SELECT value FROM ${jsonValues("?")}))`,
					params: [keysParam],
				};
				return database.transaction(
					async (tx) => {
						const renewed = new Set<string>();
						for (const row of await tx.all<RenewedReservationRow>(write.sql, ...write.params))
							if (
								row.reservation_key !== null &&
								row.owner_session_id !== null &&
								row.fencing_token !== null
							)
								renewed.add(tupleKey(row.reservation_key, row.owner_session_id, Number(row.fencing_token)));
						const found = new Map<string, MissedReservationRow>();
						for (const row of await tx.all<MissedReservationRow>(readMisses.sql, ...readMisses.params))
							found.set(row.reservation_key, row);
						return answer(renewed, found);
					},
					{ ...serial, leading: [write, readMisses], leadingOnly: true, relaxedDurability: true },
				);
			}
			const write: SqliteStatement | undefined =
				entries.length === 0
					? undefined
					: {
							sql: `WITH requested AS (
									SELECT
										json_extract(value, '$[0]') AS req_reservation_key,
										json_extract(value, '$[1]') AS req_owner_session_id,
										json_extract(value, '$[2]') AS req_fencing_token
									FROM json_each(?)
								)
								UPDATE ${table}
								SET renewed_at = ${nowMs}
								FROM requested
								WHERE ${table}.reservation_key = requested.req_reservation_key
									AND ${table}.owner_session_id = requested.req_owner_session_id
									AND ${table}.fencing_token = requested.req_fencing_token
									AND ${table}.end_json IS NULL
								RETURNING reservation_key, owner_session_id, fencing_token`,
							params: [
								JSON.stringify(
									entries.map((lease) => [lease.reservationKey, lease.ownerSessionId, lease.fencingToken]),
									wellFormed,
								),
							],
						};
			const readMissedSql = `SELECT reservation_key, end_json, fencing_token FROM ${table}
				WHERE reservation_key IN (SELECT value FROM ${jsonValues("?")})`;
			return database.transaction(
				async (tx) => {
					const renewed = new Set<string>();
					if (write !== undefined) {
						for (const row of await tx.all<RenewedReservationRow>(write.sql, ...write.params))
							if (
								row.reservation_key !== null &&
								row.owner_session_id !== null &&
								row.fencing_token !== null
							)
								renewed.add(tupleKey(row.reservation_key, row.owner_session_id, Number(row.fencing_token)));
					}
					const missedKeys = new Set<string>();
					for (let i = 0; i < leases.length; i++) {
						if (invalidResults[i] !== undefined) continue;
						const lease = leases[i]!;
						if (
							Number.isSafeInteger(lease.fencingToken) &&
							renewed.has(tupleKey(lease.reservationKey, lease.ownerSessionId, lease.fencingToken))
						)
							continue;
						missedKeys.add(lease.reservationKey.toWellFormed());
					}
					const found = new Map<string, MissedReservationRow>();
					if (missedKeys.size > 0) {
						const rows = await tx.all<MissedReservationRow>(
							readMissedSql,
							JSON.stringify([...missedKeys], wellFormed),
						);
						for (const row of rows) found.set(row.reservation_key, row);
					}
					return answer(renewed, found);
				},
				{ ...serial, relaxedDurability: true },
			);
		},
		async release(lease, outcome): Promise<RestoringReservationReleaseResult> {
			const bad = invalidLease(lease);
			if (bad !== undefined) return bad;
			return database.transaction(async (tx) => {
				const stale = await owned(tx, lease);
				if (stale !== undefined) return stale;
				if (outcome?.gone !== undefined) {
					await tx.run(
						`UPDATE ${table} SET gone = ? WHERE reservation_key = ?`,
						JSON.stringify(outcome.gone),
						lease.reservationKey,
					);
					return { status: "gone" };
				}
				await end(
					tx,
					lease.reservationKey,
					outcome?.refusal === undefined
						? { outcome: "released" }
						: { outcome: "released", refusal: outcome.refusal },
				);
				return { status: "released" };
			}, serial);
		},
		async consume(reservationKey, registered): Promise<RestoringReservationConsumeResult> {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			if (registered !== undefined && registered.childTarget.length === 0) return invalid("empty-target");
			return database.transaction(async (tx) => {
				const ended: string[] = [];
				const candidates =
					registered === undefined
						? await activeRowsForChild(tx, reservationKey, reservationKey)
						: await activeRowsForChild(tx, registered.childTarget, reservationKey);
				for (const row of candidates) {
					if (row.gone_json !== null) continue;
					const own = row.reservation_key === reservationKey && !isReleasedReservationKey(row.reservation_key);
					const dormantChild =
						registered !== undefined &&
						endsWithRegistration(row, registered) &&
						row.child_target === registered.childTarget &&
						registered.groups.includes(row.reservation_group);
					if (!own && !dormantChild) continue;
					await end(tx, row.reservation_key, { outcome: "consumed" });
					ended.push(row.reservation_key);
				}
				return { status: "consumed", reservationKeys: ended };
			}, serial);
		},
		async insertionMark(): Promise<number> {
			const row = await database.get<SqliteRow & { value: number }>(
				`SELECT value FROM ${counters} WHERE name = 'order'`,
			);
			return row?.value ?? 0;
		},
		async read(reservationKey): Promise<RestoringReservationReadResult> {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			const row = await readRow(database, reservationKey);
			if (row === undefined) return { status: "missing" };
			if (row.end_json !== null) return { status: "ended", end: endOf(row.end_json) };
			return { status: "active", reservation: reservationOf(row), ageMs: row.age_ms };
		},
		async prune(olderThanMs): Promise<number> {
			return database.transaction(async (tx) => {
				const { changes } = await tx.run(
					`DELETE FROM ${table} WHERE ${nowMs} - COALESCE(ended_at, renewed_at) > ?`,
					olderThanMs,
				);
				await tx.run(`DELETE FROM ${wakeClaims} WHERE reservation_key NOT IN (SELECT reservation_key FROM ${table})`);
				return changes;
			}, serial);
		},
	};
}
