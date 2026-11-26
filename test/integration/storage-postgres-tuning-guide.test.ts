/**
 * The PostgreSQL tuning guide's SQL, run against a database `atomic storage migrate` set up, so every table and index the
 * guide names exists.
 *
 * - With ATOMIC_TEST_POSTGRES_URL: every statement that needs no server-start setting.
 * - With ATOMIC_TEST_POSTGRES_DOCKER=1 as well: PostgreSQL 17 in Docker, started with the guide's
 *   `shared_preload_libraries` line, runs every statement, the `pg_stat_statements` ones included, and a stopped server
 *   answers the guide's `postgres -C shared_memory_size_in_huge_pages`.
 *
 *   ATOMIC_TEST_POSTGRES_DOCKER=1 npx vitest --run test/integration/storage-postgres-tuning-guide.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

const DOCKER_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 300_000;

const guide = readFileSync(
	resolve(moduleDir(import.meta.url), "../../packages/coding-agent/docs/storage/postgres/tuning.md"),
	"utf8",
);

function blocks(language: string): string[] {
	return [...guide.matchAll(new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, "g"))].map((match) => match[1]!);
}

/**
 * Every SQL statement in the guide, comments removed, with `atomic` as the database name replaced by `name`, and the
 * guide's role names by `roles`' names, so a shared server keeps no role of the guide's.
 */
function statements(name: string, roles: Readonly<Record<string, string>> = {}): string[] {
	return blocks("sql")
		.flatMap((block) => block.split(/;\s*(?:\n|$)/))
		.map((statement) => statement.replace(/--.*$/gm, "").trim())
		.filter((statement) => statement !== "")
		.map((statement) =>
			Object.entries(roles).reduce(
				(text, [from, to]) => text.replaceAll(from, to),
				statement.replaceAll("datname = 'atomic'", `datname = '${name}'`),
			),
		);
}

const needsPreload = (statement: string) => /pg_stat_statements/.test(statement);

/** Sets `url` up as `atomic storage migrate` does, as the server's administrator. */
async function migrate(url: string, password: string): Promise<void> {
	const root = makeTempDirectory("storage-tuning-guide-");
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [resolve(moduleDir(import.meta.url), "../../packages/storage-postgres")] }),
		);
		writeFileSync(join(root, "password"), password, { mode: 0o600 });
		const lines: string[] = [];
		const code = await runStorageCommand(["migrate", "--db", url, "--password-file", join(root, "password")], {
			cwd: root,
			agentDir,
			log: (line) => lines.push(line),
			error: (line) => lines.push(line),
			loadBrokerState: () => import("../../packages/intercom/broker/open-broker-state.js"),
		});
		assert.equal(code, 0, lines.join("\n"));
	} finally {
		removeTempDirectory(root);
	}
}

/** The roles the guide's statements name, under the names `roles` gives them. */
async function createRoles(database: SqliteDatabase, roles: Readonly<Record<string, string>>): Promise<void> {
	for (const role of Object.values(roles))
		await database.exec(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
}

const GUIDE_ROLES = { atomic_runtime: "atomic_runtime", atomic_owner: "atomic_owner" } as const;

async function runAll(database: SqliteDatabase, list: readonly string[]): Promise<void> {
	const version = Number((await database.get<{ v: string }>("SELECT current_setting('server_version_num') AS v"))?.v);
	for (const statement of list) {
		// The guide says huge_pages_status needs PostgreSQL 17.
		if (statement === "SHOW huge_pages_status" && version < 170000) continue;
		try {
			await database.all(statement);
		} catch (error) {
			throw new Error(`The guide's statement failed:\n${statement}\n${(error as Error).message}`, { cause: error });
		}
	}
}

describe.skipIf(postgresSkipReason !== undefined)("the PostgreSQL tuning guide's SQL", () => {
	test(
		"every statement that needs no preloaded library runs on a migrated database",
		async () => {
			await withPostgresDatabase(async ({ url, name, open }) => {
				await migrate(url, process.env.ATOMIC_TEST_POSTGRES_PASSWORD ?? "");
				const database = await open();
				const tag = randomBytes(4).toString("hex");
				const roles = { atomic_runtime: `tuning_runtime_${tag}`, atomic_owner: `tuning_owner_${tag}` };
				await createRoles(database, roles);
				try {
					const list = statements(name, roles).filter((statement) => !needsPreload(statement));
					assert.ok(list.length >= 12, String(list.length));
					await runAll(database, list);
				} finally {
					for (const role of Object.values(roles)) await database.exec(`DROP ROLE IF EXISTS ${role}`);
				}
				const tuned = await database.all<{ relname: string; reloptions: string }>(
					`SELECT c.relname, array_to_string(c.reloptions, ',') AS reloptions FROM pg_class c
					JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'atomic'
					AND c.relname IN ('session_sessions', 'intercom_leases', 'snapshot_session_links', 'session_search_trgm', 'session_search_entries')
					ORDER BY 1`,
				);
				const options = Object.fromEntries(tuned.map((row) => [row.relname, row.reloptions]));
				assert.match(
					options.session_sessions ?? "",
					/fillfactor=80/,
					"migrate set the fillfactor the guide describes",
				);
				assert.match(options.intercom_leases ?? "", /fillfactor=80/);
				assert.match(options.snapshot_session_links ?? "", /autovacuum_vacuum_threshold=1000/);
				assert.match(
					options.session_search_trgm ?? "",
					/gin_pending_list_limit=65536/,
					"migrate set the search index's limit",
				);
				assert.match(options.session_search_entries ?? "", /autovacuum_vacuum_insert_threshold=1000/);
			});
		},
		TEST_TIMEOUT_MS,
	);
});

const dockerEnabled = process.env.ATOMIC_TEST_POSTGRES_DOCKER === "1";

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

describe.skipIf(!dockerEnabled)("the PostgreSQL tuning guide on a server started with its settings", () => {
	test(
		"with pg_stat_statements preloaded as the guide says, every statement runs",
		async () => {
			const preload = blocks("ini").find((text) => text.includes("shared_preload_libraries"));
			assert.ok(preload !== undefined);
			const libraries = /shared_preload_libraries = '([^']+)'/.exec(preload)?.[1];
			assert.equal(libraries, "pg_stat_statements");
			const name = `atomic-tuning-${randomBytes(4).toString("hex")}`;
			const port = await freePort();
			docker(
				"run",
				"-d",
				"--name",
				name,
				"-p",
				`127.0.0.1:${port}:5432`,
				"-e",
				"POSTGRES_PASSWORD=pw",
				"-e",
				"POSTGRES_DB=atomic",
				"postgres:17",
				"-c",
				`shared_preload_libraries=${libraries}`,
			);
			try {
				const url = `postgresql://postgres@127.0.0.1:${port}/atomic`;
				const deadline = Date.now() + 60_000;
				for (;;) {
					try {
						const probe = await openPostgresDatabase({ url, password: "pw" });
						await probe.close();
						break;
					} catch (error) {
						if (Date.now() > deadline) throw error;
						await new Promise((done) => setTimeout(done, 1000));
					}
				}
				await migrate(url, "pw");
				const database = await openPostgresDatabase({ url, password: "pw" });
				try {
					await createRoles(database, GUIDE_ROLES);
					await runAll(database, statements("atomic"));
					const top = await database.all("SELECT calls FROM pg_stat_statements LIMIT 1");
					assert.ok(top.length > 0, "pg_stat_statements recorded the statements");
				} finally {
					await database.close();
				}
			} finally {
				docker("rm", "-f", name);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a stopped server answers the guide's shared_memory_size_in_huge_pages",
		() => {
			const command = blocks("bash").find((text) => text.includes("shared_memory_size_in_huge_pages"));
			assert.ok(command !== undefined);
			assert.match(command, /postgres -D \S+ -C shared_memory_size_in_huge_pages/);
			const pages = docker(
				"run",
				"--rm",
				"-u",
				"postgres",
				"postgres:16",
				"bash",
				"-c",
				"initdb -D /tmp/data >/dev/null 2>&1 && postgres -D /tmp/data -c shared_buffers=1GB -C shared_memory_size_in_huge_pages",
			).trim();
			assert.match(pages, /^\d+$/);
			assert.ok(Number(pages) > 512, `1 GB of shared buffers needs more than 512 huge pages, got ${pages}`);
		},
		TEST_TIMEOUT_MS,
	);
});
