#!/usr/bin/env node
// Hot-path benchmark for the PostgreSQL adapter spec (#4793), in the shape of #4768's run-local.mjs: one root, N worker
// host processes × S slots, C children × K checkpoints each, against sqld or Postgres.
//   node research/evidence/postgres-adapter/run-hotpath.mjs --backend sqlite|pg|pg-serial --hosts 8,16,32 --slots 4 \
//     [--children-per-slot 2] [--steps 20] [--payload 256] [--pg-url postgres://…] [--pg-module <dir>/node_modules/]
//     [--sqld-args "--checkpoint-interval-s 60"] [--out results/<file>.json]
// The root is this process: it creates the schema and the work, renews its lease every 5 s, and watches progress. A
// trial is "stalled" when nothing completes and no checkpoint lands for 60 s, then a write probe is recorded.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { hotPath, openPostgres, openSqlite } from "./hotpath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const backend = args.backend ?? "sqlite";
const hostCounts = (args.hosts ?? "8,16,32").split(",").map(Number);
const slots = Number(args.slots ?? 4);
const perSlot = Number(args["children-per-slot"] ?? 2);
const steps = Number(args.steps ?? 20);
const payload = Number(args.payload ?? 256);
const pgUrl = args["pg-url"] ?? "postgres://bench:bench@127.0.0.1:55432/bench";
const pgModule = args["pg-module"] ?? "/fast/tmp/pg-proto/node_modules/";
const sqld = args.sqld ?? join(homedir(), ".cache/atomic-distributed-test/sqld/v0.24.33/sqld");
const sqldArgs = (args["sqld-args"] ?? "--checkpoint-interval-s 60").split(" ").filter(Boolean);
const out = args.out ?? join(here, "results", `hotpath-${backend}-${Date.now()}.json`);
const tmpRoot = args.tmp ?? "/fast/tmp";
const STALL_MS = 60_000;
const latencyMs = Number(args["latency-ms"] ?? 0);

/** A TCP hop that holds each chunk `oneWayMs` in each direction, standing in for the network (as #4768's harness). */
function proxy(targetHost, targetPort, oneWayMs) {
	const server = createServer((client) => {
		const upstream = new Socket();
		upstream.connect(targetPort, targetHost);
		const forward = (from, to) => {
			from.on("data", (chunk) => setTimeout(() => !to.destroyed && to.write(chunk), oneWayMs));
			from.on("end", () => setTimeout(() => to.end(), oneWayMs));
			from.on("error", () => to.destroy());
			from.on("close", () => to.destroy());
		};
		forward(client, upstream);
		forward(upstream, client);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const RUN_TIMEOUT_MS = Number(args["run-timeout-ms"] ?? 900_000);

async function freePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const percentile = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);

function summarize(hostResults, wallMs) {
	const latencies = hostResults.flatMap((r) => r.latencies).sort((a, b) => a - b);
	const commits = hostResults.flatMap((r) => r.commits).sort((a, b) => a - b);
	let maxGapMs = 0;
	let stallsOver5s = 0;
	for (let i = 1; i < commits.length; i++) {
		const gap = commits[i] - commits[i - 1];
		maxGapMs = Math.max(maxGapMs, gap);
		if (gap >= 5_000) stallsOver5s++;
	}
	const errors = {};
	for (const r of hostResults) for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
	const activeMs = commits.length > 1 ? commits.at(-1) - commits[0] : 0;
	return {
		checkpoints: latencies.length,
		wallMs,
		activeMs,
		checkpointsPerSec: activeMs > 0 ? Math.round((latencies.length / (activeMs / 1000)) * 10) / 10 : 0,
		latencyMs: { p50: percentile(latencies, 50), p90: percentile(latencies, 90), p99: percentile(latencies, 99), max: latencies.at(-1) ?? null },
		commitsOver5s: latencies.filter((l) => l >= 5_000).length,
		stallsOver5s,
		maxGapMs,
		errors,
	};
}

async function trial(hosts) {
	const work = mkdtempSync(join(tmpRoot, `pg-hotpath-${backend}-${hosts}-`));
	const children = hosts * slots * perSlot;
	const prefix = `h${hosts}_${backend.replace("-", "_")}_${Date.now() % 100000}_`;
	const processes = [];
	let sqldProcess;
	let url = pgUrl;
	let front;
	try {
		if (backend === "sqlite") {
			const port = await freePort();
			sqldProcess = spawn(sqld, ["--db-path", join(work, "sqld"), "--http-listen-addr", `127.0.0.1:${port}`, "--grpc-listen-addr", `127.0.0.1:${await freePort()}`, ...sqldArgs], { stdio: "ignore", detached: true });
			await sleep(1500);
			url = `http://127.0.0.1:${port}`;
		}
		if (latencyMs > 0) {
			const target = new URL(url);
			front = await proxy(target.hostname, Number(target.port), latencyMs);
			target.port = String(front.address().port);
			url = target.href.replace(/\/$/, "");
		}
		const open = () => (backend === "sqlite" ? openSqlite({ url }) : openPostgres({ url, serial: backend === "pg-serial", max: 2, pgModule }));
		const db = await open();
		const pool = hotPath(db, prefix);
		const lease = { runId: "root", holderId: "root-holder", epoch: 1 };
		await pool.setup(lease, children, 120_000);
		for (let index = 0; index < hosts; index++)
			processes.push(
				spawn(process.execPath, [join(here, "hotpath-host.mjs")], {
					env: { ...process.env, HP_BACKEND: backend, HP_URL: url, HP_PREFIX: prefix, HP_HOST: `h${index}`, HP_SLOTS: String(slots), HP_STEPS: String(steps), HP_PAYLOAD: String(payload), HP_PG_MODULE: pgModule, HP_READY_FILE: join(work, `ready-${index}`), HP_RESULT_FILE: join(work, `result-${index}.json`) },
					stdio: ["ignore", "ignore", "inherit"],
				}),
			);
		for (let index = 0; index < hosts; index++) while (!existsSync(join(work, `ready-${index}`))) await sleep(50);
		const began = Date.now();
		let lastProgress = began;
		let lastSeen = "";
		let status = "completed";
		const renew = setInterval(() => void pool.renewRoot(lease).catch(() => {}), 5_000);
		const exited = Promise.all(processes.map((p) => new Promise((resolve) => p.on("exit", resolve))));
		for (;;) {
			const finished = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
			if (finished) break;
			const progress = await Promise.race([pool.progress(lease), sleep(5_000).then(() => "timeout")]).catch((e) => String(e));
			const events = await Promise.race([pool.invariants(lease), sleep(5_000).then(() => "timeout")]).catch((e) => String(e));
			const seen = JSON.stringify([progress, events]);
			if (seen !== lastSeen) {
				lastSeen = seen;
				lastProgress = Date.now();
			}
			process.stderr.write(`[${backend} ${hosts}×${slots}] +${Math.round((Date.now() - began) / 1000)}s ${seen}\n`);
			if (Date.now() - lastProgress > STALL_MS || Date.now() - began > RUN_TIMEOUT_MS) {
				status = Date.now() - began > RUN_TIMEOUT_MS ? "timed-out" : "stalled";
				break;
			}
		}
		clearInterval(renew);
		const wallMs = Date.now() - began;
		let writeProbe = null;
		if (status !== "completed") {
			const probeDb = await open();
			writeProbe = await Promise.race([probeDb.exec(`CREATE TABLE IF NOT EXISTS ${prefix}zz_probe(x TEXT)`).then(() => "ok"), sleep(15_000).then(() => "timed out after 15 s")]).catch((e) => String(e));
			await probeDb.close().catch(() => {});
			for (const p of processes) if (p.exitCode === null) p.kill("SIGKILL");
		}
		const hostResults = [];
		for (let index = 0; index < hosts; index++) {
			const file = join(work, `result-${index}.json`);
			if (existsSync(file)) hostResults.push(JSON.parse(readFileSync(file, "utf8")));
		}
		const invariants = await pool.invariants(lease).catch((e) => String(e));
		const progress = await pool.progress(lease).catch((e) => String(e));
		await db.close();
		return { backend, hosts, slots, oneWayLatencyMs: latencyMs, children, steps, status, writeProbe, progress, invariants, ...summarize(hostResults, wallMs) };
	} finally {
		for (const p of processes) if (p.exitCode === null) p.kill("SIGKILL");
		if (sqldProcess) {
			try {
				process.kill(-sqldProcess.pid, "SIGKILL");
			} catch {}
		}
		front?.close();
		await sleep(500);
		rmSync(work, { recursive: true, force: true });
	}
}

const trials = [];
for (const hosts of hostCounts) {
	const result = await trial(hosts).catch((error) => ({ backend, hosts, status: "error", error: String(error?.stack ?? error).slice(0, 2000) }));
	process.stderr.write(`${JSON.stringify(result)}\n`);
	trials.push(result);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify({ backend, slots, perSlot, steps, payload, sqldArgs: backend === "sqlite" ? sqldArgs : null, machine: { cpus: (await import("node:os")).cpus().length }, trials }, null, 2)}\n`);
}
process.stderr.write(`wrote ${out}\n`);
process.exit(0);
