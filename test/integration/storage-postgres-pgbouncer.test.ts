/**
 * Atomic behind PgBouncer in transaction mode, configured exactly as the PgBouncer guide's pgbouncer.ini says, with TLS
 * on both hops and SCRAM through auth_query. Starts PostgreSQL 16 and PgBouncer in Docker, so it runs only when
 * ATOMIC_TEST_PGBOUNCER=1:
 *
 *   ATOMIC_TEST_PGBOUNCER=1 npx vitest --run test/integration/storage-postgres-pgbouncer.test.ts
 *
 * Needs Docker, the postgres:16 and edoburu/pgbouncer images (pulled on first run) and openssl.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { openAdapterSelectionDatabase } from "../../packages/coding-agent/src/core/storage/adapter-open.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { selectStorage } from "../../packages/coding-agent/src/core/storage/selection.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import postgresAdapter from "../../packages/storage-postgres/postgres.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

const enabled = process.env.ATOMIC_TEST_PGBOUNCER === "1";
const DOCKER_TIMEOUT_MS = 240_000;
const SETUP_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 180_000;

const guide = readFileSync(
	resolve(moduleDir(import.meta.url), "../../packages/coding-agent/docs/guides/postgres-pgbouncer.md"),
	"utf8",
);

/** The fenced blocks of `language` in the guide, in order. */
function blocks(language: string): string[] {
	return [...guide.matchAll(new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, "g"))].map((match) => match[1]!);
}

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

async function waitFor(check: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 500));
	}
}

function succeeds(run: () => unknown): boolean {
	try {
		run();
		return true;
	} catch {
		return false;
	}
}

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
const message = (id: string, text: string, parentId: string | null) =>
	({
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-25T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	}) as SessionEntry;

describe.skipIf(!enabled)("Atomic through PgBouncer in transaction mode, as the PgBouncer guide sets it up", () => {
	const tag = randomBytes(4).toString("hex");
	const network = `atomic-pgb-${tag}`;
	const postgresName = `atomic-pgb-pg-${tag}`;
	const bouncerName = `atomic-pgb-bouncer-${tag}`;
	const runtimePassword = `runtime-${randomBytes(8).toString("hex")}`;
	const authPassword = `auth-${randomBytes(8).toString("hex")}`;
	let dir = "";
	let directPort = 0;
	let bouncerPort = 0;

	beforeAll(async () => {
		dir = makeTempDirectory("atomic-pgbouncer-");
		const tls = join(dir, "tls");
		mkdirSync(tls);
		const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: tls, stdio: "ignore" });
		openssl(
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"2",
			"-subj",
			"/CN=atomic-test-ca",
			"-keyout",
			"root.key",
			"-out",
			"root.crt",
		);
		for (const [name, names] of [
			["server", `DNS:${postgresName},DNS:localhost,IP:127.0.0.1`],
			["pgbouncer", "DNS:localhost,IP:127.0.0.1"],
		] as const) {
			openssl(
				"req",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-subj",
				`/CN=${name}`,
				"-keyout",
				`${name}.key`,
				"-out",
				`${name}.csr`,
			);
			writeFileSync(join(tls, `${name}.ext`), `subjectAltName=${names}\n`);
			openssl(
				"x509",
				"-req",
				"-in",
				`${name}.csr`,
				"-CA",
				"root.crt",
				"-CAkey",
				"root.key",
				"-CAcreateserial",
				"-days",
				"2",
				"-extfile",
				`${name}.ext`,
				"-out",
				`${name}.crt`,
			);
		}
		execFileSync("chmod", [
			"644",
			...["root.crt", "server.crt", "server.key", "pgbouncer.crt", "pgbouncer.key"].map((file) => join(tls, file)),
		]);

		directPort = await freePort();
		bouncerPort = await freePort();
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
			"POSTGRES_PASSWORD=pw",
			"postgres:16",
			"-c",
			"max_connections=60",
		);
		const psql = (sql: string, database = "postgres") =>
			docker("exec", postgresName, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-Atc", sql);
		await waitFor(() => succeeds(() => psql("SELECT 1")), "PostgreSQL to accept connections");
		// The server's certificate, owned by postgres as the server requires, then TLS on.
		for (const file of ["server.crt", "server.key", "root.crt"])
			docker("cp", join(tls, file), `${postgresName}:/var/lib/postgresql/${file}`);
		docker(
			"exec",
			postgresName,
			"sh",
			"-c",
			"cd /var/lib/postgresql && chown postgres:postgres server.crt server.key root.crt && chmod 600 server.key",
		);
		psql("ALTER SYSTEM SET ssl = on");
		psql("ALTER SYSTEM SET ssl_cert_file = '/var/lib/postgresql/server.crt'");
		psql("ALTER SYSTEM SET ssl_key_file = '/var/lib/postgresql/server.key'");
		psql("SELECT pg_reload_conf()");
		psql(`CREATE ROLE atomic_runtime LOGIN PASSWORD '${runtimePassword}'`);
		psql("CREATE DATABASE atomic OWNER atomic_runtime");
		// The guide's lookup role and function, as written, with only the password filled in.
		const authSql = blocks("sql").find((sql) => sql.includes("pgbouncer.get_auth"));
		assert.ok(authSql !== undefined);
		psql(authSql.replace("<auth role password>", authPassword), "atomic");

		// The guide's pgbouncer.ini, with only the host and file locations of this test.
		const ini = blocks("ini")[0];
		assert.ok(ini !== undefined);
		const config = join(dir, "pgbouncer");
		mkdirSync(config);
		writeFileSync(
			join(config, "pgbouncer.ini"),
			ini
				.replace("host=db.internal", `host=${postgresName}`)
				.replaceAll("/etc/pgbouncer/tls/", "/etc/pgbouncer-tls/"),
		);
		const userlist = blocks("text").find((text) => text.includes('"pgbouncer_auth"'));
		assert.ok(userlist !== undefined);
		writeFileSync(join(config, "userlist.txt"), userlist.replace("<auth role password>", authPassword));
		execFileSync("chmod", ["-R", "a+rX", config]);
		docker(
			"run",
			"-d",
			"--name",
			bouncerName,
			"--network",
			network,
			"-p",
			`127.0.0.1:${bouncerPort}:6432`,
			"-v",
			`${config}:/etc/pgbouncer:ro`,
			"-v",
			`${tls}:/etc/pgbouncer-tls:ro`,
			"--entrypoint",
			"pgbouncer",
			"edoburu/pgbouncer:latest",
			"/etc/pgbouncer/pgbouncer.ini",
		);
		await waitFor(
			() =>
				succeeds(() =>
					docker(
						"exec",
						"-e",
						`PGPASSWORD=${authPassword}`,
						bouncerName,
						"psql",
						"-h",
						"127.0.0.1",
						"-p",
						"6432",
						"-U",
						"pgbouncer_auth",
						"pgbouncer",
						"-Atc",
						"SHOW VERSION",
					),
				),
			"PgBouncer to accept connections",
		);
	}, SETUP_TIMEOUT_MS);

	afterAll(() => {
		if (!enabled) return;
		for (const name of [bouncerName, postgresName]) succeeds(() => docker("rm", "-f", name));
		succeeds(() => docker("network", "rm", network));
		if (dir !== "") removeTempDirectory(dir);
	});

	/** The guide's settings.json `storage` block, pointed at this test's PgBouncer and PostgreSQL. */
	async function openFromGuideSettings(agentDir: string): Promise<SqliteDatabase> {
		const settings = blocks("json").map((text) => JSON.parse(text) as { storage: Record<string, unknown> });
		const storage = settings.find(
			(entry) => (entry.storage.options as { listenUrl?: string }).listenUrl !== undefined,
		)?.storage;
		assert.ok(storage !== undefined);
		const options = storage.options as Record<string, unknown>;
		const tlsQuery = `sslmode=verify-full&sslrootcert=${encodeURIComponent(join(dir, "tls", "root.crt"))}`;
		const secret = (storage.secrets as { password: { file: string } }).password.file;
		mkdirSync(join(agentDir, "agent"), { recursive: true });
		writeFileSync(join(agentDir, secret), runtimePassword);
		const selection = selectStorage(
			{
				...storage,
				options: {
					...options,
					url:
						String(options.url)
							.replace("pgbouncer.internal:6432", `localhost:${bouncerPort}`)
							.replace(/\?.*$/, "") + `?${tlsQuery}`,
					listenUrl:
						String(options.listenUrl)
							.replace("db.internal:5432", `localhost:${directPort}`)
							.replace(/\?.*$/, "") + `?${tlsQuery}`,
				},
			} as never,
			"settings",
			"storage",
			join(agentDir, "storage.sqlite"),
		);
		return openAdapterSelectionDatabase(selection as never, { agentDir, domain: "sessions" }, postgresAdapter);
	}

	test(
		"a session append and load, and an Intercom wake-up, work through PgBouncer with listenUrl direct",
		async () => {
			const agentDir = makeTempDirectory("atomic-pgbouncer-agent-");
			const database = await openFromGuideSettings(agentDir);
			try {
				const store = await SqlSessionStore.open(database);
				try {
					const created = await store.create(header("s1"), []);
					const first = message("m1", "first", null);
					const appended = await store.append("s1", [first], { expectSeq: created.lastSeq, epoch: created.epoch });
					await store.append("s1", [message("m2", "second", first.id)], {
						expectSeq: appended.lastSeq,
						epoch: created.epoch,
					});
					assert.deepEqual(
						(await store.load("s1")).entries.map((entry) => entry.id),
						["m1", "m2"],
					);
				} finally {
					await store.close();
				}

				const notifications = database.notifications;
				assert.ok(notifications !== undefined);
				const received = Promise.withResolvers<string>();
				const subscription = notifications.listen("atomic_pgbouncer_test", (event) => {
					if (event.kind === "notification") received.resolve(event.payload);
				});
				try {
					assert.deepEqual(await notifications.state(), { status: "listening" });
					const notify = notifications.notify("atomic_pgbouncer_test", "wake");
					await database.transaction(async (tx) => {
						await tx.run(notify.sql, ...notify.params);
					});
					assert.equal(await received.promise, "wake");
				} finally {
					subscription.close();
				}

				const pools = docker(
					"exec",
					"-e",
					`PGPASSWORD=${authPassword}`,
					bouncerName,
					"psql",
					"-h",
					"127.0.0.1",
					"-p",
					"6432",
					"-U",
					"pgbouncer_auth",
					"pgbouncer",
					"-Atc",
					"SHOW POOLS",
				);
				assert.match(pools, /^atomic\|atomic_runtime\|/m, `SHOW POOLS lists Atomic's pool:\n${pools}`);
			} finally {
				await database.close();
				removeTempDirectory(agentDir);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"without listenUrl, Atomic sees the pooler and stops waiting for wake-ups",
		async () => {
			const agentDir = makeTempDirectory("atomic-pgbouncer-agent-");
			const tlsQuery = `sslmode=verify-full&sslrootcert=${encodeURIComponent(join(dir, "tls", "root.crt"))}`;
			const database = await postgresAdapter.openDatabase(
				{ url: `postgresql://atomic_runtime@localhost:${bouncerPort}/atomic?${tlsQuery}` },
				{ agentDir, domain: "sessions", secret: async () => runtimePassword },
			);
			try {
				assert.deepEqual(await database.notifications?.state(), { status: "unavailable", reason: "pooler" });
			} finally {
				await database.close();
				removeTempDirectory(agentDir);
			}
		},
		TEST_TIMEOUT_MS,
	);
});
