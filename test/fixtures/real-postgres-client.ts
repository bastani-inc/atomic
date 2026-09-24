import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";
import {
	embeddedDbosSystemDatabaseUrl,
	ensureEmbeddedDbosPostgres,
	loadEmbeddedPostgresBinaries,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { managedPostmaster } from "../../packages/workflows/src/durable/dbos-postgres-identity.js";
import { inspectPostgresConsumers, managedPostgresMetadata } from "../../packages/workflows/src/durable/dbos-postgres-ownership.js";
import { runLocalCommand } from "../../packages/workflows/src/durable/local-command.js";
import { postmasterIdentityChanged } from "../helpers/postgres-process-identity.js";
import { readTextSync, sleep } from "../helpers/runtime.js";

const home = process.env.ATOMIC_FAULT_TEST_HOME;
assert.ok(home && resolve(homedir()) === resolve(home), "requires disposable HOME");
assert.notEqual(process.getuid?.(), 0, "root uses shared /var/lib; refuse fault injection");
const base = join(home, ".atomic", "postgres");
const data = join(base, "v18");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	const { id, command, sql } = JSON.parse(line) as { id: number; command: string; sql?: string };
	try {
		let result: object | string = {};
		if (command === "ensure") {
			await ensureEmbeddedDbosPostgres();
			result = { url: embeddedDbosSystemDatabaseUrl(), metadata: managedPostgresMetadata(base, 18, false) };
		} else if (command === "query") {
			const client = new pg.Client({
				connectionString: embeddedDbosSystemDatabaseUrl().replace("/atomic_workflows_dbos_sys?", "/postgres?"),
				connectionTimeoutMillis: 2000,
				query_timeout: 2000,
			});
			await client.connect();
			try {
				result = (await client.query(sql!)).rows;
			} finally {
				await client.end();
			}
		} else if (command === "consumers") {
			result = inspectPostgresConsumers(base, managedPostgresMetadata(base, 18, false));
		} else if (command === "binaries") {
			result = await loadEmbeddedPostgresBinaries({ readOnly: true });
		} else if (command === "stop") {
			// Only this fixture's directory is ever passed to pg_ctl, never a supplied PID/port.
			if (existsSync(join(data, "postmaster.pid"))) {
				const stoppedServer = managedPostmaster(managedPostgresMetadata(base, 18, false));
				assert.ok(stoppedServer, "stop requires the owned live postmaster identity");
				const binaries = await loadEmbeddedPostgresBinaries();
				const stopped = await runLocalCommand(binaries.pg_ctl, [
					"-D",
					data,
					"-m",
					"fast",
					"-W",
					"-t",
					"15",
					"stop",
				]);
				assert.equal(stopped.exitCode, 0, stopped.stderr);
				// pg_ctl -w watches the pidfile: an automatic replacement can recreate it
				// before its first poll. Observe removal of the captured identity instead.
				// PostgreSQL removes its pidfile at shutdown; kill(pid, 0) can still see
				// an exited but unreaped native child on Unix.
				const deadline = Date.now() + 15_000;
				for (;;) {
					if (postmasterIdentityChanged(join(data, "postmaster.pid"), stoppedServer)) break;
					if (Date.now() >= deadline) {
						throw new Error(
							`owned postmaster ${JSON.stringify(stoppedServer)} did not shut down\n${readTextSync(join(base, "v18.log"), "utf8")}`,
						);
					}
					await sleep(20);
				}
			}
		} else if (command === "exit") {
			await shutdownEmbeddedDbosPostgres();
			console.log(JSON.stringify({ id, result }));
			process.exit(0);
		} else throw new Error(`Unknown command ${command}`);
		console.log(JSON.stringify({ id, result }));
	} catch (error) {
		console.log(JSON.stringify({ id, error: String(error) }));
	}
}
