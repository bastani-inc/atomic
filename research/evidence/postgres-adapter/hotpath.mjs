// The shared pool's hot path (claim, heartbeat, commit, complete) on three backends, for the PostgreSQL adapter spec
// (#4793). Not product code: a throwaway prototype that runs the statements `SqlPoolQueue` runs, in the same order
// and with the same decisions between them, so the cost per backend can be compared on the #4768 harness shape.
//
//   sqlite      SQLite SQL through Atomic's own libSQL adapter (`@bastani/atomic-storage-libsql`) against sqld. Each
//               transaction is interactive, as today: `BEGIN IMMEDIATE`, one request per statement, `COMMIT`.
//   pg-serial   The same statements, mechanically rewritten for Postgres, with `BEGIN IMMEDIATE` kept honest by a
//               database-wide transaction lock (`pg_advisory_xact_lock`). What a SQL-rewriting dialect layer must do
//               to keep SQLite's one-writer semantics: architecture (a) in the spec.
//   pg          The designed port (architecture (b)): READ COMMITTED, the root lease row `FOR SHARE` as the root fence,
//               the work row `FOR UPDATE` as the attempt fence, `FOR UPDATE SKIP LOCKED` for the claim, and the run's
//               sequence allocated by one late `UPDATE … RETURNING` statement, so the only lock every writer of a root
//               shares is held for one statement and the commit.
import { createRequire } from "node:module";

export const SQLITE_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export const PG_NOW = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

export class StaleError extends Error {
	constructor(reason) {
		super(`stale: ${reason}`);
		this.reason = reason;
	}
}

const t = (prefix) => ({
	runs: `${prefix}runs`,
	leases: `${prefix}leases`,
	events: `${prefix}events`,
	pool: `${prefix}pool`,
	control: `${prefix}pool_control`,
	work: `${prefix}work`,
	operations: `${prefix}pool_operations`,
	results: `${prefix}work_results`,
	hosts: `${prefix}pool_hosts`,
});

export function schema(dialect, prefix) {
	const n = t(prefix);
	const int = dialect === "sqlite" ? "INTEGER" : "BIGINT";
	// `seq` replaces SQLite's implicit rowid as the claim's tie-break; `last_seq` is the run's sequence counter.
	const identity = dialect === "sqlite" ? "INTEGER" : "BIGINT GENERATED ALWAYS AS IDENTITY";
	return [
		`CREATE TABLE IF NOT EXISTS ${n.runs}(run_id TEXT PRIMARY KEY, status TEXT NOT NULL, last_seq ${int} NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS ${n.leases}(run_id TEXT PRIMARY KEY, holder_id TEXT, epoch ${int} NOT NULL, renewed_at ${int} NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS ${n.events}(run_id TEXT NOT NULL, seq ${int} NOT NULL, epoch ${int} NOT NULL, key TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, at ${int} NOT NULL, PRIMARY KEY(run_id, seq), UNIQUE(run_id, key))`,
		`CREATE TABLE IF NOT EXISTS ${n.pool}(root TEXT PRIMARY KEY REFERENCES ${n.runs}(run_id) ON DELETE CASCADE, timeout ${int} NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS ${n.control}(root TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'running', revision ${int} NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS ${n.work}(id TEXT PRIMARY KEY, seq ${identity}${dialect === "sqlite" ? "" : " UNIQUE"}, root TEXT NOT NULL REFERENCES ${n.pool}(root) ON DELETE CASCADE, boundary TEXT NOT NULL, descriptor TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'ready', generation ${int} NOT NULL DEFAULT 0, worker TEXT, epoch ${int} NOT NULL DEFAULT 0, expires_at ${int} NOT NULL DEFAULT 0, renewed_at ${int} NOT NULL DEFAULT 0, ready_at ${int} NOT NULL, UNIQUE(root, boundary))`,
		`CREATE INDEX IF NOT EXISTS ${n.work}_ready ON ${n.work}(root, state, ready_at)`,
		dialect === "sqlite"
			? `CREATE UNIQUE INDEX IF NOT EXISTS ${n.work}_child ON ${n.work}(root, json_extract(descriptor, '$.childRunId'))`
			: `CREATE UNIQUE INDEX IF NOT EXISTS ${n.work}_child ON ${n.work}(root, ((descriptor::jsonb) ->> 'childRunId'))`,
		`CREATE TABLE IF NOT EXISTS ${n.operations}(work TEXT NOT NULL REFERENCES ${n.work}(id) ON DELETE CASCADE, generation ${int} NOT NULL, operation TEXT NOT NULL, request TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(work, generation, operation))`,
		`CREATE TABLE IF NOT EXISTS ${n.results}(work TEXT PRIMARY KEY REFERENCES ${n.work}(id) ON DELETE CASCADE, result TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS ${n.hosts}(host TEXT PRIMARY KEY, slots ${int} NOT NULL, busy ${int} NOT NULL, renewed_at ${int} NOT NULL)`,
	];
}

/**
 * A statement executor per backend, with `?` placeholders. Postgres placeholders are numbered by the driver wrapper,
 * never by the statements: the stores keep one SQL text.
 */
function numbered(sql) {
	let index = 0;
	return sql.replace(/\?/g, () => `$${++index}`);
}

export async function openSqlite({ url }) {
	const { openLibsqlDatabase } = await import("../../../packages/storage-libsql/libsql.js");
	const database = await openLibsqlDatabase({ url });
	return {
		dialect: "sqlite",
		now: SQLITE_NOW,
		forShare: "",
		forUpdate: "",
		async write(body) {
			return database.transaction((tx) => body({ get: (s, ...p) => tx.get(s, ...p), all: (s, ...p) => tx.all(s, ...p), run: (s, ...p) => tx.run(s, ...p) }));
		},
		get: (s, ...p) => database.get(s, ...p),
		all: (s, ...p) => database.all(s, ...p),
		run: (s, ...p) => database.run(s, ...p),
		exec: (s) => database.exec(s),
		close: () => database.close(),
	};
}

export function openPostgres({ url, serial, max, pgModule }) {
	const require = createRequire(pgModule);
	const pg = require("pg");
	pg.types.setTypeParser(20, (value) => Number(value));
	const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 0 });
	const query = async (client, sql, params) => (await client.query(numbered(sql), params)).rows;
	const handle = (client) => ({
		get: async (sql, ...params) => (await query(client, sql, params))[0],
		all: (sql, ...params) => query(client, sql, params),
		run: async (sql, ...params) => ({ changes: (await client.query(numbered(sql), params)).rowCount }),
	});
	return {
		dialect: serial ? "pg-serial" : "pg",
		now: PG_NOW,
		forShare: serial ? "" : " FOR SHARE OF l",
		forUpdate: serial ? "" : " FOR UPDATE",
		async write(body) {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				// What `BEGIN IMMEDIATE` means, made explicit: one writer at a time in the whole database.
				if (serial) await client.query("SELECT pg_advisory_xact_lock(4793)");
				const result = await body(handle(client));
				await client.query("COMMIT");
				return result;
			} catch (error) {
				await client.query("ROLLBACK").catch(() => {});
				throw error;
			} finally {
				client.release();
			}
		},
		get: (sql, ...params) => handle(pool).get(sql, ...params),
		all: (sql, ...params) => handle(pool).all(sql, ...params),
		run: (sql, ...params) => handle(pool).run(sql, ...params),
		exec: (sql) => pool.query(sql),
		close: () => pool.end(),
	};
}

/** The hot path, written once per transaction shape. `db.dialect` picks the designed Postgres shape where it differs. */
export function hotPath(db, prefix) {
	const n = t(prefix);
	const designed = db.dialect === "pg";
	const NOW = db.now;
	const authority = async (tx, lease) => {
		const row = await tx.get(
			`SELECT l.epoch, l.holder_id, l.renewed_at, r.status, p.timeout, ${NOW} AS now FROM ${n.leases} l JOIN ${n.runs} r ON r.run_id = l.run_id LEFT JOIN ${n.pool} p ON p.root = l.run_id WHERE l.run_id = ?${db.forShare}`,
			lease.runId,
		);
		if (!row || row.epoch !== lease.epoch || row.holder_id !== lease.holderId || row.renewed_at + row.timeout < row.now)
			throw new StaleError("root-lease");
		return row;
	};
	const current = async (tx, lease, token) => {
		const row = await tx.get(`SELECT * FROM ${n.work} WHERE id = ? AND root = ?${db.forUpdate}`, token.id, lease.runId);
		if (!row || row.state !== "leased" || row.generation !== token.generation || row.worker !== token.worker || row.epoch !== lease.epoch)
			throw new StaleError("work");
		return row;
	};
	return {
		async candidates(lease, limit) {
			return db.all(
				`SELECT id, generation FROM ${n.work} WHERE root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ${NOW} ORDER BY ready_at, ${db.dialect === "sqlite" ? "rowid" : "seq"} LIMIT ?`,
				lease.runId,
				lease.epoch,
				limit,
			);
		},
		async claim(lease, worker, candidate, durationMs) {
			return db.write(async (tx) => {
				const { now, status } = await authority(tx, lease);
				const control = await tx.get(`SELECT state FROM ${n.control} WHERE root = ?`, lease.runId);
				if ((control && control.state !== "running") || status !== "running") return undefined;
				if (designed) {
					// One statement: the row is locked, skipped when another claimer holds it, and taken.
					return tx.get(
						`UPDATE ${n.work} SET state = 'leased', generation = generation + 1, worker = ?, expires_at = ?, renewed_at = ?
						 WHERE id = (SELECT id FROM ${n.work} WHERE id = ? AND generation = ? AND root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ? FOR UPDATE SKIP LOCKED)
						 RETURNING *`,
						worker, now + durationMs, now, candidate.id, candidate.generation, lease.runId, lease.epoch, now,
					);
				}
				const row = await tx.get(
					`SELECT * FROM ${n.work} WHERE root = ? AND state = 'ready' AND epoch = ? AND ready_at <= ? AND id = ? AND generation = ? ORDER BY ready_at, ${db.dialect === "sqlite" ? "rowid" : "seq"} LIMIT 1`,
					lease.runId, lease.epoch, now, candidate.id, candidate.generation,
				);
				if (!row) return undefined;
				await tx.run(
					`UPDATE ${n.work} SET state = 'leased', generation = ?, worker = ?, epoch = ?, expires_at = ?, renewed_at = ? WHERE id = ? AND state = 'ready' AND generation = ?`,
					row.generation + 1, worker, lease.epoch, now + durationMs, now, row.id, row.generation,
				);
				return tx.get(`SELECT * FROM ${n.work} WHERE id = ?`, row.id);
			});
		},
		async commit(lease, token, operation, checkpointId, payload) {
			return db.write(async (tx) => {
				const { now } = await authority(tx, lease);
				const row = await current(tx, lease, token);
				if (row.expires_at < now) throw new StaleError("expired");
				const previous = await tx.get(
					`SELECT request, receipt FROM ${n.operations} WHERE work = ? AND generation = ? AND operation = ?`,
					token.id, token.generation, operation,
				);
				if (previous) return JSON.parse(previous.receipt);
				const key = JSON.stringify(["checkpoint-recorded", "tool", checkpointId]);
				const existing = await tx.get(`SELECT seq, at, payload FROM ${n.events} WHERE run_id = ? AND key = ?`, lease.runId, key);
				if (existing) return { seq: existing.seq, at: existing.at };
				if (designed) {
					// The root's run row is the only lock every writer of the root shares: taken here, held only until COMMIT.
					return tx.get(
						`WITH s AS (UPDATE ${n.runs} SET last_seq = last_seq + 1 WHERE run_id = ? RETURNING last_seq),
						      e AS (INSERT INTO ${n.events} SELECT ?, s.last_seq, ?, ?, 'checkpoint-recorded', ?, ? FROM s RETURNING seq, at)
						 INSERT INTO ${n.operations} SELECT ?, ?, ?, ?, json_build_object('seq', e.seq, 'at', e.at)::text FROM e RETURNING receipt`,
						lease.runId, lease.runId, lease.epoch, key, payload, now, token.id, token.generation, operation, operation,
					).then((r) => JSON.parse(r.receipt));
				}
				const latest = await tx.get(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${n.events} WHERE run_id = ?`, lease.runId);
				const receipt = { seq: latest.seq + 1, at: now };
				await tx.run(`INSERT INTO ${n.events} VALUES (?, ?, ?, ?, ?, ?, ?)`, lease.runId, receipt.seq, lease.epoch, key, "checkpoint-recorded", payload, now);
				await tx.run(`INSERT INTO ${n.operations} VALUES (?, ?, ?, ?, ?)`, token.id, token.generation, operation, operation, JSON.stringify(receipt));
				return receipt;
			});
		},
		async heartbeat(lease, token, durationMs) {
			return db.write(async (tx) => {
				const { now } = await authority(tx, lease);
				const row = await current(tx, lease, token);
				if (row.expires_at < now) throw new StaleError("expired");
				const expiresAt = db.dialect === "sqlite" ? `MAX(expires_at, ?)` : `GREATEST(expires_at, ?)`;
				await tx.run(`UPDATE ${n.work} SET expires_at = ${expiresAt}, renewed_at = ? WHERE id = ?`, now + durationMs, now, row.id);
				return tx.get(`SELECT state, revision FROM ${n.control} WHERE root = ?`, lease.runId);
			});
		},
		async complete(lease, token, result) {
			return db.write(async (tx) => {
				const { now } = await authority(tx, lease);
				const row = await current(tx, lease, token);
				if (row.expires_at < now) throw new StaleError("expired");
				await tx.run(`INSERT INTO ${n.results} VALUES (?, ?)`, token.id, result);
				await tx.run(`UPDATE ${n.work} SET state = 'completed' WHERE id = ?`, token.id);
			});
		},
		async reportHost(host, slots, busy) {
			const upsert = `INSERT INTO ${n.hosts}(host, slots, busy, renewed_at) VALUES (?, ?, ?, ${NOW}) ON CONFLICT(host) DO UPDATE SET slots = excluded.slots, busy = excluded.busy, renewed_at = excluded.renewed_at`;
			return db.write((tx) => tx.run(upsert, host, slots, busy));
		},
		async renewRoot(lease) {
			return db.write((tx) =>
				tx.run(`UPDATE ${n.leases} SET renewed_at = ${NOW} WHERE run_id = ? AND holder_id = ? AND epoch = ?`, lease.runId, lease.holderId, lease.epoch),
			);
		},
		async setup(lease, children, timeoutMs) {
			for (const statement of schema(db.dialect === "sqlite" ? "sqlite" : "pg", prefix)) await db.exec(statement);
			await db.write(async (tx) => {
				await tx.run(`INSERT INTO ${n.runs}(run_id, status) VALUES (?, 'running')`, lease.runId);
				await tx.run(`INSERT INTO ${n.leases} VALUES (?, ?, ?, ${NOW})`, lease.runId, lease.holderId, lease.epoch);
				await tx.run(`INSERT INTO ${n.pool} VALUES (?, ?)`, lease.runId, timeoutMs);
				for (let index = 0; index < children; index++)
					await tx.run(
						`INSERT INTO ${n.work}(id, root, boundary, descriptor, epoch, ready_at) VALUES (?, ?, ?, ?, ?, 0)`,
						`w${index}`, lease.runId, `b${index}`, JSON.stringify({ childRunId: `child-${index}`, scope: `s${index}` }), lease.epoch,
					);
			});
		},
		async progress(lease) {
			const rows = await db.all(`SELECT state, COUNT(*) AS n FROM ${n.work} WHERE root = ? GROUP BY state`, lease.runId);
			return Object.fromEntries(rows.map((row) => [row.state, Number(row.n)]));
		},
		async invariants(lease) {
			const events = await db.get(`SELECT COUNT(*) AS n, COUNT(DISTINCT key) AS keys, MAX(seq) AS max FROM ${n.events} WHERE run_id = ?`, lease.runId);
			return { events: Number(events.n), distinctKeys: Number(events.keys), maxSeq: Number(events.max) };
		},
	};
}
