#!/usr/bin/env node
// What the per-transaction checks cost the shared store, each on its own (#5230):
//   node research/evidence/elastic-workers/txn-overhead.mjs --store pg|sqld [--n 20000] [--clients 8] [--rounds 3]
// PostgreSQL 16: a one-row read in a transaction, as the pool's journal sends it, with and without the
// `SET LOCAL lock_timeout/statement_timeout` its BEGIN carries and the schema-version read before its first statement.
// sqld: a one-row read on a kept stream, with and without the `SELECT 1 FROM sqlite_schema LIMIT 0` the libSQL adapter
// sends first in the same request (#5151). Each variant runs `--n` times over `--clients` connections against a store
// in Docker, and reports the store container's CPU microseconds per operation, the median of `--rounds` rounds.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const store = args.store ?? "pg";
const n = Number(args.n ?? 20_000);
const clients = Number(args.clients ?? 8);
const rounds = Number(args.rounds ?? 3);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const port = await freePort();
const name = `txn-overhead-${store}-${port}`;
spawnSync("docker", ["rm", "-f", name]);
if (store === "pg")
	spawnSync("docker", [
		"run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:5432`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
		"postgres:16", "-c", "max_connections=200",
	]);
else
	spawnSync("docker", [
		"run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:8080`, "ghcr.io/tursodatabase/libsql-server:v0.24.33",
	]);
const cpuUs = () =>
	Number(/usage_usec (\d+)/.exec(spawnSync("docker", ["exec", name, "cat", "/sys/fs/cgroup/cpu.stat"]).stdout.toString())?.[1] ?? 0);

/** Runs `operation` `n` times split over the connections, and returns the store's CPU microseconds per operation. */
async function measure(connections, operation) {
	const before = cpuUs();
	const started = performance.now();
	let next = 0;
	await Promise.all(
		connections.map(async (connection) => {
			while (next < n) {
				next++;
				await operation(connection, next);
			}
		}),
	);
	const wallMs = performance.now() - started;
	// cgroup accounting lags the last requests slightly.
	await sleep(200);
	return { cpuUsPerOp: (cpuUs() - before) / n, opsPerSec: Math.round(n / (wallMs / 1000)) };
}

const results = {};
try {
	if (store === "pg") {
		const { default: pg } = await import("pg");
		const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
		for (let tries = 0; ; tries++) {
			const probe = new pg.Client({ connectionString: url });
			try {
				await probe.connect();
				await probe.query("CREATE TABLE IF NOT EXISTS t(k INT PRIMARY KEY, v INT)");
				await probe.query("CREATE TABLE IF NOT EXISTS meta(schema_version INT NOT NULL)");
				await probe.query("INSERT INTO t SELECT g, g FROM generate_series(1, 1000) g ON CONFLICT DO NOTHING");
				await probe.query("INSERT INTO meta SELECT 7 WHERE NOT EXISTS (SELECT 1 FROM meta)");
				await probe.end();
				break;
			} catch (error) {
				await probe.end().catch(() => {});
				if (tries > 120) throw error;
				await sleep(500);
			}
		}
		const connections = await Promise.all(
			Array.from({ length: clients }, async () => {
				const client = new pg.Client({ connectionString: url });
				await client.connect();
				return client;
			}),
		);
		// As the adapter sends them: BEGIN and its SET LOCALs in one simple query, each statement on its own.
		const variants = {
			"read only": async (c, i) => {
				await c.query("BEGIN");
				await c.query({ text: "SELECT v FROM t WHERE k = $1", values: [(i % 1000) + 1] });
				await c.query("COMMIT");
			},
			"+ SET LOCAL": async (c, i) => {
				await c.query("BEGIN; SET LOCAL lock_timeout = 5000; SET LOCAL statement_timeout = 30000");
				await c.query({ text: "SELECT v FROM t WHERE k = $1", values: [(i % 1000) + 1] });
				await c.query("COMMIT");
			},
			"+ version check": async (c, i) => {
				await c.query("BEGIN");
				await c.query({ text: "SELECT schema_version FROM meta" });
				await c.query({ text: "SELECT v FROM t WHERE k = $1", values: [(i % 1000) + 1] });
				await c.query("COMMIT");
			},
			"+ both (today)": async (c, i) => {
				await c.query("BEGIN; SET LOCAL lock_timeout = 5000; SET LOCAL statement_timeout = 30000");
				await c.query({ text: "SELECT schema_version FROM meta" });
				await c.query({ text: "SELECT v FROM t WHERE k = $1", values: [(i % 1000) + 1] });
				await c.query("COMMIT");
			},
		};
		for (const [variant, operation] of Object.entries(variants)) {
			const samples = [];
			for (let round = 0; round < rounds; round++) samples.push(await measure(connections, operation));
			samples.sort((a, b) => a.cpuUsPerOp - b.cpuUsPerOp);
			results[variant] = samples[Math.floor(samples.length / 2)];
		}
		await Promise.all(connections.map((connection) => connection.end()));
	} else {
		const hrana = await import("@libsql/hrana-client");
		const url = `http://127.0.0.1:${port}`;
		for (let tries = 0; !(await fetch(`${url}/health`).then((r) => r.ok, () => false)); tries++) {
			if (tries > 120) throw new Error("sqld did not start");
			await sleep(500);
		}
		const setup = hrana.openHttp(url).openStream();
		await setup.run("CREATE TABLE IF NOT EXISTS t(k INTEGER PRIMARY KEY, v INTEGER)");
		await setup.run("INSERT OR IGNORE INTO t SELECT value, value FROM generate_series(1, 1000)");
		setup.close();
		const connections = Array.from({ length: clients }, () => {
			const client = hrana.openHttp(url);
			return { client, stream: client.openStream() };
		});
		const read = (i) => {
			const statement = new hrana.Stmt("SELECT v FROM t WHERE k = ?");
			statement.bindIndexes([(i % 1000) + 1]);
			return statement;
		};
		const variants = {
			"read only": async ({ stream }, i) => {
				await stream.query(read(i));
			},
			// As the adapter sends it: the check first, in the same request (one pipeline), on a kept stream.
			"+ schema check (today)": async ({ stream }, i) => {
				const checked = stream.query(new hrana.Stmt("SELECT 1 FROM sqlite_schema LIMIT 0"));
				checked.catch(() => {});
				await stream.query(read(i));
			},
		};
		for (const [variant, operation] of Object.entries(variants)) {
			const samples = [];
			for (let round = 0; round < rounds; round++) samples.push(await measure(connections, operation));
			samples.sort((a, b) => a.cpuUsPerOp - b.cpuUsPerOp);
			results[variant] = samples[Math.floor(samples.length / 2)];
		}
		for (const { client } of connections) client.close();
	}
} finally {
	spawnSync("docker", ["rm", "-f", name]);
}
const base = results["read only"].cpuUsPerOp;
for (const [variant, { cpuUsPerOp, opsPerSec }] of Object.entries(results))
	process.stdout.write(
		`${store}\t${variant.padEnd(24)}\t${cpuUsPerOp.toFixed(1)} µs CPU/op\t+${(cpuUsPerOp - base).toFixed(1)} µs\t${opsPerSec} ops/s\n`,
	);
process.stdout.write(`${JSON.stringify({ store, n, clients, rounds, results })}\n`);
