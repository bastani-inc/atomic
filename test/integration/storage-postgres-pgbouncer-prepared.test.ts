/**
 * Prepared statements through PgBouncer (#6599): on by default only behind a PgBouncer found to keep them (1.21 or later
 * with `max_prepared_statements` above 0), off behind any other pooler found, on whatever port. Starts PostgreSQL 16 and several PgBouncer releases in
 * Docker, so it runs only when ATOMIC_TEST_PGBOUNCER=1:
 *
 *   ATOMIC_TEST_PGBOUNCER=1 npx vitest --run test/integration/storage-postgres-pgbouncer-prepared.test.ts
 *
 * Needs Docker and the postgres:16 and edoburu/pgbouncer images (pulled on first run).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect as connectSocket, createServer } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { countRoundTrips } from "../helpers/postgres-round-trips.js";

const enabled = process.env.ATOMIC_TEST_PGBOUNCER === "1";
const DOCKER_TIMEOUT_MS = 240_000;
const SETUP_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 180_000;
const PASSWORD = "pw";

function docker(...args: string[]): string {
	return execFileSync("docker", args, {
		encoding: "utf8",
		timeout: DOCKER_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	await new Promise<void>((done) => server.close(() => done()));
	assert.ok(address !== null && typeof address === "object");
	return address.port;
}

function succeeds(run: () => unknown): boolean {
	try {
		run();
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 500));
	}
}

/** The PgBouncer releases and settings under test, and whether each keeps a client's prepared statements. */
const BOUNCERS = [
	{ key: "1.26", image: "edoburu/pgbouncer:v1.26.1-p0", maxPrepared: "200", keeps: true },
	{ key: "1.25", image: "edoburu/pgbouncer:v1.25.1-p0", maxPrepared: undefined, keeps: true },
	{ key: "1.21", image: "edoburu/pgbouncer:1.21.0-p2", maxPrepared: "100", keeps: true },
	{ key: "1.20", image: "edoburu/pgbouncer:1.20.1-p0", maxPrepared: undefined, keeps: false },
	{ key: "1.26-off", image: "edoburu/pgbouncer:v1.26.1-p0", maxPrepared: "0", keeps: false },
] as const;

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
const message = (id: string, parentId: string | null) =>
	({
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-25T00:00:01.000Z",
		message: { role: "user", content: `entry ${id}`, timestamp: 1 },
	}) as SessionEntry;

/** Counts the statements this process sends under a name of Atomic's, the probe's left out, until `restore`. */
function countNamedStatements(): { take(): number; restore(): void } {
	const query = pg.Client.prototype.query;
	let named = 0;
	pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
		const config = args[0] as { name?: unknown } | undefined;
		if (typeof config?.name === "string" && /^atomic_[0-9a-f]{32}$/.test(config.name)) named += 1;
		return Reflect.apply(query, this, args);
	} as pg.Client["query"];
	return {
		take() {
			const counted = named;
			named = 0;
			return counted;
		},
		restore() {
			pg.Client.prototype.query = query;
		},
	};
}

/** Opens a session store on `database`, appends ten entries to a new session one at a time, and loads it. */
async function appendTen(database: SqliteDatabase, sessionId: string): Promise<void> {
	const store = await SqlSessionStore.open(database);
	try {
		const created = await store.create(header(sessionId), []);
		let lastSeq = created.lastSeq;
		let parentId: string | null = null;
		for (let index = 1; index <= 10; index++) {
			const entry = message(`${sessionId}-${index}`, parentId);
			({ lastSeq } = await store.append(sessionId, [entry], { expectSeq: lastSeq, epoch: created.epoch }));
			parentId = entry.id;
		}
		assert.equal((await store.load(sessionId)).entries.length, 10);
	} finally {
		await store.close();
	}
}

describe.skipIf(!enabled)("prepared statements through PgBouncer (#6599)", () => {
	const tag = randomBytes(4).toString("hex");
	const network = `atomic-pgbp-${tag}`;
	const postgresName = `atomic-pgbp-pg-${tag}`;
	let directPort = 0;
	const ports = new Map<string, number>();
	const warnings: string[] = [];
	const onWarning = (warning: Error) => warnings.push(warning.message);

	beforeAll(async () => {
		directPort = await freePort();
		docker("network", "create", network);
		docker(
			"run",
			"-d",
			"--name",
			postgresName,
			"--network",
			network,
			"-p",
			`127.0.0.1:${directPort}:5432`,
			"-e",
			`POSTGRES_PASSWORD=${PASSWORD}`,
			"postgres:16",
		);
		await waitFor(
			() => succeeds(() => docker("exec", postgresName, "pg_isready", "-U", "postgres")),
			"PostgreSQL to accept connections",
		);
		for (const bouncer of BOUNCERS) {
			const port = await freePort();
			ports.set(bouncer.key, port);
			docker(
				"run",
				"-d",
				"--name",
				`atomic-pgbp-${bouncer.key.replace(".", "")}-${tag}`,
				"--network",
				network,
				"-p",
				`127.0.0.1:${port}:5432`,
				"-e",
				`DB_HOST=${postgresName}`,
				"-e",
				"DB_USER=postgres",
				"-e",
				`DB_PASSWORD=${PASSWORD}`,
				"-e",
				"POOL_MODE=transaction",
				"-e",
				"AUTH_TYPE=scram-sha-256",
				...(bouncer.maxPrepared === undefined ? [] : ["-e", `MAX_PREPARED_STATEMENTS=${bouncer.maxPrepared}`]),
				bouncer.image,
			);
			await waitFor(async () => {
				const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: PASSWORD });
				try {
					await client.connect();
					await client.query("SELECT 1");
					return true;
				} catch {
					return false;
				} finally {
					await client.end().catch(() => {});
				}
			}, `PgBouncer ${bouncer.key} to accept connections`);
		}
		process.on("warning", onWarning);
	}, SETUP_TIMEOUT_MS);

	afterAll(() => {
		process.off("warning", onWarning);
		if (!enabled) return;
		for (const bouncer of BOUNCERS)
			succeeds(() => docker("rm", "-f", `atomic-pgbp-${bouncer.key.replace(".", "")}-${tag}`));
		succeeds(() => docker("rm", "-f", postgresName));
		succeeds(() => docker("network", "rm", network));
	});

	/**
	 * A database of its own on the server, reached through `port` with `listenUrl` direct, as the PgBouncer guide says,
	 * or without `listenUrl` when `listen` is false.
	 */
	async function openThrough(port: number, options: { maxPreparedStatements?: number; listen?: boolean } = {}) {
		const name = `atomic_${randomBytes(6).toString("hex")}`;
		const admin = new pg.Client({ host: "127.0.0.1", port: directPort, user: "postgres", password: PASSWORD });
		await admin.connect();
		await admin.query(`CREATE DATABASE ${name}`);
		await admin.end();
		const { listen = true, ...rest } = options;
		return openPostgresDatabase({
			url: `postgresql://postgres@127.0.0.1:${port}/${name}`,
			...(listen ? { listenUrl: `postgresql://postgres@127.0.0.1:${directPort}/${name}` } : {}),
			password: PASSWORD,
			...rest,
		});
	}

	for (const bouncer of BOUNCERS)
		test(
			`through PgBouncer ${bouncer.key}, statements are ${bouncer.keeps ? "prepared once per connection by default" : "sent unnamed by default"}, and sessions work`,
			async () => {
				const named = countNamedStatements();
				try {
					warnings.length = 0;
					const database = await openThrough(ports.get(bouncer.key)!);
					try {
						await appendTen(database, "s1");
						if (bouncer.keeps) assert.ok(named.take() > 0, "no statement was prepared");
						else assert.equal(named.take(), 0);
					} finally {
						await database.close();
					}
					// No statement was refused for a name the pooler lost: no fallback warning, no retry.
					assert.deepEqual(
						warnings.filter((warning) => /prepared statement|connection-lost/.test(warning)),
						[],
					);
				} finally {
					named.restore();
				}
			},
			TEST_TIMEOUT_MS,
		);

	test(
		"finding out what the pooler is costs the open no round trip of its own",
		async () => {
			const tripsOf = async (key: string) => {
				const trips = countRoundTrips();
				try {
					const database = await openThrough(ports.get(key)!);
					const opened = trips.take();
					await database.close();
					// The admin connection that created the database counts too, the same for both.
					return opened;
				} finally {
					trips.restore();
				}
			};
			// 1.21 tells nothing at login, so its first connection carries the probe; 1.26-off names itself.
			assert.equal(await tripsOf("1.21"), await tripsOf("1.26-off"));
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"maxPreparedStatements set by hand wins either way, and processes of both settings share one PgBouncer",
		async () => {
			const named = countNamedStatements();
			try {
				const off = await openThrough(ports.get("1.26")!, { maxPreparedStatements: 0 });
				try {
					await appendTen(off, "s1");
					assert.equal(named.take(), 0);
				} finally {
					await off.close();
				}
				const on = await openThrough(ports.get("1.20")!, { maxPreparedStatements: 256 });
				const beside = await openThrough(ports.get("1.20")!);
				try {
					// Through a PgBouncer that loses them, the first lost statement turns them off and the call runs again.
					await Promise.all([appendTen(on, "s1"), appendTen(beside, "s1")]);
				} finally {
					await on.close();
					await beside.close();
				}
			} finally {
				named.restore();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"on a port that does not look like a pooler's, without listenUrl, a pooler is still found: kept behind PgBouncer 1.25, off behind 1.20 and 1.26 with 0, on for the server itself",
		async () => {
			const named = countNamedStatements();
			try {
				const cases = [
					["1.25", ports.get("1.25")!, true],
					["1.20", ports.get("1.20")!, false],
					["1.26-off", ports.get("1.26-off")!, false],
					["server", directPort, true],
				] as const;
				for (const [key, port, prepared] of cases) {
					warnings.length = 0;
					const database = await openThrough(port, { listen: false });
					try {
						await appendTen(database, "s1");
						if (prepared) assert.ok(named.take() > 0, `${key}: no statement was prepared`);
						else assert.equal(named.take(), 0, key);
					} finally {
						await database.close();
					}
					assert.deepEqual(
						warnings.filter((warning) => /prepared statement|connection-lost/.test(warning)),
						[],
						key,
					);
				}
			} finally {
				named.restore();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a pooler that names nothing and renames nothing, here a plain relay to the server, leaves them off",
		async () => {
			const relay = createServer((socket) => {
				const upstream = connectSocket(directPort, "127.0.0.1");
				socket.pipe(upstream).pipe(socket);
				socket.on("error", () => upstream.destroy());
				upstream.on("error", () => socket.destroy());
			});
			await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
			const address = relay.address();
			assert.ok(address !== null && typeof address === "object");
			const named = countNamedStatements();
			try {
				const database = await openThrough(address.port);
				try {
					await appendTen(database, "s1");
					assert.equal(named.take(), 0);
				} finally {
					await database.close();
				}
			} finally {
				named.restore();
				await new Promise<void>((done) => relay.close(() => done()));
			}
		},
		TEST_TIMEOUT_MS,
	);
});
