#!/usr/bin/env node
// Executable release gate: only the supplied package's runtime may back this cluster.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import pg from "pg";
import { runSmokeCommand, startOnAvailablePort } from "./smoke-postgres-process.mjs";
import { validatePostgresRuntime } from "./stage-postgres-runtime.mjs";

const [packagePath, target] = process.argv.slice(2);
if (!packagePath || !target) throw new Error("usage: smoke-postgres-runtime.mjs <native-package-root> <target>");
const packageRoot = realpathSync(resolve(packagePath));
const runtime = join(packageRoot, "postgres-runtime");
validatePostgresRuntime(runtime, target);
const work = mkdtempSync(join(tmpdir(), "atomic-pg-durability-"));
const repository = fileURLToPath(new URL("..", import.meta.url));
let started = false;
let binaries;
const data = join(work, "data");
const env = { ...process.env, HOME: work, USERPROFILE: work };
delete env.DBOS_SYSTEM_DATABASE_URL;
delete env.ATOMIC_POSTGRES_RUNTIME_DIR;
function command(path, args) {
	return runSmokeCommand(path, args, { cwd: work, env });
}
function stop(allowStopped = false) {
	try {
		command(binaries.pg_ctl, ["-D", data, "-m", "fast", "-w", "-t", "20", "stop"]);
	} catch (error) {
		if (!allowStopped) throw error;
		try {
			command(binaries.pg_ctl, ["-D", data, "status"]);
		} catch (statusError) {
			// pg_ctl status 3 confirms this initialized, privately owned cluster is down.
			if (!statusError.code && statusError.status === 3) {
				started = false;
				return;
			}
		}
		throw error;
	}
	started = false;
}
try {
	const modulePath = join(work, "resolver.mjs");
	await build({
		stdin: {
			contents: `export { loadEmbeddedPostgresBinaries, hydrateBinaryLibraryLinks } from ${JSON.stringify(join(repository, "packages/workflows/src/durable/dbos-embedded-postgres.ts"))};`,
			resolveDir: repository,
		},
		bundle: true,
		platform: "node",
		format: "esm",
		outfile: modulePath,
		alias: { "@bastani/atomic": join(repository, "packages/coding-agent/src/utils/child-process.ts") },
		banner: {
			js: 'import { createRequire as createSmokeRequire } from "node:module"; const require = createSmokeRequire(import.meta.url);',
		},
		external: ["@bastani/atomic-natives"],
	});
	const api = await import(pathToFileURL(modulePath).href);
	// Point the public resolver at the install, not at this repository or build.
	binaries = await api.loadEmbeddedPostgresBinaries({ moduleUrl: pathToFileURL(join(packageRoot, "probe.mjs")).href });
	for (const binary of Object.values(binaries)) {
		const inside = relative(runtime, realpathSync(binary));
		assert.ok(
			inside && !inside.startsWith(`..${sep}`) && inside !== "..",
			`binary escaped supplied payload: ${binary}`,
		);
	}
	console.log(`Resolved shipped runtime: ${binaries.postgres}`);
	api.hydrateBinaryLibraryLinks(binaries.pg_ctl);
	assert.match(command(binaries.postgres, ["--version"]), /PostgreSQL\) 18\./u);
	command(binaries.initdb, ["-D", data, "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
	assert.equal(readFileSync(join(data, "PG_VERSION"), "utf8").trim(), "18");
	let port;
	let starts = 0;
	const start = (candidate) => {
		// A fresh log prevents a previous collision from masking a later real failure.
		const log = join(work, `postgres-${++starts}.log`);
		// Set ownership intent before start so a partially successful command is cleaned up.
		started = true;
		try {
			command(binaries.pg_ctl, [
				"-D",
				data,
				"-l",
				log,
				"-o",
				`-h 127.0.0.1 -p ${candidate}`,
				"-w",
				"-t",
				"20",
				"start",
			]);
		} catch (error) {
			error.postgresLog = existsSync(log) ? readFileSync(log, "utf8") : "";
			error.message += `\n${error.postgresLog}`;
			throw error;
		}
	};
	const query = async (sql) => {
		const client = new pg.Client({
			host: "127.0.0.1",
			port,
			user: "postgres",
			database: "postgres",
			connectionTimeoutMillis: 10_000,
		});
		try {
			await client.connect();
			return await client.query(sql);
		} finally {
			await client.end();
		}
	};
	port = await startOnAvailablePort(start, () => stop(true));
	await query(
		"CREATE TABLE atomic_durability_probe (value text); INSERT INTO atomic_durability_probe VALUES ('persisted across restart')",
	);
	stop();
	port = await startOnAvailablePort(start, () => stop(true));
	assert.deepEqual((await query("SELECT value FROM atomic_durability_probe")).rows, [
		{ value: "persisted across restart" },
	]);
	stop();
	console.log("PostgreSQL 18 initdb/start/SQL insert/owned stop/restart/persisted row/final owned stop succeeded");
} finally {
	if (started && binaries) {
		try {
			stop(true);
		} catch (error) {
			console.error(`Owned cluster cleanup failed; retained at ${work}: ${error.message}`);
		}
	}
	if (!started) rmSync(work, { recursive: true, force: true });
}
