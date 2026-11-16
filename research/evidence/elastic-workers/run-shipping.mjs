#!/usr/bin/env node
// Checkpoint shipping against synchronous commits (#4768, S2–S4): one shared store (sqld or PostgreSQL 16, in Docker),
// N worker host processes and one root, once with `checkpointShipping: "sync"` and once with background shipping.
//   node research/evidence/elastic-workers/run-shipping.mjs --store sqld|pg --hosts 8,16 --slots 4 --children 128 \
//     --steps 20 [--shipping '{"intervalMs":2000,"maxBatch":64}'] [--kill-after-ms 20000] [--out results/x.json]
// Per trial it records: completion, the children's acknowledged checkpoint latency (p50/p99), the rate at which the
// root's journal recorded checkpoints, the shared store's CPU time, the shipping lag of each recorded checkpoint (when
// the store recorded it after the step completed), and, with --kill-after-ms, the steps a replay ran again.
// Across VMs (#4768): one VM runs the store, the root and some hosts with
//   --listen <its private IP> --remote-hosts <how many hosts run elsewhere>
// and every other VM runs
//   --join <the first VM's private IP> --hosts <how many here> --id-base <first host number> --trials <trials>
// The joining VMs start their hosts for each trial the first VM announces, report them ready, and stop them when it
// ends. Hosts on other VMs record no step executions, so replays are only counted in one-VM runs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
// --idle-probe N (#5230): after the fan-out, every worker idles for --idle-settle-ms (store CPU per second idle), then the
// root runs N one-step children one at a time, and each one's claim latency (enqueue to start) is recorded. The fan-out's
// figures (CPU, profile) stop where the idle phase begins.
const idleProbe = Number(args["idle-probe"] ?? 0);
const idleSettleMs = Number(args["idle-settle-ms"] ?? 10_000);
// The classes below need more of each statement than the trace keeps by default.
if (profile) process.env.TRACE_WORDS ??= "40";
const listen = args.listen;
const remoteHosts = Number(args["remote-hosts"] ?? 0);
const join_ = args.join;
/** The store's port when other VMs reach it. */
const SHARED_PORT = store === "sqld" ? 18081 : 15432;
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

/**
 * SIGKILLs `pid` and every process under it at once, as a machine that dies would: a host's coordinator and workers
 * run in process groups of their own, so killing the host's group alone lets them flush and hand their work back.
 */
function killTree(pid) {
	const children = new Map();
	for (const line of spawnSync("ps", ["-eo", "pid=,ppid="]).stdout.toString().trim().split("\n")) {
		const [child, parent] = line.trim().split(/\s+/).map(Number);
		children.set(parent, [...(children.get(parent) ?? []), child]);
	}
	const all = [];
	for (const queue = [pid]; queue.length > 0; ) {
		const next = queue.shift();
		all.push(next);
		queue.push(...(children.get(next) ?? []));
	}
	for (const target of all)
		try {
			process.kill(target, "SIGSTOP");
		} catch {}
	for (const target of all)
		try {
			process.kill(target, "SIGKILL");
		} catch {}
	return all.length;
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
	// Traced across VMs, sqld listens on loopback and the trace proxy on the shared port in its place.
	const tracedAcross = profile && store === "sqld" && listen !== undefined;
	const port = listen === undefined ? await freePort() : tracedAcross ? SHARED_PORT + 1 : SHARED_PORT;
	const bind = tracedAcross ? "127.0.0.1" : (listen ?? "127.0.0.1");
	const name = `ship-bench-${store}-${port}`;
	// --native-sqld <binary>: the sqld binary run directly, as the first local runs did, instead of its Docker image.
	const native =
		store === "sqld" && args["native-sqld"] !== undefined
			? spawn(args["native-sqld"], ["--db-path", join(work, "sqld"), "--http-listen-addr", `127.0.0.1:${port}`], {
					stdio: "ignore",
					detached: true,
				})
			: undefined;
	// A store a stopped run left on the shared port would answer in this one's place.
	if (native === undefined) spawnSync("docker", ["rm", "-f", name]);
	if (native !== undefined) {
	} else if (store === "sqld")
		spawnSync("docker", [
			"run", "-d", "--rm", "--name", name, "-e", "SQLD_CHECKPOINT_INTERVAL_S=60", "-p", `${bind}:${port}:8080`,
			"ghcr.io/tursodatabase/libsql-server:v0.24.33",
			// --sqld-max-concurrent-requests: sqld's limit (128 by default), past which it answers 429.
			...(args["sqld-max-concurrent-requests"] === undefined
				? []
				: ["/bin/sqld", "--max-concurrent-requests", args["sqld-max-concurrent-requests"]]),
		]);
	else
		spawnSync("docker", [
			"run", "-d", "--rm", "--name", name, "-p", `${bind}:${port}:5432`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
			"postgres:16", "-c", "max_connections=1000",
			...(profile ? ["-c", "shared_preload_libraries=pg_stat_statements", "-c", "pg_stat_statements.track=all"] : []),
		]);
	const url =
		storeUrl(bind, port);
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
	const traced =
		profile && store === "sqld"
			? await startTraceProxy(port, listen === undefined ? undefined : { host: listen, port: SHARED_PORT })
			: undefined;
	return {
		url: traced === undefined ? url : `http://${listen ?? "127.0.0.1"}:${traced.port}`,
		/** Requests the trace proxy saw so far; null when nothing traces them. */
		requests: () => (traced === undefined ? null : traced.records.length),
		/** Starts counting what the store does from now. */
		resetProfile: () => {
			if (store === "pg" && profile) psql("SELECT pg_stat_statements_reset()");
			if (traced) traced.records.length = 0;
		},
		/** What the store spent its time on since {@link resetProfile}, by statement, busiest first. */
		profile: () => {
			if (!profile) return null;
			if (store === "pg") {
				const statements = psql(
					`SELECT calls, round(total_exec_time), rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 400) FROM pg_stat_statements ORDER BY total_exec_time DESC`,
				)
					.trim()
					.split("\n")
					.map((line) => {
						const [calls, ms, rows, sql] = line.split("\t");
						return { calls: Number(calls), ms: Number(ms), rows: Number(rows), sql };
					});
				return { classes: classTotals(statements.map((row) => ({ sql: row.sql, calls: row.calls, statements: row.calls, ms: row.ms }))), top: statements.slice(0, 40) };
			}
			// A request counts toward the class of its first statement past transaction control.
			return {
				requests: traced.records.length,
				classes: classTotals(
					traced.records.map((record) => ({
						sql: record.sql.find((sql) => !/^(BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(sql)) ?? record.sql.join(" "),
						calls: 1,
						statements: record.sql.length,
						ms: record.answered - record.arrived,
					})),
				),
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

/** What a statement does, by the tables it names: how the store's work divides between a pool's activities. */
const STATEMENT_CLASSES = [
	["lock wait (PG advisory)", /pg_advisory/],
	["libSQL stream probe", /sqlite_schema LIMIT 0/],
	["resource admission", /wf_runs_resource_/],
	["shipped batch ledger", /ship_batches|ship_watermarks/],
	["event insert", /INSERT INTO \w*wf_events\b/],
	["fence check", /pool_fence/],
	["checkpoint view read", /SELECT run_id, seq, key, payload|json_object\('seq'|json_build_object\(\$\d+, seq/],
	["usage", /pool_usage/],
	["operation receipts", /pool_operations/],
	["session store", /pool_session|_ps_|session_owners/],
	["work rows (claim, renew, complete)", /wf_runs_work\b|wf_runs_work /],
	["host registry and activity", /pool_hosts|pool_activity|wf_runs_pool_status/],
	["root lease and status", /wf_leases|wf_runs\b|wf_runs /],
	["schema and version checks", /schema_version|_meta\b|information_schema|dflt_value|sqlite_master|pragma/i],
	["notify / listen", /NOTIFY|LISTEN|pg_notify/i],
	["transaction control", /^(BEGIN|COMMIT|ROLLBACK|SET|sequence|close)\b/i],
];

function classTotals(rows) {
	const totals = new Map();
	for (const row of rows) {
		const name = STATEMENT_CLASSES.find(([, pattern]) => pattern.test(row.sql))?.[0] ?? "other";
		const entry = totals.get(name) ?? { calls: 0, statements: 0, ms: 0, samples: new Map() };
		if (name === "other") {
			const sample = row.sql.slice(0, 120);
			entry.samples.set(sample, (entry.samples.get(sample) ?? 0) + row.calls);
		}
		entry.calls += row.calls;
		entry.statements += row.statements;
		entry.ms += row.ms;
		totals.set(name, entry);
	}
	return Object.fromEntries(
		[...totals]
			.sort((a, b) => b[1].ms - a[1].ms)
			.map(([name, { samples, ...entry }]) => [
				name,
				{
					...entry,
					ms: Math.round(entry.ms),
					...(samples.size === 0 ? {} : { samples: [...samples].sort((a, b) => b[1] - a[1]).slice(0, 8) }),
				},
			]),
	);
}

function storeUrl(ip, port) {
	// The benchmark's PostgreSQL has no TLS; the adapter asks for it on any address but loopback.
	return store === "sqld" ? `http://${ip}:${port}` : `postgres://postgres@${ip}:${port}/postgres?sslmode=disable`;
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

/**
 * The host whose local journal holds the most unshipped checkpoints now: the one a kill costs the most steps of, so a
 * kill run measures the replay window rather than a host that happened to be idle.
 */
function busiestHost(work, count) {
	let busiest = count - 1;
	let most = -1;
	for (let index = 0; index < count; index++) {
		const ship = join(work, `host-${index}`, "workflows", "pool", "ship");
		let held = 0;
		if (existsSync(ship))
			for (const file of readdirSync(ship, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".sqlite"))) {
				try {
					const local = new DatabaseSync(join(ship, file), { readOnly: true });
					held += Number(local.prepare("SELECT COUNT(*) AS n FROM ship_events").get().n);
					local.close();
				} catch (error) {
					process.stderr.write(`cannot read ${file}: ${error.message}\n`);
				}
			}
		process.stderr.write(`at the kill, host h${index} held ${held} unshipped\n`);
		if (held > most) {
			most = held;
			busiest = index;
		}
	}
	return busiest;
}

async function trial(hosts, shipping) {
	const work = mkdtempSync(join(tmpdir(), `ship-bench-${hosts}-`));
	const log = [];
	const shared = await openStore(work);
	const prefix = `s${hosts}_${shipping === "sync" ? "sync" : "ship"}_`;
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
		for (let index = 0; index < hosts - remoteHosts; index++) {
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
		for (let index = 0; index < hosts - remoteHosts; index++)
			await waitFor(join(work, `ready-${index}`), deadline, processes, log);
		if (remoteHosts > 0) {
			// Announce the trial to the other VMs, and wait for their hosts.
			await query(shared.url, "CREATE TABLE IF NOT EXISTS bench_ctl(prefix TEXT, phase TEXT)");
			await query(shared.url, "CREATE TABLE IF NOT EXISTS bench_ready(host TEXT)");
			await query(shared.url, `INSERT INTO bench_ctl VALUES ('${prefix}', 'start')`);
			for (;;) {
				const [row] = await query(shared.url, "SELECT COUNT(*) AS n FROM bench_ready");
				if (Number(row.n) >= remoteHosts) break;
				// A pinned VM can wait a while for a free slot behind gate jobs.
				if (Date.now() > deadline + 1_800_000) throw new Error(`only ${row.n} of ${remoteHosts} remote hosts joined`);
				await sleep(500);
			}
		}
		const resultFile = join(work, "result.json");
		const phaseFile = join(work, "phases");
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
			...(idleProbe > 0
				? {
						ELASTIC_IDLE_PROBE: String(idleProbe),
						ELASTIC_IDLE_SETTLE_MS: String(idleSettleMs),
						ELASTIC_PHASE_FILE: phaseFile,
					}
				: {}),
		}, rootLog, work);
		processes.push(root);
		const exited = new Promise((resolve) => root.on("exit", (code, signal) => resolve(code ?? signal)));
		const runStart = Date.now();
		const runStartWall = runStart;
		let killedAt;
		let killed = hosts - 1;
		const killer =
			killAfter === undefined
				? undefined
				: setTimeout(async () => {
						// Once the children are under way (a quarter of their steps ran), so the kill lands mid-child.
						while (readFileSync(execLog, "utf8").split("\n").length < (children * steps) / 4) await sleep(200);
						killedAt = Date.now() - runStart;
						killed = busiestHost(work, hosts - remoteHosts);
						killTree(processes[killed].pid);
					}, killAfter);
		// With --idle-probe, the fan-out's figures are taken where the idle phase begins, and the idle phase's CPU apart.
		const phases = {};
		let mainCpuMs;
		let mainProfile;
		let mainRequests;
		let watching = idleProbe > 0;
		const phaseWatch = (async () => {
			while (watching) {
				const lines = existsSync(phaseFile) ? readFileSync(phaseFile, "utf8").trim().split("\n").filter(Boolean) : [];
				for (const line of lines) {
					const [name, at] = line.split(" ");
					if (phases[name] !== undefined) continue;
					phases[name] = { at: Number(at), cpuMs: shared.cpuMs() - cpuBefore, requests: shared.requests() };
					if (name === "main-done") {
						mainCpuMs = phases[name].cpuMs;
						mainProfile = shared.profile();
						mainRequests = phases[name].requests;
					}
				}
				await sleep(50);
			}
		})();
		const code = await Promise.race([exited, sleep(RUN_TIMEOUT_MS).then(() => "timeout")]);
		watching = false;
		await phaseWatch;
		clearTimeout(killer);
		const cpuMs = mainCpuMs ?? shared.cpuMs() - cpuBefore;
		const storeProfile = mainProfile ?? shared.profile();
		if (code !== 0 || !existsSync(resultFile)) throw new Error(`root exited ${code}\n${rootLog.join("").slice(-6000)}`);
		const result = JSON.parse(readFileSync(resultFile, "utf8"));
		const events = await query(
			shared.url,
			`SELECT at, payload FROM ${prefix}wf_events WHERE type = 'CheckpointRecorded' AND key LIKE '%"tool"%'`,
		);
		const recorded = events.map((row) => {
			const payload = JSON.parse(String(row.payload));
			return { at: Number(row.at), completedAt: payload.completedAt, host: payload.output?.host ?? null };
		});
		const ats = recorded.map((row) => row.at);
		const journalSpanMs = Math.max(...ats) - Math.min(...ats);
		const lags = recorded.map((row) => row.at - row.completedAt);
		// The checkpoints that waited longest, by the host that ran their step, to tell a live host's overshoot from
		// anything a killed host left behind.
		const slowest = recorded
			.map((row) => ({ host: row.host, lagMs: row.at - row.completedAt, completedAtMs: row.completedAt - runStartWall }))
			.sort((a, b) => b.lagMs - a.lagMs)
			.slice(0, 20);
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
		const killedShip = join(work, `host-${killed}`, "workflows", "pool", "ship");
		if (killedAt !== undefined && existsSync(killedShip)) {
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
		const idle =
			phases["main-done"] === undefined || phases["probe-start"] === undefined
				? null
				: (() => {
						const settled = phases["probe-start"];
						const done = phases["main-done"];
						const seconds = (settled.at - done.at) / 1000;
						const probes = (result.probes ?? []).filter((probe) => probe.startedAt !== null);
						const latencies = probes.map((probe) => probe.startedAt - probe.enqueuedAt);
						const byPlacement = {};
						for (const probe of probes) {
							// h0–h3 run on the store's VM; the root's own worker is "root"; other hosts are on other VMs.
							const placement =
								probe.host === "root" ? "root host" : Number(probe.host?.slice(1)) < 100 ? "store VM" : "other VMs";
							(byPlacement[placement] ??= []).push(probe.startedAt - probe.enqueuedAt);
						}
						return {
							settleMs: settled.at - done.at,
							storeCpuMsPerSec: Math.round((settled.cpuMs - done.cpuMs) / seconds),
							storeRequestsPerSec:
								settled.requests === null ? null : Math.round((settled.requests - done.requests) / seconds),
							claimLatencyMs: distribution(latencies),
							claimLatencyByPlacementMs: Object.fromEntries(
								Object.entries(byPlacement).map(([placement, values]) => [placement, distribution(values)]),
							),
							probes: result.probes,
						};
					})();
		const mainWallMs = phases["main-done"] === undefined ? result.wallMs : phases["main-done"].at - result.began;
		return {
			store,
			hosts,
			slots,
			shipping: shipping === "sync" ? "sync" : JSON.parse(shipping),
			killedHostAtMs: killedAt ?? null,
			killedHost: killedAt === undefined ? null : `h${killed}`,
			...summarize(result),
			journal: {
				checkpoints: recorded.length,
				spanMs: journalSpanMs,
				checkpointsPerSec: Math.round((recorded.length / (journalSpanMs / 1000)) * 10) / 10,
			},
			sharedStoreCpuMs: Math.round(cpuMs),
			mainWallMs,
			/** The store's CPU time per second of the fan-out. */
			storeCpuMsPerSec: Math.round(cpuMs / (mainWallMs / 1000)),
			storeRequests: mainRequests ?? shared.requests(),
			idle,
			/** The store's CPU time per step the children took, each acknowledged with a checkpoint. */
			storeCpuMsPerCheckpoint: Math.round((cpuMs / acknowledged) * 100) / 100,
			storeProfile,
			shippingLagMs: distribution(lags),
			slowestCheckpoints: slowest,
			batches: { count: batches.length, events: distribution(batches.map((row) => Number(row.events))) },
			replayed: {
				steps: executions.length - perStep.size,
				children: replayedByChild.size,
				perChild: distribution([...replayedByChild.values()]),
				unshippedAtKillPerAttempt: distribution(unshippedAtKill),
			},
		};
	} finally {
		if (remoteHosts > 0) {
			await query(shared.url, `INSERT INTO bench_ctl VALUES ('${prefix}', 'done')`).catch(() => {});
			await sleep(10_000);
		}
		for (const p of processes) killGroup(p, "SIGINT");
		await sleep(3000);
		for (const p of processes) killGroup(p, "SIGKILL");
		shared.close();
		if (args.keep !== "1") rmSync(work, { recursive: true, force: true });
	}
}

/** A joining VM: its hosts serve each trial the store's VM announces, until `--trials` trials ended. */
async function joinTrials() {
	const url = storeUrl(join_, SHARED_PORT);
	const count = Number(args.hosts ?? 4);
	const base = Number(args["id-base"] ?? 100);
	const served = new Set();
	const deadline = Date.now() + RUN_TIMEOUT_MS;
	while (served.size < Number(args.trials ?? 2) && Date.now() < deadline) {
		const rows = await query(url, "SELECT prefix, phase FROM bench_ctl").catch(() => []);
		const started = rows.find((row) => row.phase === "start" && !served.has(row.prefix));
		if (started === undefined) {
			await sleep(1000);
			continue;
		}
		const prefix = String(started.prefix);
		served.add(prefix);
		const work = mkdtempSync(join(tmpdir(), "ship-join-"));
		const log = [];
		const processes = [];
		for (let index = 0; index < count; index++) {
			const agentDir = join(work, `host-${index}`, "agent");
			processes.push(
				start(process.execPath, [join(here, "bench-host.mjs")], {
					ELASTIC_ADAPTER: adapters[store],
					ELASTIC_DB_URL: url,
					ELASTIC_PREFIX: prefix,
					ELASTIC_EXEC_LOG: join(work, "executions"),
					HOME: join(work, `host-${index}`),
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ELASTIC_AGENT_DIR: agentDir,
					ELASTIC_HOST_ID: `h${base + index}`,
					ELASTIC_BENCH_HOST: `h${base + index}`,
					ELASTIC_SLOTS: String(slots),
					ELASTIC_READY_FILE: join(work, `ready-${index}`),
				}, log, work),
			);
		}
		try {
			for (let index = 0; index < count; index++) {
				await waitFor(join(work, `ready-${index}`), Date.now() + 180_000, processes, log);
				await query(url, `INSERT INTO bench_ready VALUES ('h${base + index}')`);
			}
			process.stderr.write(`joined ${prefix} with ${count} hosts\n`);
			for (;;) {
				const phases = await query(url, `SELECT phase FROM bench_ctl WHERE prefix = '${prefix}'`).catch(() => undefined);
				if (phases === undefined || phases.some((row) => row.phase === "done")) break;
				await sleep(1000);
			}
		} catch (error) {
			process.stderr.write(`${error?.message ?? error}\n${log.join("").slice(-3000)}\n`);
		} finally {
			for (const p of processes) killGroup(p, "SIGINT");
			await sleep(3000);
			for (const p of processes) killGroup(p, "SIGKILL");
			rmSync(work, { recursive: true, force: true });
		}
	}
	process.stderr.write(`served ${served.size} trials\n`);
	process.exit(0);
}
if (join_ !== undefined) await joinTrials();

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
