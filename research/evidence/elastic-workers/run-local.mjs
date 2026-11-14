#!/usr/bin/env node
// Local multi-process baseline of today's shared placement (#4768): one sqld, N worker host processes, one root.
//   node research/evidence/elastic-workers/run-local.mjs --hosts 1,2,4,8 --slots 4 --children 64 --steps 20 \
//     [--latency-ms 0] [--payload 256] [--out research/evidence/elastic-workers/results/local.json]
// Each host is a separate Node process with its own agent directory, standing in for a machine. `--latency-ms` puts a
// TCP proxy in front of sqld that holds each chunk that long in each direction, standing in for a network hop.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./stats.mjs";
import { analyze, startTraceProxy } from "./trace-proxy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const hostCounts = (args.hosts ?? "1,2,4").split(",").map(Number);
const slots = Number(args.slots ?? 4);
const children = Number(args.children ?? 64);
const steps = Number(args.steps ?? 20);
const payload = Number(args.payload ?? 256);
const latencyMs = Number(args["latency-ms"] ?? 0);
const out = args.out ?? join(here, "results", `local-${Date.now()}.json`);
const sqld = args.sqld ?? join(homedir(), ".cache/atomic-distributed-test/sqld/v0.24.33/sqld");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Phase budgets: hosts must be ready, and the root must finish, within these, or the trial is recorded as stalled. */
const READY_TIMEOUT_MS = Number(args["ready-timeout-ms"] ?? 120_000);
const RUN_TIMEOUT_MS = Number(args["run-timeout-ms"] ?? 600_000);
const PROGRESS_MS = 10_000;
const { openLibsqlDatabase } = await import("../../../packages/storage-libsql/libsql.js");

/** One bounded read of the shared store: never lets a wedged store hang the harness. */
async function probe(url, statements, timeoutMs = 5_000) {
	const attempt = (async () => {
		const db = await openLibsqlDatabase({ url });
		try {
			const out = {};
			for (const [name, sql] of Object.entries(statements)) out[name] = await db.all(sql);
			return out;
		} finally {
			await db.close();
		}
	})();
	return Promise.race([attempt, sleep(timeoutMs).then(() => ({ timedOut: timeoutMs }))]).catch((error) => ({ error: String(error?.message ?? error) }));
}
const progressQueries = (prefix) => ({
	work: `SELECT state, COUNT(*) AS n FROM ${prefix}wf_runs_work GROUP BY state`,
	events: `SELECT COUNT(*) AS n FROM ${prefix}wf_events`,
});

async function freePort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

function proxy(targetPort, oneWayMs) {
	const server = createServer((client) => {
		const upstream = new Socket();
		upstream.connect(targetPort, "127.0.0.1");
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

function start(command, argv, env, log) {
	const child = spawn(command, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"], detached: true });
	child.stderr.on("data", (chunk) => log.push(chunk.toString()));
	return child;
}

/** Signals a started process and everything it started (each runs in a process group of its own). */
function killGroup(child, signal) {
	try {
		process.kill(-child.pid, signal);
	} catch {}
}

async function waitFor(file, deadline, processes) {
	while (!existsSync(file)) {
		for (const p of processes) if (p.exitCode !== null) throw new Error(`process exited (${p.exitCode}) before ${file}`);
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
		await sleep(100);
	}
}

async function trial(hosts) {
	const work = mkdtempSync(join(tmpdir(), `elastic-bench-${hosts}-`));
	const port = await freePort();
	const log = [];
	const sqldLog = [];
	const db = start(sqld, ["--db-path", join(work, "sqld"), "--http-listen-addr", `127.0.0.1:${port}`, "--grpc-listen-addr", `127.0.0.1:${await freePort()}`, ...(args["sqld-args"] ? args["sqld-args"].split(" ") : [])], {}, sqldLog);
	await sleep(1500);
	const front = latencyMs > 0 ? await proxy(port, latencyMs) : undefined;
	const traced = args.trace === "1" ? await startTraceProxy(front ? front.address().port : port) : undefined;
	const url = `http://127.0.0.1:${traced ? traced.port : front ? front.address().port : port}`;
	const prefix = `b${hosts}_`;
	const processes = [];
	const hostStart = Date.now();
	try {
		for (let index = 0; index < hosts; index++) {
			const agentDir = join(work, `host-${index}`, "agent");
			processes.push(
				start(process.execPath, [join(here, "bench-host.mjs")], {
					HOME: join(work, `host-${index}`),
					ATOMIC_CODING_AGENT_DIR: agentDir,
					ELASTIC_AGENT_DIR: agentDir,
					ELASTIC_DB_URL: url,
					ELASTIC_PREFIX: prefix,
					ELASTIC_HOST_ID: `h${index}`,
					ELASTIC_BENCH_HOST: `h${index}`,
					ELASTIC_SLOTS: String(slots),
					ELASTIC_READY_FILE: join(work, `ready-${index}`),
				}, log),
			);
		}
		const deadline = Date.now() + READY_TIMEOUT_MS;
		for (let index = 0; index < hosts; index++) await waitFor(join(work, `ready-${index}`), deadline, processes);
		const hostsReadyMs = Date.now() - hostStart;
		const resultFile = join(work, "result.json");
		const rootAgent = join(work, "root", "agent");
		const root = start(process.execPath, [join(here, "bench-root.mjs")], {
			ATOMIC_CODING_AGENT_DIR: rootAgent,
			ELASTIC_BENCH_HOST: "root",
			ELASTIC_DB_URL: url,
			ELASTIC_PREFIX: prefix,
			ELASTIC_CHILDREN: String(children),
			ELASTIC_STEPS: String(steps),
			ELASTIC_PAYLOAD_BYTES: String(payload),
			ELASTIC_STAGE_MS: String(args["stage-ms"] ?? 0),
			ELASTIC_ROOT_WORKERS: "1",
			ELASTIC_RESULT_FILE: resultFile,
		}, log);
		processes.push(root);
		const exited = new Promise((resolve) => root.on("exit", resolve));
		const runStart = Date.now();
		// --kill-after-ms: SIGKILL the last host's whole process group (host and its workers) mid-run, as a VM dying.
		const killAfter = args["kill-after-ms"] === undefined ? undefined : Number(args["kill-after-ms"]);
		let killedAt;
		const killer = killAfter === undefined ? undefined : setTimeout(() => {
			killedAt = Date.now() - runStart;
			killGroup(processes[hosts - 1], "SIGKILL");
			process.stderr.write(`[${hosts} hosts] killed host h${hosts - 1} at +${killedAt} ms\n`);
		}, killAfter);
		let code;
		for (;;) {
			code = await Promise.race([exited, sleep(PROGRESS_MS).then(() => "tick")]);
			if (code !== "tick") break;
			const progress = await probe(`http://127.0.0.1:${port}`, progressQueries(prefix));
			process.stderr.write(`[${hosts} hosts] +${Math.round((Date.now() - runStart) / 1000)}s ${JSON.stringify(progress)}\n`);
			if (Date.now() - runStart > RUN_TIMEOUT_MS) {
				const write = await probe(`http://127.0.0.1:${port}`, { write: "CREATE TABLE IF NOT EXISTS zz_probe(x)" }, 15_000);
				const stats = existsSync(join(work, "sqld/dbs/default/stats.json"))
					? JSON.parse(readFileSync(join(work, "sqld/dbs/default/stats.json"), "utf8"))
					: null;
				killGroup(root, "SIGKILL");
				// Whether the server recovers once every client is gone: a store stuck inside sqld stays stuck.
				for (const p of processes) killGroup(p, "SIGKILL");
				await sleep(20_000);
				const writeAfterClientsGone = await probe(`http://127.0.0.1:${port}`, { write: "CREATE TABLE IF NOT EXISTS zz_probe2(x)" }, 15_000);
				return {
					writeAfterClientsGone,
					hosts, slots, proxyOneWayMs: latencyMs, hostsReadyMs, status: "stalled", runTimeoutMs: RUN_TIMEOUT_MS,
					progress, writeProbe: write, trace: traced ? analyze(traced.records) : null, pendingAtStall: traced ? traced.pending() : null, sqldSlowest: stats?.slowest_queries ?? null,
					sqldLogTail: sqldLog.join("").slice(-3000), logTail: log.join("").slice(-3000),
				};
			}
		}
		clearTimeout(killer);
		if (code !== 0 || !existsSync(resultFile)) throw new Error(`root exited ${code}\n${log.join("").slice(-4000)}`);
		const result = JSON.parse(readFileSync(resultFile, "utf8"));
		const stats = existsSync(join(work, "sqld/dbs/default/stats.json")) ? JSON.parse(readFileSync(join(work, "sqld/dbs/default/stats.json"), "utf8")) : null;
		return { killedHostAtMs: killedAt ?? null, trace: traced ? analyze(traced.records) : null, sqldQueryCount: stats?.query_count ?? null, sqldSlowest: stats?.slowest_queries?.slice(-3) ?? null, hosts, slots, proxyOneWayMs: latencyMs, hostsReadyMs, ...summarize(result) };
	} finally {
		for (const p of processes) killGroup(p, "SIGINT");
		await sleep(3000);
		for (const p of processes) killGroup(p, "SIGKILL");
		killGroup(db, "SIGKILL");
		front?.close();
		traced?.close();
		if (args.keep !== "1") rmSync(work, { recursive: true, force: true });
	}
}

const trials = [];
for (const hosts of hostCounts) {
	const result = await trial(hosts).catch((error) => ({ hosts, status: "error", error: String(error?.message ?? error).slice(0, 4000) }));
	process.stderr.write(`${JSON.stringify({ ...result, perHost: undefined, sqldLogTail: undefined, logTail: undefined })}\n`);
	trials.push(result);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify({ sqldArgs: args["sqld-args"] ?? null, slots, children, steps, payload, proxyOneWayMs: latencyMs, trials }, null, 2));
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ machine: { cpus: (await import("node:os")).cpus().length }, slots, children, steps, payload, proxyOneWayMs: latencyMs, trials }, null, 2));
process.stderr.write(`wrote ${out}\n`);
