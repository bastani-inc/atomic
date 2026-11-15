#!/usr/bin/env node
// Checkpoint shipping against synchronous commits (#4768, S2–S4): one shared store (sqld or PostgreSQL 16, in Docker),
// N worker host processes and one root, once with `checkpointShipping: "sync"` and once with background shipping.
//   node research/evidence/elastic-workers/run-shipping.mjs --store sqld|pg --hosts 8,16 --slots 4 --children 128 \
//     --steps 20 [--shipping '{"intervalMs":2000,"maxBatch":64}'] [--kill-after-ms 20000] [--out results/x.json]
// Per trial it records: completion, the children's acknowledged checkpoint latency (p50/p99), the rate at which the
// root's journal recorded checkpoints, the shared store's CPU time, the shipping lag of each recorded checkpoint (when
// the store recorded it after the step completed), and, with --kill-after-ms, the steps a replay ran again.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { percentile, summarize } from "./stats.mjs";
import { startTraceProxy } from "./trace-proxy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const store = args.store ?? "sqld";
const hostCounts = (args.hosts ?? "8").split(",").map(Number);
const slots = Number(args.slots ?? 4);
const children = Number(args.children ?? 128);
const steps = Number(args.steps ?? 20);
const shipped = args.shipping ?? JSON.stringify({ intervalMs: 2000, maxBatch: 64, maxLagMs: 30000 });
// --modes sync,ship (default both): which trials run for each host count.
const shippingModes = (args.modes ?? "sync,ship").split(",").map((mode) => (mode === "sync" ? "sync" : shipped));
const killAfter = args["kill-after-ms"] === undefined ? undefined : Number(args["kill-after-ms"]);
const out = args.out ?? join(here, "results", `shipping-${store}-${Date.now()}.json`);
const RUN_TIMEOUT_MS = Number(args["run-timeout-ms"] ?? 900_000);
// --profile 1: what the store spent its time on, by statement (PostgreSQL's pg_stat_statements; for sqld, a proxy that
// records every request).
const profile = args.profile === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const adapters = {
	sqld: fileURLToPath(new URL("../../../packages/storage-libsql/libsql.js", import.meta.url)),
	pg: fileURLToPath(new URL("../../../packages/storage-postgres/postgres.js", import.meta.url)),
};

async function freePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/**
 * Every process runs in `cwd`, a scratch directory outside any repository: in a repository with uncommitted changes
 * every checkpoint would carry a worktree snapshot, and those always commit directly (see the README).
 */
function start(command, argv, env, log, cwd) {
	const child = spawn(command, argv, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"], detached: true });
	child.stderr.on("data", (chunk) => log.push(chunk.toString()));
	return child;
}

function killGroup(child, signal) {
	try {
		process.kill(-child.pid, signal);
	} catch {}
}

async function waitFor(file, deadline, processes, log) {
	while (!existsSync(file)) {
		for (const p of processes)
			if (p.exitCode !== null)
				throw new Error(`process exited (${p.exitCode}) before ${file}\n${log.join("").slice(-3000)}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
		await sleep(100);
	}
}

/** The shared store of one trial: its URL, its CPU time so far in milliseconds, and how to stop it. */
async function openStore(work) {
	const port = await freePort();
	const name = `ship-bench-${store}-${port}`;
	// --native-sqld <binary>: the sqld binary run directly, as the first local runs did, instead of its Docker image.
	const native =
		store === "sqld" && args["native-sqld"] !== undefined
			? spawn(args["native-sqld"], ["--db-path", join(work, "sqld"), "--http-listen-addr", `127.0.0.1:${port}`], {
					stdio: "ignore",
					detached: true,
				})
			: undefined;
	if (native !== undefined) {
	} else if (store === "sqld")
		spawnSync("docker", [
			"run", "-d", "--rm", "--name", name, "-e", "SQLD_CHECKPOINT_INTERVAL_S=60", "-p", `127.0.0.1:${port}:8080`,
			"ghcr.io/tursodatabase/libsql-server:v0.24.33",
		]);
	else
		spawnSync("docker", [
			"run", "-d", "--rm", "--name", name, "-p", `127.0.0.1:${port}:5432`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
			"postgres:16", "-c", "max_connections=1000",
			...(profile ? ["-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=all"] : []),
		]);
	const url =
		store === "sqld" ? `http://127.0.0.1:${port}` : `postgres://postgres@127.0.0.1:${port}/postgres`;
	const ready = () =>
		store === "sqld"
			? fetch(`${url}/health`).then((response) => response.ok, () => false)
			: Promise.resolve(spawnSync("docker", ["exec", name, "pg_isready", "-U", "postgres"]).status === 0);
	for (let tries = 0; !(await ready()); tries++) {
		if (tries > 240) throw new Error(`${store} did not start`);
		await sleep(500);
	}
	await sleep(1000);
	const psql = (sql) =>
		spawnSync("docker", ["exec", name, "psql", "-U", "postgres", "-At", "-F", "\t", "-c", sql]).stdout.toString();
	if (profile && store === "pg") psql("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
	const traced = profile && store === "sqld" ? await startTraceProxy(port) : undefined;
	return {
		url: traced === undefined ? url : `http://127.0.0.1:${traced.port}`,
		/** Starts counting what the store does from now. */
		resetProfile: () => {
			if (store === "pg" && profile) psql("SELECT pg_stat_statements_reset()");
			if (traced) traced.records.length = 0;
		},
		/** What the store spent its time on since {@link resetProfile}, by statement, busiest first. */
		profile: () => {
			if (!profile) return null;
			if (store === "pg")
				return Object.fromEntries(
					["total_exec_time", "calls"].map((order) => [
						order === "calls" ? "byCalls" : "byTime",
						psql(
							`SELECT calls, round(total_exec_time), rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 160) FROM pg_stat_statements ORDER BY ${order} DESC LIMIT 40`,
						)
							.trim()
							.split("\n")
							.map((line) => {
								const [calls, ms, rows, sql] = line.split("\t");
								return { calls: Number(calls), ms: Number(ms), rows: Number(rows), sql };
							}),
					]),
				);
			const kinds = new Map();
			for (const record of traced.records) {
				const kind =
					record.sql.filter((sql) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)).slice(0, 2).join(" | ") || record.sql.join("|");
				const entry = kinds.get(kind) ?? { requests: 0, statements: 0, ms: 0 };
				entry.requests++;
				entry.statements += record.sql.length;
				entry.ms += record.answered - record.arrived;
				kinds.set(kind, entry);
			}
			return {
				requests: traced.records.length,
				byKind: [...kinds]
					.sort((a, b) => b[1].requests - a[1].requests)
					.slice(0, 30)
					.map(([kind, entry]) => ({ kind, ...entry, ms: Math.round(entry.ms) })),
			};
		},
		// The container's CPU time: what the shared store spent serving the trial.
		cpuMs: () => {
			if (native !== undefined) {
				const fields = readFileSync(`/proc/${native.pid}/stat`, "utf8").split(") ")[1].split(" ");
				return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
			}
			const stat = spawnSync("docker", ["exec", name, "cat", "/sys/fs/cgroup/cpu.stat"]).stdout.toString();
			return Number(/usage_usec (\d+)/.exec(stat)?.[1] ?? 0) / 1000;
		},
		close: () => {
			traced?.close();
			if (native !== undefined) killGroup(native, "SIGKILL");
			else spawnSync("docker", ["rm", "-f", name]);
		},
	};
}

async function query(url, sql) {
	if (store === "sqld") {
		const { openLibsqlDatabase } = await import(adapters.sqld);
		const db = await openLibsqlDatabase({ url });
		try {
			return await db.all(sql);
		} finally {
			await db.close();
		}
	}
	const { openPostgresDatabase } = await import(adapters.pg);
	const db = await openPostgresDatabase({ url });
	try {
		return await db.all(sql);
	} finally {
		await db.close();
	}
}

/** Distribution of `values`, in milliseconds. */
function distribution(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return { n: sorted.length, p50: percentile(sorted, 50), p90: percentile(sorted, 90), p99: percentile(sorted, 99), max: sorted.at(-1) ?? null };
}

async function trial(hosts, shipping) {
	const work = mkdtempSync(join(tmpdir(), `ship-bench-${hosts}-`));
	const log = [];
	const shared = await openStore(work);
	const prefix = `s${hosts}_`;
	const execLog = join(work, "executions");
	writeFileSync(execLog, "");
	const processes = [];
	const common = {
		ELASTIC_ADAPTER: adapters[store],
		ELASTIC_DB_URL: shared.url,
		ELASTIC_PREFIX: prefix,
		ELASTIC_EXEC_LOG: execLog,
	};
	try {
		for (let index = 0; index < hosts; index++) {
			const agentDir = join(work, `host-${index}`, "agent");
			processes.push(
				start(process.execPath, [join(here, "bench-host.mjs")], {
					...common,
					HOME: join(work, `host-${index}`),
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ELASTIC_AGENT_DIR: agentDir,
					ELASTIC_HOST_ID: `h${index}`,
					ELASTIC_BENCH_HOST: `h${index}`,
					ELASTIC_SLOTS: String(slots),
					ELASTIC_READY_FILE: join(work, `ready-${index}`),
				}, log, work),
			);
		}
		const deadline = Date.now() + 180_000;
		for (let index = 0; index < hosts; index++) await waitFor(join(work, `ready-${index}`), deadline, processes, log);
		const resultFile = join(work, "result.json");
		shared.resetProfile();
		const cpuBefore = shared.cpuMs();
		const rootLog = [];
		const root = start(process.execPath, [join(here, "bench-root.mjs")], {
			...common,
			HOME: join(work, "root"),
			ATOMIC_CODING_AGENT_DIR: join(work, "root", "agent"),
			ELASTIC_BENCH_HOST: "root",
			ELASTIC_CHILDREN: String(children),
			ELASTIC_STEPS: String(steps),
			// --work-ms: how long each step's body runs, so a child outlives its shipping window.
			ELASTIC_WORK_MS: String(args["work-ms"] ?? 0),
			ELASTIC_ROOT_WORKERS: "1",
			ELASTIC_RESULT_FILE: resultFile,
			ELASTIC_SESSIONS: String(hosts * slots + 1),
			...(killAfter === undefined ? {} : { ELASTIC_LEASE_MS: String(args["lease-ms"] ?? 8000) }),
			...(shipping === "sync" ? {} : { ELASTIC_CHECKPOINT_SHIPPING: shipping }),
		}, rootLog, work);
		processes.push(root);
		const exited = new Promise((resolve) => root.on("exit", (code, signal) => resolve(code ?? signal)));
		const runStart = Date.now();
		let killedAt;
		const killer =
			killAfter === undefined
				? undefined
				: setTimeout(() => {
						killedAt = Date.now() - runStart;
						killGroup(processes[hosts - 1], "SIGKILL");
					}, killAfter);
		const code = await Promise.race([exited, sleep(RUN_TIMEOUT_MS).then(() => "timeout")]);
		clearTimeout(killer);
		const cpuMs = shared.cpuMs() - cpuBefore;
		const storeProfile = shared.profile();
		if (code !== 0 || !existsSync(resultFile)) throw new Error(`root exited ${code}\n${rootLog.join("").slice(-6000)}`);
		const result = JSON.parse(readFileSync(resultFile, "utf8"));
		const events = await query(
			shared.url,
			`SELECT at, payload FROM ${prefix}wf_events WHERE type = 'CheckpointRecorded' AND key LIKE '%"tool"%'`,
		);
		const recorded = events.map((row) => ({ at: Number(row.at), completedAt: JSON.parse(String(row.payload)).completedAt }));
		const ats = recorded.map((row) => row.at);
		const journalSpanMs = Math.max(...ats) - Math.min(...ats);
		const lags = recorded.map((row) => row.at - row.completedAt);
		const batches =
			shipping === "sync"
				? []
				: await query(shared.url, `SELECT events FROM ${prefix}wf_runs_ship_batches`).catch(() => []);
		const executions = readFileSync(execLog, "utf8").split("\n").filter(Boolean);
		const perStep = new Map();
		for (const line of executions) perStep.set(line, (perStep.get(line) ?? 0) + 1);
		const replayedByChild = new Map();
		for (const [line, count] of perStep)
			if (count > 1) {
				const child = line.split(":")[0];
				replayedByChild.set(child, (replayedByChild.get(child) ?? 0) + count - 1);
			}
		// What the killed host held unshipped when it died, per attempt: its local journal, which nothing reopened.
		const unshippedAtKill = [];
		const killedShip = join(work, `host-${hosts - 1}`, "workflows", "pool", "ship");
		if (killedAt !== undefined && existsSync(killedShip)) {
			const { DatabaseSync } = await import("node:sqlite");
			for (const file of readdirSync(killedShip, { recursive: true, encoding: "utf8" }).filter((name) =>
				name.endsWith(".sqlite"),
			)) {
				const local = new DatabaseSync(join(killedShip, file), { readOnly: true });
				for (const row of local.prepare("SELECT COUNT(*) AS n FROM ship_events GROUP BY work, generation").all())
					unshippedAtKill.push(Number(row.n));
				local.close();
			}
		}
		const acknowledged = children * steps;
		return {
			store,
			hosts,
			slots,
			shipping: shipping === "sync" ? "sync" : JSON.parse(shipping),
			killedHostAtMs: killedAt ?? null,
			...summarize(result),
			journal: {
				checkpoints: recorded.length,
				spanMs: journalSpanMs,
				checkpointsPerSec: Math.round((recorded.length / (journalSpanMs / 1000)) * 10) / 10,
			},
			sharedStoreCpuMs: Math.round(cpuMs),
			/** The store's CPU time per step the children took, each acknowledged with a checkpoint. */
			storeCpuMsPerCheckpoint: Math.round((cpuMs / acknowledged) * 100) / 100,
			storeProfile,
			shippingLagMs: distribution(lags),
			batches: { count: batches.length, events: distribution(batches.map((row) => Number(row.events))) },
			replayed: {
				steps: executions.length - perStep.size,
				children: replayedByChild.size,
				perChild: distribution([...replayedByChild.values()]),
				unshippedAtKillPerAttempt: distribution(unshippedAtKill),
			},
		};
	} finally {
		for (const p of processes) killGroup(p, "SIGINT");
		await sleep(3000);
		for (const p of processes) killGroup(p, "SIGKILL");
		shared.close();
		if (args.keep !== "1") rmSync(work, { recursive: true, force: true });
	}
}

const trials = [];
for (const hosts of hostCounts)
	for (const shipping of shippingModes) {
		const result = await trial(hosts, shipping).catch((error) => ({
			store,
			hosts,
			shipping,
			status: "error",
			error: String(error?.message ?? error).slice(0, 4000),
		}));
		process.stderr.write(`${JSON.stringify({ ...result, perHost: undefined })}\n`);
		trials.push(result);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, JSON.stringify({ store, slots, children, steps, killAfterMs: killAfter ?? null, trials }, null, 2));
	}
process.stderr.write(`wrote ${out}\n`);
// An adapter's idle connections would keep the process alive.
process.exit(0);
