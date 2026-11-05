import { type SqliteExecutor, type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
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
	RestoringReservationReleaseResult,
	RestoringReservationRenewResult,
	RestoringReservationRequestWakeResult,
	RestoringReservationReserveResult,
	RestoringReservationStore,
	RestoringReservationTakeWakeResult,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";
import { isReleasedReservationKey } from "./released-children.js";

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
	fencing_token: number;
	gone_json: string | null;
	end_json: string | null;
	age_ms: number;
};

type Counter = "order" | "token";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

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
 * S3: `RestoringReservationStore` on the shared storage adapter's database, table
 * `<prefix>intercom_restoring_reservations`. Insertion order and fencing tokens come from
 * `<prefix>intercom_restoring_reservation_counters`, so both keep increasing after `prune` deletes rows.
 */
export async function openSqlRestoringReservationStore({
	database,
	prefix,
}: IntercomBrokerStateOptions): Promise<RestoringReservationStore> {
	const validPrefix = validateStoragePrefix(prefix);
	const table = `${validPrefix}intercom_restoring_reservations`;
	const counters = `${validPrefix}intercom_restoring_reservation_counters`;
	await database.transaction((tx) =>
		tx.exec(`
			CREATE TABLE IF NOT EXISTS ${table}(
				reservation_key TEXT PRIMARY KEY,
				"order" INTEGER NOT NULL,
				owner_session_id TEXT NOT NULL,
				owner_broker_id TEXT NOT NULL,
				child_name TEXT NOT NULL,
				child_target TEXT NOT NULL,
				targets_json TEXT NOT NULL,
				"group" TEXT NOT NULL,
				dormant INTEGER NOT NULL,
				fencing_token INTEGER NOT NULL,
				gone TEXT,
				renewed_at INTEGER NOT NULL,
				end_json TEXT,
				ended_at INTEGER
			);
			CREATE INDEX IF NOT EXISTS ${table}_active ON ${table}(end_json, "order");
			CREATE TABLE IF NOT EXISTS ${counters}(name TEXT PRIMARY KEY, value INTEGER NOT NULL);
			INSERT INTO ${counters}(name, value) VALUES ('order', 0), ('token', 0) ON CONFLICT(name) DO NOTHING;
		`),
	);
	// #4326: added later; a table from an older broker gets the columns, and an older broker ignores them.
	const known = await database.all<{ name: string }>(`PRAGMA table_info(${table})`);
	for (const column of ["wake", "wake_requested"]) {
		if (known.some((existing) => existing.name === column)) continue;
		try {
			await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
		} catch (error) {
			if (!/duplicate column/i.test(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : ""))
				throw error;
		}
	}
	await database.exec(
		`CREATE INDEX IF NOT EXISTS ${table}_child ON ${table}(child_target) WHERE end_json IS NULL`,
	);
	await database.exec(
		`CREATE INDEX IF NOT EXISTS ${table}_wake_requested ON ${table}(owner_broker_id) WHERE wake_requested = 1`,
	);
	const columns = `reservation_key, owner_session_id, owner_broker_id, child_name AS child_name_json, child_target,
		targets_json, "group" AS reservation_group, dormant, wake, fencing_token, gone AS gone_json, end_json,
		MAX(0, ${STORE_NOW} - renewed_at) AS age_ms`;
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
			`UPDATE ${table} SET end_json = ?, ended_at = ${STORE_NOW} WHERE reservation_key = ?`,
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
				let fencingToken: number;
				if (existing !== undefined && existing.end_json === null) {
					fencingToken =
						existing.owner_session_id === request.ownerSessionId
							? existing.fencing_token
							: await next(tx, "token");
					await tx.run(
						`UPDATE ${table} SET owner_session_id = ?, owner_broker_id = ?, "group" = ?, dormant = ?, wake = ?,
						 fencing_token = ?, targets_json = ?, renewed_at = ${STORE_NOW} WHERE reservation_key = ?`,
						request.ownerSessionId,
						request.ownerBrokerId,
						request.group,
						request.dormant ? 1 : 0,
						request.wake ? 1 : 0,
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
						`INSERT OR REPLACE INTO ${table}(reservation_key, "order", owner_session_id, owner_broker_id,
						 child_name, child_target, targets_json, "group", dormant, wake, fencing_token, gone, renewed_at,
						 end_json, ended_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ${STORE_NOW}, NULL, NULL)`,
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
			});
		},
		async lookup(target, sender, staleAfterMs): Promise<RestoringReservationLookupResult> {
			if (target.length === 0) return invalid("empty-target");
			if (sender.sessionId.length === 0) return invalid("empty-session-id");
			const found = (await activeRows(database)).find(
				(row) =>
					row.age_ms <= staleAfterMs &&
					(JSON.parse(row.targets_json) as string[]).includes(target) &&
					(row.owner_session_id === sender.sessionId || sender.groups.includes(row.reservation_group)),
			);
			if (found === undefined) return { status: "none" };
			return { status: found.gone_json === null ? "reserved" : "gone", reservation: reservationOf(found) };
		},
		async requestWake(reservationKey): Promise<RestoringReservationRequestWakeResult> {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			const { changes } = await database.run(
				`UPDATE ${table} SET wake_requested = 1
				 WHERE reservation_key = ? AND end_json IS NULL AND gone IS NULL AND wake = 1`,
				reservationKey,
			);
			return { status: changes > 0 ? "requested" : "not-wakeable" };
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
			});
		},
		async renew(lease): Promise<RestoringReservationRenewResult> {
			const bad = invalidLease(lease);
			if (bad !== undefined) return bad;
			return database.transaction(async (tx) => {
				const stale = await owned(tx, lease);
				if (stale !== undefined) return stale;
				await tx.run(
					`UPDATE ${table} SET renewed_at = ${STORE_NOW} WHERE reservation_key = ?`,
					lease.reservationKey,
				);
				return { status: "renewed" };
			});
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
			});
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
						(isReleasedReservationKey(row.reservation_key) || (row.dormant === 1 && registered.releasedOnly !== true)) &&
						row.child_target === registered.childTarget &&
						registered.groups.includes(row.reservation_group);
					if (!own && !dormantChild) continue;
					await end(tx, row.reservation_key, { outcome: "consumed" });
					ended.push(row.reservation_key);
				}
				return { status: "consumed", reservationKeys: ended };
			});
		},
		async read(reservationKey): Promise<RestoringReservationReadResult> {
			if (reservationKey.length === 0) return invalid("empty-reservation-key");
			const row = await readRow(database, reservationKey);
			if (row === undefined) return { status: "missing" };
			if (row.end_json !== null) return { status: "ended", end: endOf(row.end_json) };
			return { status: "active", reservation: reservationOf(row), ageMs: row.age_ms };
		},
		async prune(olderThanMs): Promise<number> {
			const { changes } = await database.run(
				`DELETE FROM ${table} WHERE ${STORE_NOW} - COALESCE(ended_at, renewed_at) > ?`,
				olderThanMs,
			);
			return changes;
		},
	};
}
