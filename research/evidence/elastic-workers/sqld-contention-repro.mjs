#!/usr/bin/env node
// Atomic-free reproduction (#4768): C concurrent libSQL clients, each looping interactive write transactions of S
// statements (one HTTP request each, as SqlPoolQueue.commit issues them) against one sqld, for D seconds. Reports commits
// per second, transaction latency, how many transactions sqld ended, and whether sqld still accepts a write afterwards.
// Then the same load as one-request batches (`client.batch(..., "write")`), which hold the write lock for one request.
//   node research/evidence/elastic-workers/sqld-contention-repro.mjs --clients 8,32,64 --statements 8 --seconds 30
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const sqld = args.sqld ?? join(homedir(), ".cache/atomic-distributed-test/sqld/v0.24.33/sqld");
const statements = Number(args.statements ?? 8);
const seconds = Number(args.seconds ?? 30);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (values, p) => (values.length === 0 ? null : Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]));

async function withTimeout(promise, ms) {
	return Promise.race([promise.then(() => "ok", (error) => `error: ${error?.code ?? error?.message}`), sleep(ms).then(() => "timed-out")]);
}

async function trial(clients, mode, port) {
	const url = `http://127.0.0.1:${port}`;
	const setup = createClient({ url });
	await setup.execute("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, client INTEGER, v TEXT)");
	setup.close();
	const latencies = [];
	const errors = {};
	let commits = 0;
	const stopAt = Date.now() + seconds * 1000;
	await Promise.all(
		Array.from({ length: clients }, async (_, client) => {
			const db = createClient({ url });
			while (Date.now() < stopAt) {
				const began = performance.now();
				try {
					if (mode === "interactive") {
						const tx = await db.transaction("write");
						for (let s = 0; s < statements - 1; s++) await tx.execute({ sql: "SELECT COUNT(*) FROM t WHERE client = ?", args: [client] });
						await tx.execute({ sql: "INSERT INTO t(client, v) VALUES (?, ?)", args: [client, "x".repeat(256)] });
						await tx.commit();
					} else {
						await db.batch(
							[
								...Array.from({ length: statements - 1 }, () => ({ sql: "SELECT COUNT(*) FROM t WHERE client = ?", args: [client] })),
								{ sql: "INSERT INTO t(client, v) VALUES (?, ?)", args: [client, "x".repeat(256)] },
							],
							"write",
						);
					}
					commits++;
					latencies.push(performance.now() - began);
				} catch (error) {
					const code = error?.code ?? error?.cause?.code ?? error?.name;
					errors[code] = (errors[code] ?? 0) + 1;
					await sleep(10);
				}
			}
			db.close();
		}).map((running) => withTimeout(running, (seconds + 60) * 1000)),
	);
	const probe = createClient({ url });
	const writeProbe = await withTimeout(probe.execute("INSERT INTO t(client, v) VALUES (-1, 'probe')"), 15_000);
	probe.close();
	return { clients, mode, statements, seconds, commitsPerSec: Math.round((commits / seconds) * 10) / 10, latencyMs: { p50: pct(latencies, 50), p99: pct(latencies, 99), max: pct(latencies, 100) }, errors, writeProbe };
}

if (args.url) {
	// One load process of a multi-process run against a server another process started.
	const result = await trial(Number(args.clients ?? 1), args.modes ?? "interactive", Number(new URL(args.url).port));
	process.stdout.write(`${JSON.stringify(result)}\n`);
	process.exit(0);
}
const results = [];
for (const mode of (args.modes ?? "interactive,batch").split(",")) {
	for (const clients of (args.clients ?? "8,32,64").split(",").map(Number)) {
		const dir = mkdtempSync(join(tmpdir(), "sqld-repro-"));
		const port = 40000 + Math.floor(Math.random() * 10000);
		const server = spawn(sqld, ["--db-path", join(dir, "db"), "--http-listen-addr", `127.0.0.1:${port}`, "--grpc-listen-addr", `127.0.0.1:${port + 1}`, ...(args["sqld-args"] ? args["sqld-args"].split(" ") : [])], { stdio: "ignore" });
		await sleep(1500);
		try {
			const result = await trial(clients, mode, port);
			process.stderr.write(`${JSON.stringify(result)}\n`);
			results.push(result);
		} finally {
			server.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	}
}
const out = args.out ?? join(here, "results", "sqld-contention-repro.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ sqld: "v0.24.33", sqldArgs: args["sqld-args"] ?? null, results }, null, 2));
process.exit(0);
