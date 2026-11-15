#!/usr/bin/env bun
/**
 * Multi-process benchmark of the worker pool's hot path on PostgreSQL (#5102): one root, N worker host processes with
 * `--slots` workers each, all on one server, through the shipped stores (`SqlRunJournal`, `SqlPoolQueue`,
 * `SqlPoolUsage`) and the shipped adapter, as a shared pool's root and hosts run them.
 *
 * Each trial queues `hosts × slots × --children-per-slot` children, starts every host at once, and lets each worker
 * claim a child, commit `--steps` tool checkpoints of `--payload` characters with a heartbeat (lease extension and a
 * usage report) every `--heartbeat-ms`, and complete it, until nothing is ready. The root renews its lease every
 * `--renew-ms` meanwhile. Two scenarios:
 *
 * - `claim`: no checkpoints and many children per slot, so the run is claims and completions: claim throughput.
 * - `checkpoint`: the #4768 shape, 2 children per slot × 20 checkpoints: commit throughput and latency.
 *
 * After each trial the root checks the invariants: every child claimed exactly once and completed, one event per
 * checkpoint key, and a dense event sequence. A trial that breaks one is reported as such.
 *
 *   bun run scripts/perf/postgres-pool/benchmark.ts --url postgresql://postgres@127.0.0.1:5432/postgres \
 *     --password-file /tmp/pgpw --hosts 8,16,32 --out /tmp/postgres-pool.json
 *
 * Options: --scenarios claim,checkpoint  --hosts 8,16,32  --slots 4  --label <name>  --claim-children 16
 * --checkpoint-children 2  --steps 20  --payload 256  --heartbeat-ms 7500  --renew-ms 5000  --lease-ms 30000
 * The server needs `max_connections` of at least hosts × (slots + 2) + 10.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { JournalDurableBackend } from "../../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../../packages/workflows/src/durable/journal/types.js";
import { type Connection, child, openDatabase, ROOT, readPassword, summarize } from "./shared.js";

const KNOWN = [
	"url",
	"password-file",
	"scenarios",
	"hosts",
	"slots",
	"label",
	"claim-children",
	"checkpoint-children",
	"steps",
	"payload",
	"heartbeat-ms",
	"renew-ms",
	"lease-ms",
	"out",
] as const;

function parseFlags(argv: readonly string[]): ReadonlyMap<string, string> {
	const flags = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index]!.replace(/^--/, "");
		const value = argv[index + 1];
		if (!(KNOWN as readonly string[]).includes(name) || value === undefined)
			throw new Error(
				`Unknown or incomplete option ${argv[index]}; supported: ${KNOWN.map((k) => `--${k}`).join(" ")}`,
			);
		flags.set(name, value);
	}
	return flags;
}

const flags = parseFlags(process.argv.slice(2));
const number = (name: string, fallback: number) => {
	const value = Number(flags.get(name) ?? fallback);
	if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
	return value;
};
const url = flags.get("url") ?? process.env.ATOMIC_BENCH_POSTGRES_URL;
if (url === undefined) throw new Error("Pass --url or set ATOMIC_BENCH_POSTGRES_URL");
const connection: Connection = { url, password: readPassword(flags.get("password-file")) };
const hostCounts = (flags.get("hosts") ?? "8,16,32").split(",").map(Number);
const scenarios = (flags.get("scenarios") ?? "claim,checkpoint").split(",");
const slots = number("slots", 4);
const heartbeatMs = number("heartbeat-ms", 7500);
const renewMs = number("renew-ms", 5000);
const leaseMs = number("lease-ms", 30_000);
const payload = number("payload", 256);
const hostScript = fileURLToPath(new URL("./host.ts", import.meta.url));

interface HostResult {
	readonly host: number;
	readonly claims: number[];
	readonly emptyClaims: number[];
	readonly commits: number[];
	readonly completes: number[];
	readonly heartbeats: number[];
	readonly commitTimes: number[];
	readonly errors: Record<string, number>;
	readonly claimed: { id: string; generation: number }[];
}

function startHost(settings: object) {
	const child = spawn(process.execPath, ["run", hostScript], {
		env: { ...process.env, BENCH_HOST: JSON.stringify(settings) },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const lines = createInterface({ input: child.stdout! });
	const queued: string[] = [];
	const waiting: ((line: string) => void)[] = [];
	lines.on("line", (line) => {
		const next = waiting.shift();
		if (next) next(line);
		else queued.push(line);
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	const line = () =>
		new Promise<string>((resolve, reject) => {
			const queuedLine = queued.shift();
			if (queuedLine !== undefined) return resolve(queuedLine);
			waiting.push(resolve);
			void exited.then((code) => reject(new Error(`A host exited with ${code} before it reported`)));
		});
	return { child, line, exited };
}

/** Drops every table and trigger function a trial created under `prefix`. */
async function dropPrefix(prefix: string): Promise<void> {
	const database = await openDatabase(connection, 1);
	try {
		const tables = await database.all<{ name: string }>(
			"SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND starts_with(tablename, ?)",
			prefix,
		);
		if (tables.length > 0)
			await database.exec(`DROP TABLE IF EXISTS ${tables.map((t) => t.name).join(", ")} CASCADE`);
		const functions = await database.all<{ name: string }>(
			"SELECT proname AS name FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND starts_with(proname, ?)",
			prefix,
		);
		for (const fn of functions) await database.exec(`DROP FUNCTION IF EXISTS ${fn.name}() CASCADE`);
	} finally {
		await database.close();
	}
}

async function trial(scenario: string, hosts: number) {
	const childrenPerSlot = scenario === "claim" ? number("claim-children", 16) : number("checkpoint-children", 2);
	const steps = scenario === "claim" ? 0 : number("steps", 20);
	const children = hosts * slots * childrenPerSlot;
	const prefix = `b${randomBytes(4).toString("hex")}_`;
	const database = await openDatabase(connection, 4);
	const journal = await SqlRunJournal.open(database, { prefix });
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	try {
		await backend.commitWorkflowRegistration({
			workflowId: ROOT,
			name: ROOT,
			inputs: {},
			createdAt: 0,
			status: "running",
		});
		const acquired = await journal.acquire(ROOT, backend.holderId);
		if (acquired.status !== "acquired") throw new Error("The root did not get its lease");
		const lease: Lease = acquired.lease;
		const queue = await openSqlPoolQueue(journal);
		await queue.initialize(lease, 60_000);
		for (let index = 0; index < children; index++) {
			const { work, boundary } = child(index);
			await queue.enqueue(lease, work, boundary);
		}
		const started = Array.from({ length: hosts }, (_, host) =>
			startHost({ connection, prefix, lease, host, slots, steps, payload, leaseMs, heartbeatMs }),
		);
		for (const host of started) if ((await host.line()) !== "ready") throw new Error("A host did not start");
		const renewals: number[] = [];
		let renewing = true;
		const renewer = (async () => {
			while (renewing) {
				await new Promise((resolve) => setTimeout(resolve, renewMs));
				const at = performance.now();
				await journal.renew(lease);
				renewals.push(performance.now() - at);
			}
		})();
		const start = Date.now();
		for (const host of started) host.child.stdin!.write("go\n");
		const results = (await Promise.all(started.map((host) => host.line()))).map(
			(line) => JSON.parse(line) as HostResult,
		);
		const wallMs = Date.now() - start;
		await Promise.all(started.map((host) => host.exited));
		renewing = false;
		await renewer;

		const runs = `${prefix}wf_runs`;
		const events = `${prefix}wf_events`;
		const [states, duplicateKeys, sequence, generations] = await Promise.all([
			database.all<{ state: string; n: number }>(`SELECT state, COUNT(*) AS n FROM ${runs}_work GROUP BY state`),
			database.get<{ n: number }>(
				`SELECT COUNT(*) AS n FROM (SELECT key FROM ${events} WHERE run_id = ? AND key IS NOT NULL GROUP BY key HAVING COUNT(*) > 1) d`,
				ROOT,
			),
			database.get<{ events: number; last: number }>(
				`SELECT COUNT(*) AS events, COALESCE(MAX(seq), 0) AS last FROM ${events} WHERE run_id = ?`,
				ROOT,
			),
			database.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${runs}_work WHERE generation != 1`),
		]);
		const all = (pick: (result: HostResult) => number[]) => results.flatMap(pick);
		const claimedIds = results.flatMap((result) => result.claimed.map((claim) => claim.id));
		const errors: Record<string, number> = {};
		for (const result of results)
			for (const [name, count] of Object.entries(result.errors)) errors[name] = (errors[name] ?? 0) + count;
		const commitTimes = all((result) => result.commitTimes).sort((a, b) => a - b);
		const largestGapMs = commitTimes.reduce(
			(gap, time, index) => (index === 0 ? gap : Math.max(gap, time - commitTimes[index - 1]!)),
			0,
		);
		const completed = states.find((row) => row.state === "completed")?.n ?? 0;
		const invariants = {
			everyChildCompleted: Number(completed) === children,
			claimedOnce: claimedIds.length === children && new Set(claimedIds).size === children,
			firstGenerationOnly: Number(generations?.n) === 0,
			oneEventPerKey: Number(duplicateKeys?.n) === 0,
			denseSequence: Number(sequence?.events) === Number(sequence?.last),
		};
		const seconds = wallMs / 1000;
		return {
			scenario,
			hosts,
			slots,
			children,
			steps,
			wallMs,
			claimsPerSecond: Math.round((claimedIds.length / seconds) * 10) / 10,
			commitsPerSecond: Math.round((all((result) => result.commits).length / seconds) * 10) / 10,
			claim: summarize(all((result) => result.claims)),
			emptyClaim: summarize(all((result) => result.emptyClaims)),
			commit: summarize(all((result) => result.commits)),
			complete: summarize(all((result) => result.completes)),
			heartbeat: summarize(all((result) => result.heartbeats)),
			rootRenew: summarize(renewals),
			largestCommitGapMs: largestGapMs,
			errors,
			invariants,
			ok: Object.values(invariants).every(Boolean),
		};
	} finally {
		await backend.close();
		await journal.close();
		await database.close();
		await dropPrefix(prefix);
	}
}

const label = flags.get("label") ?? "current";
const trials = [];
for (const scenario of scenarios)
	for (const hosts of hostCounts) {
		const result = await trial(scenario, hosts);
		trials.push({ label, ...result });
		const { claim, commit, rootRenew } = result;
		console.log(
			`${label} ${scenario} ${hosts}x${slots}: ${result.claimsPerSecond} claims/s (p50 ${claim.p50} p99 ${claim.p99} ms), ${result.commitsPerSecond} commits/s (p50 ${commit.p50} p99 ${commit.p99} ms), root renew max ${rootRenew.max} ms, errors ${JSON.stringify(result.errors)}, ${result.ok ? "invariants hold" : `INVARIANTS BROKEN ${JSON.stringify(result.invariants)}`}`,
		);
	}
const out = flags.get("out");
if (out !== undefined) writeFileSync(out, `${JSON.stringify({ label, trials }, null, 2)}\n`);
if (trials.some((trial) => !trial.ok)) process.exitCode = 1;
