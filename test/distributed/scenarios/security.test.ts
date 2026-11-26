/**
 * The security gate: run.mjs runs this file first and alone, and runs no other suite unless it passes. It checks that
 * the database the nodes share admits only what the PostgreSQL and PgBouncer guides admit: Atomic's roles over TLS
 * with SCRAM, checked against the run's own CA, and nothing else over the network.
 */
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { describe, test } from "vitest";
import { adminSql, bouncerConsole, compose, migrate, openDatabase, scenarioPrefix } from "../harness/cluster.js";
import { distributedSkipReason, type Endpoint, requireTopology } from "../harness/topology.js";

/** What `openDatabase` threw: its cause's message, where the server's or TLS's own words are. */
async function refusal(open: () => Promise<{ close(): Promise<void> }>): Promise<string> {
	try {
		const database = await open();
		await database.close();
	} catch (error) {
		const cause = (error as { cause?: { message?: string } }).cause;
		return cause?.message ?? (error as Error).message;
	}
	assert.fail("the connection was accepted");
}

/** Asserts `operation` fails, with `pattern` in the message of the error or of one of its causes. */
async function rejectsWith(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
	try {
		await operation;
	} catch (error) {
		const messages: string[] = [];
		for (let current: unknown = error; current instanceof Error; current = current.cause)
			messages.push(current.message);
		assert.ok(
			messages.some((message) => pattern.test(message)),
			`${pattern} is not in: ${messages.join(" / ")}`,
		);
		return;
	}
	assert.fail(`the operation succeeded; it should fail with ${pattern}`);
}

describe.skipIf(distributedSkipReason !== undefined)("security gate", () => {
	const topology = requireTopologyOrSkip();
	const endpoints: readonly (readonly [string, Endpoint])[] =
		topology === undefined
			? []
			: [
					["PostgreSQL", topology.primary],
					["PgBouncer", topology.pgbouncer],
					...(topology.replica === undefined ? [] : ([["the replica", topology.replica]] as const)),
				];

	test("the runtime role reaches every server over TLS, checked against the run's CA", async () => {
		for (const [, endpoint] of endpoints) {
			const database = await openDatabase("runtime", endpoint);
			try {
				assert.deepEqual(await database.get("SELECT current_user AS role"), { role: "atomic_runtime" });
			} finally {
				await database.close();
			}
		}
		// PgBouncer's own connections to PostgreSQL use TLS too (server_tls_sslmode = verify-full).
		const encrypted = adminSql(
			"SELECT count(*) FILTER (WHERE NOT ssl) FROM pg_stat_ssl JOIN pg_stat_activity USING (pid) WHERE client_addr IS NOT NULL",
		);
		assert.equal(encrypted, "0", "every network connection to PostgreSQL is encrypted");
	});

	test("a connection without TLS is refused", async () => {
		for (const [where, endpoint] of endpoints)
			assert.match(
				await refusal(() => openDatabase("runtime", endpoint, { sslmode: "disable" })),
				/no encryption|SSL required/,
				where,
			);
	});

	test("a server certificate from another CA is refused", async () => {
		for (const [where, endpoint] of endpoints)
			assert.match(
				await refusal(() => openDatabase("runtime", endpoint, { ca: requireTopology().tls.decoyCa })),
				/TLS certificate was not accepted/,
				where,
			);
	});

	test("a wrong password is refused", async () => {
		for (const [where, endpoint] of endpoints)
			assert.match(
				await refusal(() => openDatabase("runtime", endpoint, { password: "not-the-password" })),
				/password authentication failed|SASL authentication failed/,
				where,
			);
	});

	test("the superuser cannot log in over the network, even with its password", async () => {
		for (const [where, endpoint] of endpoints)
			assert.match(
				await refusal(() => openDatabase("superuser", endpoint)),
				/pg_hba\.conf rejects connection|no such user/,
				where,
			);
	});

	test("the runtime role cannot change the schema, only the owner can", async () => {
		const prefix = scenarioPrefix("security");
		migrate(prefix);
		const runtime = await openDatabase("runtime", requireTopology().pgbouncer);
		try {
			await rejectsWith(
				runtime.exec("CREATE TABLE atomic.adt_intruder (id int)"),
				/permission denied for schema atomic/,
			);
			await rejectsWith(runtime.exec(`DROP TABLE atomic.${prefix}session_entries`), /must be owner of table/);
		} finally {
			await runtime.close();
		}
		assert.equal(
			adminSql(`SELECT tableowner FROM pg_tables WHERE tablename = '${prefix}session_entries'`),
			"atomic_owner",
		);
	});

	test("PgBouncer pools in transaction mode and keeps prepared statements", () => {
		const config = new Map(
			bouncerConsole("SHOW CONFIG")
				.split("\n")
				.map((line) => line.split("|") as [string, string]),
		);
		assert.equal(config.get("pool_mode"), "transaction");
		assert.equal(config.get("max_prepared_statements"), "200");
		assert.equal(config.get("client_tls_sslmode"), "require");
		assert.equal(config.get("server_tls_sslmode"), "verify-full");
	});

	test("only PostgreSQL and PgBouncer are published, on loopback", () => {
		const published = compose("ps", "--format", "json")
			.trim()
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				const entry = JSON.parse(line) as {
					Service: string;
					Publishers: { URL: string; TargetPort: number; PublishedPort: number }[] | null;
				};
				return (entry.Publishers ?? [])
					.filter((publisher) => publisher.PublishedPort !== 0)
					.map((publisher) => ({ service: entry.Service, url: publisher.URL, port: publisher.TargetPort }));
			});
		assert.ok(published.length > 0);
		for (const entry of published) {
			assert.equal(entry.url, "127.0.0.1", `${entry.service} is published on ${entry.url}`);
			assert.ok(entry.port === 5432 || entry.port === 6432, `${entry.service} publishes port ${entry.port}`);
		}
	});

	test("the run's passwords are files only its user can read", () => {
		for (const role of Object.values(requireTopology().roles))
			assert.equal((statSync(role.passwordFile).mode & 0o777).toString(8), "600", role.user);
	});
});

function requireTopologyOrSkip() {
	return distributedSkipReason === undefined ? requireTopology() : undefined;
}
