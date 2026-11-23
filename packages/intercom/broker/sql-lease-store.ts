import {
	dialectOf,
	type SqliteExecutor,
	type SqliteRow,
	type StorageDialect,
	validateStoragePrefix,
} from "@bastani/atomic/storage";
import type {
	BrokerLeaseStore,
	IntercomBrokerStateOptions,
	InvalidStateInput,
	Lease,
	LeaseKey,
	LeaseKind,
	LeaseRenewResult,
	LeaseState,
	LeaseSubject,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";
import { ensureBrokerSchema } from "./sql-schema.js";

/** Store-clock milliseconds since the lease was renewed, never negative. */
const age = ({ greatest, nowMs }: StorageDialect) => greatest("0", `${nowMs} - renewed_at`);

/**
 * A read of the live leases of one kind, oldest first, that reads the clock once: PostgreSQL's moves on between two
 * readings, and a lease it found within the stale bound would otherwise report an age past it.
 */
const liveLeases = (dialect: StorageDialect, table: string) =>
	`WITH clock AS (SELECT ${dialect.nowMs} AS now)
	SELECT kind, key, holder_id, fencing_token, subject_json, ${dialect.greatest("0", "(SELECT now FROM clock) - renewed_at")} AS age_ms
	FROM ${table} WHERE kind = ? AND holder_id IS NOT NULL
	AND ${dialect.greatest("0", "(SELECT now FROM clock) - renewed_at")} <= ? ORDER BY first_acquired_order`;

type HolderRow = SqliteRow & {
	holder_id: string | null;
	fencing_token: number | bigint | null;
	last_token: number | bigint;
	age_ms: number | bigint | null;
};

type StateRow = SqliteRow & {
	kind: string;
	key: string;
	holder_id: string;
	fencing_token: number | bigint;
	subject_json: string;
	age_ms: number | bigint;
};

const invalid = (reason: StateStoreInvalidReason): InvalidStateInput => ({ status: "invalid", reason });

function keyOf(subject: LeaseSubject): LeaseKey {
	return subject.kind === "broker"
		? { kind: "broker", brokerId: subject.brokerId }
		: { kind: "presence", targetIdentity: subject.targetIdentity };
}

function keyId(key: LeaseKey): string {
	return key.kind === "broker" ? key.brokerId : key.targetIdentity;
}

function keyFor(kind: LeaseKind, id: string): LeaseKey {
	return kind === "broker" ? { kind, brokerId: id } : { kind, targetIdentity: id };
}

function invalidKey(key: LeaseKey): InvalidStateInput | undefined {
	if (keyId(key).length > 0) return undefined;
	return invalid(key.kind === "broker" ? "empty-broker-id" : "empty-target-identity");
}

function stateFromRow(row: StateRow): LeaseState {
	const subject: LeaseSubject = JSON.parse(row.subject_json);
	return {
		key: keyFor(row.kind === "broker" ? "broker" : "presence", row.key),
		holderId: row.holder_id,
		fencingToken: Number(row.fencing_token),
		subject,
		ageMs: Number(row.age_ms),
	};
}

/**
 * The host names of the brokers whose membership lease is live in `<prefix>intercom_leases`, read without creating
 * the table: `undefined` when no broker has created it yet. For status reports; brokers use `listLive`.
 */
export async function readLiveBrokerNodes(
	database: SqliteExecutor & { readonly dialect?: StorageDialect },
	prefix: string | undefined,
	staleAfterMs: number,
): Promise<string[] | undefined> {
	const table = `${validateStoragePrefix(prefix, dialectOf(database).name)}intercom_leases`;
	const dialect = dialectOf(database);
	const exists = dialect.tableExists(table);
	if ((await database.get(exists.sql, ...exists.params)) === undefined) return undefined;
	const rows = await database.all<StateRow>(liveLeases(dialect, table), "broker", staleAfterMs);
	return rows.flatMap((row) => {
		const { subject } = stateFromRow(row);
		return subject.kind === "broker" ? [subject.nodeId] : [];
	});
}

/** Opens the S1 lease store on the shared database's `<prefix>intercom_leases` table; the database stays open. */
export async function openSqlBrokerLeaseStore(options: IntercomBrokerStateOptions): Promise<BrokerLeaseStore> {
	const { database } = options;
	const table = `${validateStoragePrefix(options.prefix, dialectOf(database).name)}intercom_leases`;
	const dialect = dialectOf(database);
	const { types, nowMs } = dialect;
	const leaseAge = age(dialect);
	// In a serial transaction, so brokers opening a new store at once take turns creating it (#5054).
	const schema = `
		CREATE TABLE IF NOT EXISTS ${table}(
			kind TEXT NOT NULL, key TEXT NOT NULL, holder_id TEXT, fencing_token ${types.int},
			last_token ${types.int} NOT NULL, subject_json TEXT, renewed_at ${types.int},
			first_acquired_order ${types.int} NOT NULL, PRIMARY KEY(kind, key)
		)
	`;
	await ensureBrokerSchema(database, options.prefix, "leases", (tx) => tx.exec(schema));

	const holderOf = (executor: SqliteExecutor, key: LeaseKey) =>
		executor.get<HolderRow>(
			`SELECT holder_id, fencing_token, last_token, ${leaseAge} AS age_ms FROM ${table} WHERE kind = ? AND key = ?`,
			key.kind,
			keyId(key),
		);
	const stale = (row: HolderRow | undefined) =>
		row?.holder_id === null || row?.holder_id === undefined
			? ({ status: "stale" } as const)
			: ({ status: "stale", currentFencingToken: Number(row.fencing_token) } as const);
	const validLease = (lease: Lease): InvalidStateInput | undefined =>
		invalidKey(lease.key) ?? (lease.holderId.length === 0 ? invalid("empty-holder-id") : undefined);
	const owned = `kind = ? AND key = ? AND holder_id = ? AND fencing_token = ?`;
	const ownedParams = (lease: Lease) => [lease.key.kind, keyId(lease.key), lease.holderId, lease.fencingToken];

	return {
		async acquire(subject, holderId, staleAfterMs) {
			const key = keyOf(subject);
			const bad = invalidKey(key);
			if (bad !== undefined) return bad;
			if (holderId.length === 0) return invalid("empty-holder-id");
			const subjectJson = JSON.stringify(subject);
			return database.transaction(async (tx) => {
				const row = await holderOf(tx, key);
				if (row === undefined) {
					await tx.run(
						`INSERT INTO ${table}(kind, key, holder_id, fencing_token, last_token, subject_json, renewed_at,
							first_acquired_order)
						VALUES (?, ?, ?, 1, 1, ?, ${nowMs},
							(SELECT COALESCE(MAX(first_acquired_order), 0) + 1 FROM ${table}))`,
						key.kind,
						keyId(key),
						holderId,
						subjectJson,
					);
					return { status: "acquired", lease: { key, holderId, fencingToken: 1 } } as const;
				}
				if (row.holder_id === holderId) {
					await tx.run(
						`UPDATE ${table} SET subject_json = ?, renewed_at = ${nowMs} WHERE kind = ? AND key = ?`,
						subjectJson,
						key.kind,
						keyId(key),
					);
					return {
						status: "acquired",
						lease: { key, holderId, fencingToken: Number(row.fencing_token) },
					} as const;
				}
				if (row.holder_id !== null && Number(row.age_ms) <= staleAfterMs) {
					return { status: "held", holderId: row.holder_id, fencingToken: Number(row.fencing_token) } as const;
				}
				const fencingToken = Number(row.last_token) + 1;
				await tx.run(
					`UPDATE ${table} SET holder_id = ?, fencing_token = ?, last_token = ?, subject_json = ?,
						renewed_at = ${nowMs} WHERE kind = ? AND key = ?`,
					holderId,
					fencingToken,
					fencingToken,
					subjectJson,
					key.kind,
					keyId(key),
				);
				return { status: "acquired", lease: { key, holderId, fencingToken } } as const;
			});
		},
		async renew(lease, subject) {
			const bad = validLease(lease);
			if (bad !== undefined) return bad;
			if (subject !== undefined && (subject.kind !== lease.key.kind || keyId(keyOf(subject)) !== keyId(lease.key))) {
				return invalid("subject-key-mismatch");
			}
			return database.transaction(async (tx) => {
				const { changes } =
					subject === undefined
						? await tx.run(`UPDATE ${table} SET renewed_at = ${nowMs} WHERE ${owned}`, ...ownedParams(lease))
						: await tx.run(
								`UPDATE ${table} SET renewed_at = ${nowMs}, subject_json = ? WHERE ${owned}`,
								JSON.stringify(subject),
								...ownedParams(lease),
							);
				return changes === 1 ? ({ status: "renewed" } as const) : stale(await holderOf(tx, lease.key));
			});
		},
		async renewMany(requests) {
			if (requests.length === 0) return [];
			const results: Array<LeaseRenewResult | undefined> = new Array(requests.length);
			let validCount = 0;
			for (let i = 0; i < requests.length; i++) {
				const { lease, subject } = requests[i]!;
				const bad = validLease(lease);
				if (bad !== undefined) {
					results[i] = bad;
				} else if (
					subject !== undefined &&
					(subject.kind !== lease.key.kind || keyId(keyOf(subject)) !== keyId(lease.key))
				) {
					results[i] = invalid("subject-key-mismatch");
				} else {
					validCount++;
				}
			}
			if (validCount === 0) return results as LeaseRenewResult[];
			await database.transaction(async (tx) => {
				for (let i = 0; i < requests.length; i++) {
					if (results[i] !== undefined) continue;
					const { lease, subject } = requests[i]!;
					const { changes } =
						subject === undefined
							? await tx.run(`UPDATE ${table} SET renewed_at = ${nowMs} WHERE ${owned}`, ...ownedParams(lease))
							: await tx.run(
									`UPDATE ${table} SET renewed_at = ${nowMs}, subject_json = ? WHERE ${owned}`,
									JSON.stringify(subject),
									...ownedParams(lease),
								);
					results[i] = changes === 1 ? ({ status: "renewed" } as const) : stale(await holderOf(tx, lease.key));
				}
			});
			return results as LeaseRenewResult[];
		},
		async release(lease) {
			const bad = validLease(lease);
			if (bad !== undefined) return bad;
			return database.transaction(async (tx) => {
				const { changes } = await tx.run(
					`UPDATE ${table} SET holder_id = NULL, fencing_token = NULL, subject_json = NULL, renewed_at = NULL
					WHERE ${owned}`,
					...ownedParams(lease),
				);
				return changes === 1 ? ({ status: "released" } as const) : stale(await holderOf(tx, lease.key));
			});
		},
		async read(key) {
			const bad = invalidKey(key);
			if (bad !== undefined) return bad;
			const row = await database.get<StateRow>(
				`SELECT kind, key, holder_id, fencing_token, subject_json, ${leaseAge} AS age_ms FROM ${table}
				WHERE kind = ? AND key = ? AND holder_id IS NOT NULL`,
				key.kind,
				keyId(key),
			);
			return row === undefined ? { status: "missing" } : { status: "found", lease: stateFromRow(row) };
		},
		async listLive(kind, staleAfterMs) {
			const rows = await database.all<StateRow>(liveLeases(dialect, table), kind, staleAfterMs);
			return rows.map(stateFromRow);
		},
		async retireHolder(holderId) {
			const { changes } = await database.run(
				`UPDATE ${table} SET holder_id = NULL, fencing_token = NULL, subject_json = NULL, renewed_at = NULL
				WHERE holder_id = ?`,
				holderId,
			);
			return changes;
		},
	};
}
