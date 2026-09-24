import assert from "node:assert/strict";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnRetainedPostgres } from "@bastani/atomic-natives";
import pg from "pg";
import { test } from "vitest";
import { loadEmbeddedPostgresBinaries } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { probePostgresIdentity } from "../../packages/workflows/src/durable/dbos-postgres-identity.js";
import { runLocalCommand } from "../../packages/workflows/src/durable/local-command.js";
import {
	type ManagedResult,
	postmasterRuntimeWithin,
	RealPostgresHome,
	reserveListener,
} from "../helpers/real-postgres.js";
import { readText, removeTempDirectory } from "../helpers/runtime.js";

const REAL_LEGACY_RECOVERY_TIMEOUT_MS = 120_000;

test.skipIf(process.platform === "win32")(
	"a legacy managed server recovers from a deleted runtime without losing its data",
	async () => {
		const home = new RealPostgresHome(true);
		const listener = await reserveListener();
		await listener.close();
		const base = join(home.path, ".atomic", "postgres");
		const data = join(base, "v18");
		const source = join(home.path, "disposable-worktree", "node_modules", "postgres", "native");
		const password = join(home.path, "postgres-password");
		let lease: ReturnType<typeof spawnRetainedPostgres> | undefined;
		try {
			const installed = await loadEmbeddedPostgresBinaries({ readOnly: true });
			await home.prewarmRuntime(installed);
			await cp(dirname(dirname(installed.postgres)), source, { recursive: true, verbatimSymlinks: true });
			await mkdir(base, { recursive: true });
			await writeFile(password, "atomic\n", { mode: 0o600 });
			const initialized = await runLocalCommand(join(source, "bin", "initdb"), [
				"-D",
				data,
				"-U",
				"postgres",
				"-A",
				"password",
				`--pwfile=${password}`,
				"-E",
				"UTF8",
				"--no-locale",
			]);
			assert.equal(initialized.exitCode, 0, initialized.stderr);
			lease = spawnRetainedPostgres({
				executable: join(source, "bin", "postgres"),
				args: ["-D", data, "-p", String(listener.port), "-c", "listen_addresses=127.0.0.1"],
				cwd: data,
				logFile: join(base, "v18.log"),
			});
			let originalIdentifier: string | undefined;
			for (let attempt = 0; attempt < 100; attempt++) {
				const identity = await probePostgresIdentity(listener.port);
				if (identity) {
					originalIdentifier = identity.system_identifier;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.ok(originalIdentifier, "legacy server must accept verified SQL before deleting the source");
			const connection = new pg.Client({
				host: "127.0.0.1",
				port: listener.port,
				user: "postgres",
				password: "atomic",
				database: "postgres",
			});
			await connection.connect();
			try {
				await connection.query("CREATE TABLE atomic_legacy_recovery (value text NOT NULL)");
				await connection.query("INSERT INTO atomic_legacy_recovery VALUES ('preserved')");
			} finally {
				await connection.end();
			}
			const launch = await readText(join(data, "postmaster.opts"));
			assert.ok(
				postmasterRuntimeWithin(launch, source),
				"fixture must start the old server from its disposable installation",
			);
			removeTempDirectory(join(home.path, "disposable-worktree"));
			const client = home.client(listener.port);
			const recovered = await client.request<ManagedResult>("ensure");
			assert.equal(recovered.metadata.server.systemIdentifier, originalIdentifier);
			assert.notEqual(recovered.metadata.server.pid, lease.pid);
			assert.ok(postmasterRuntimeWithin(await readText(join(data, "postmaster.opts")), home.runtimeCache));
			const rows = await client.request<{ value: string; system_identifier: string }[]>(
				"query",
				"SELECT value, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier FROM atomic_legacy_recovery",
			);
			assert.deepEqual(rows, [
				{ value: "preserved", system_identifier: recovered.metadata.server.systemIdentifier },
			]);
		} finally {
			try {
				await home.cleanup();
			} finally {
				lease?.release();
			}
		}
	},
	REAL_LEGACY_RECOVERY_TIMEOUT_MS,
);
