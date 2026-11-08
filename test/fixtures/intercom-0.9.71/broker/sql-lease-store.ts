import { type SqliteExecutor, type SqliteRow, validateStoragePrefix } from "@bastani/atomic/storage";
import type {
	BrokerLeaseStore,
	IntercomBrokerStateOptions,
	InvalidStateInput,
	Lease,
	LeaseKey,
	LeaseKind,
	LeaseState,
	LeaseSubject,
	StateStoreInvalidReason,
} from "./multinode-state-store.js";

const STORE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const AGE = `MAX(0, ${STORE_NOW} - renewed_at)`;

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
	database: SqliteExecutor,
	prefix: string | undefined,
	staleAfterMs: number,
): Promise<string[] | undefined> {
	const table = `${validateStoragePrefix(prefix)}intercom_leases`;
	const exists = await database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table);
	if (exists === undefined) return undefined;
	const rows = await database.all<StateRow>(
		`SELECT kind, key, holder_id, fencing_token, subject_json, ${AGE} AS age_ms FROM ${table}
		WHERE kind = 'broker' AND holder_id IS NOT NULL AND ${AGE} <= ? ORDER BY first_acquired_order`,
		staleAfterMs,
	);
	return rows.flatMap((row) => {
		const { subject } = stateFromRow(row);
		return subject.kind === "broker" ? [subject.nodeId] : [];
	});
}

/** Opens the S1 lease store on the shared database's `<prefix>intercom_leases` table; the database stays open. */
export async function openSqlBrokerLeaseStore(options: IntercomBrokerStateOptions): Promise<BrokerLeaseStore> {
	const { database } = options;
	const table = `${validateStoragePrefix(options.prefix)}intercom_leases`;
	await database.exec(`
		CREATE TABLE IF NOT EXISTS ${table}(
			kind TEXT NOT NULL, key TEXT NOT NULL, holder_id TEXT, fencing_token INTEGER,
			last_token INTEGER NOT NULL, subject_json TEXT, renewed_at INTEGER,
			first_acquired_order INTEGER NOT NULL, PRIMARY KEY(kind, key)
		)
	`);

	const holderOf = (executor: SqliteExecutor, key: LeaseKey) =>
		executor.get<HolderRow>(
			`SELECT holder_id, fencing_token, last_token, ${AGE} AS age_ms FROM ${table} WHERE kind = ? AND key = ?`,
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
						VALUES (?, ?, ?, 1, 1, ?, ${STORE_NOW},
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
						`UPDATE ${table} SET subject_json = ?, renewed_at = ${STORE_NOW} WHERE kind = ? AND key = ?`,
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
						renewed_at = ${STORE_NOW} WHERE kind = ? AND key = ?`,
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
						? await tx.run(`UPDATE ${table} SET renewed_at = ${STORE_NOW} WHERE ${owned}`, ...ownedParams(lease))
						: await tx.run(
								`UPDATE ${table} SET renewed_at = ${STORE_NOW}, subject_json = ? WHERE ${owned}`,
								JSON.stringify(subject),
								...ownedParams(lease),
							);
				return changes === 1 ? ({ status: "renewed" } as const) : stale(await holderOf(tx, lease.key));
			});
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
				`SELECT kind, key, holder_id, fencing_token, subject_json, ${AGE} AS age_ms FROM ${table}
				WHERE kind = ? AND key = ? AND holder_id IS NOT NULL`,
				key.kind,
				keyId(key),
			);
			return row === undefined ? { status: "missing" } : { status: "found", lease: stateFromRow(row) };
		},
		async listLive(kind, staleAfterMs) {
			const rows = await database.all<StateRow>(
				`SELECT kind, key, holder_id, fencing_token, subject_json, ${AGE} AS age_ms FROM ${table}
				WHERE kind = ? AND holder_id IS NOT NULL AND ${AGE} <= ? ORDER BY first_acquired_order`,
				kind,
				staleAfterMs,
			);
			return rows.map(stateFromRow);
		},
	};
}
