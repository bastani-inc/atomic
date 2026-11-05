#!/usr/bin/env bun
/**
 * Multi-process benchmark for the cross-process SQLite writers' queue (#4316).
 *
 * Starts several writer processes on one fresh database, lets them run a fixed workload for a warm-up and a measured
 * window, and reports how busy the write lock was, the commit and transaction rates, how many transactions each
 * commit carried, and how long transactions waited for the lock. Each scenario runs against every variant, in
 * interleaved order and repeated, on the same machine:
 *
 * - `baseline`: the node-sqlite adapter as of `--baseline` (default 77746f5, before #4316), copied out of git;
 * - `current@<ms>`: the adapter in this checkout, with `groupCommitHoldMs` set to each `--holds` value.
 *
 * Every variant does the same work with the same durability settings. Lock-held time is measured inside each writer
 * from the connection's own `BEGIN IMMEDIATE` to its COMMIT or ROLLBACK (see worker.mjs), summed over writers, and
 * clipped to the measured window, so utilization = held time / window. A transaction's lock wait runs from its
 * `transaction()` call to its callback starting; with one transaction in flight per process (the `serial` scenario)
 * it is the per-ticket wait.
 *
 *   bun run scripts/perf/writer-queue/benchmark.ts --repeats 3 --out /tmp/writer-queue.json
 *
 * Options: --scenarios uncontended,serial-30,bursty-8x16,pool-like,heavy-batches  --holds 25,50,100,200,400  --warmup 1000
 * --measure 8000  --baseline <git revision>  --runtime node|bun  --out <file>
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

interface ProcessSpec {
	readonly count: number;
	readonly lanes: number;
	readonly busyMs: number;
	readonly thinkMs: number;
}

interface Scenario {
	readonly name: string;
	readonly description: string;
	readonly processes: readonly ProcessSpec[];
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: "uncontended",
		description: "1 process, 1 transaction at a time",
		processes: [{ count: 1, lanes: 1, busyMs: 0.5, thinkMs: 0 }],
	},
	{
		name: "serial-30",
		description: "30 processes, 1 transaction at a time each",
		processes: [{ count: 30, lanes: 1, busyMs: 0.5, thinkMs: 0 }],
	},
	{
		name: "bursty-8x16",
		description: "8 processes, 16 transactions in flight each",
		processes: [{ count: 8, lanes: 16, busyMs: 0.5, thinkMs: 0 }],
	},
	{
		name: "pool-like",
		description: "3 coordinators x 32 in flight, a parent x 8, 26 workers writing every ~100 ms (#4312 host A)",
		processes: [
			{ count: 3, lanes: 32, busyMs: 0.5, thinkMs: 0 },
			{ count: 1, lanes: 8, busyMs: 1, thinkMs: 0 },
			{ count: 26, lanes: 1, busyMs: 0.5, thinkMs: 100 },
		],
	},
	{
		name: "heavy-batches",
		description:
			"3 coordinators x 64 in flight at 2 ms of work each (128 ms per full batch, so the hold budget splits it), 10 workers writing every ~50 ms",
		processes: [
			{ count: 3, lanes: 64, busyMs: 2, thinkMs: 0 },
			{ count: 10, lanes: 1, busyMs: 0.5, thinkMs: 50 },
		],
	},
];

interface Options {
	readonly scenarios: readonly Scenario[];
	readonly holds: readonly number[];
	readonly repeats: number;
	readonly warmupMs: number;
	readonly measureMs: number;
	readonly baseline: string;
	readonly runtime: "node" | "bun";
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	const names = (value("scenarios") ?? SCENARIOS.map((scenario) => scenario.name).join(",")).split(",");
	const scenarios = names.map((name) => {
		const scenario = SCENARIOS.find((candidate) => candidate.name === name);
		if (scenario === undefined) throw new Error(`Unknown scenario ${name}`);
		return scenario;
	});
	const runtime = value("runtime") ?? "node";
	if (runtime !== "node" && runtime !== "bun") throw new Error(`Unknown runtime ${runtime}`);
	return {
		scenarios,
		holds: (value("holds") ?? "25,50,100,200,400").split(",").map(Number),
		repeats: Number(value("repeats") ?? "3"),
		warmupMs: Number(value("warmup") ?? "1000"),
		measureMs: Number(value("measure") ?? "8000"),
		baseline: value("baseline") ?? "77746f5",
		runtime,
		...(value("out") === undefined ? {} : { out: resolve(value("out")!) }),
	};
}

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const storagePath = "packages/coding-agent/src/core/storage";
const worker = fileURLToPath(new URL("./worker.mjs", import.meta.url));

function git(args: readonly string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: repository });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

/** The storage directory's top-level sources at a revision, copied where workers can load them. */
function materialize(revision: string, into: string): string {
	const directory = join(into, `storage-${revision}`);
	mkdirSync(directory, { recursive: true });
	for (const name of git(["ls-tree", "--name-only", `${revision}:${storagePath}`]).split("\n")) {
		if (!name.endsWith(".ts")) continue;
		writeFileSync(join(directory, name), git(["show", `${revision}:${storagePath}/${name}`]));
	}
	return directory;
}

interface Variant {
	readonly name: string;
	readonly storage: string;
	readonly groupCommitHoldMs?: number;
}

interface WorkerReport {
	readonly label: string;
	readonly holds: readonly (readonly [number, number])[];
	readonly commits: readonly number[];
	readonly transactions: readonly (readonly [number, number, number])[];
	readonly failures: number;
}

interface GroupSample {
	readonly transactionsPerSecond: number;
	readonly waitP50Ms: number;
	readonly waitP95Ms: number;
}

interface Sample {
	/** Per process group of the scenario, in its order: what each kind of writer got. */
	readonly groups: readonly GroupSample[];
	readonly utilization: number;
	readonly commitsPerSecond: number;
	readonly transactionsPerSecond: number;
	readonly transactionsPerCommit: number;
	readonly waitP50Ms: number;
	readonly waitP95Ms: number;
	readonly waitP99Ms: number;
	readonly waitMaxMs: number;
	readonly failures: number;
}

function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function lines(child: ReturnType<typeof spawn>): () => Promise<string> {
	let buffered = "";
	const waiting: ((line: string) => void)[] = [];
	const queued: string[] = [];
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffered += chunk;
		for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
			const line = buffered.slice(0, end);
			buffered = buffered.slice(end + 1);
			const next = waiting.shift();
			if (next === undefined) queued.push(line);
			else next(line);
		}
	});
	return () => {
		const line = queued.shift();
		return line === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(line);
	};
}

async function runOnce(scenario: Scenario, variant: Variant, options: Options, scratch: string): Promise<Sample> {
	const directory = mkdtempSync(join(scratch, `${scenario.name}-`));
	const path = join(directory, "bench.sqlite");
	const setup = new DatabaseSync(path);
	setup.exec(
		"PRAGMA journal_mode = WAL; CREATE TABLE bench(id INTEGER PRIMARY KEY, writer TEXT NOT NULL, lane INTEGER NOT NULL, seq INTEGER NOT NULL)",
	);
	setup.close();
	const workers: {
		child: ReturnType<typeof spawn>;
		next: () => Promise<string>;
		exited: Promise<unknown>;
		group: number;
	}[] = [];
	let index = 0;
	for (const [group, spec] of scenario.processes.entries())
		for (let copy = 0; copy < spec.count; copy++) {
			const label = `p${index++}`;
			const child = spawn(
				options.runtime === "node" ? (process.env.NODE ?? "node") : process.execPath,
				[
					worker,
					variant.storage,
					path,
					JSON.stringify({ ...spec, label, groupCommitHoldMs: variant.groupCommitHoldMs }),
				],
				{ stdio: ["pipe", "pipe", "inherit"], cwd: repository },
			);
			workers.push({
				child,
				next: lines(child),
				exited: new Promise((resolve) => child.once("exit", resolve)),
				group,
			});
		}
	for (const { next } of workers) if ((await next()) !== "ready") throw new Error("worker failed to start");
	const startAt = Date.now() + 500;
	const measureFrom = startAt + options.warmupMs;
	const endAt = measureFrom + options.measureMs;
	for (const { child } of workers) child.stdin!.end(`go ${startAt} ${endAt}\n`);
	const reports = await Promise.all(workers.map(async ({ next }) => JSON.parse(await next()) as WorkerReport));
	await Promise.all(workers.map(({ exited }) => exited));

	const clip = (start: number, end: number) => Math.max(0, Math.min(end, endAt) - Math.max(start, measureFrom));
	let heldMs = 0;
	let commits = 0;
	let transactions = 0;
	let failures = 0;
	let recorded = 0;
	const waits: number[] = [];
	const groupWaits = scenario.processes.map((): number[] => []);
	const groupTransactions = scenario.processes.map(() => 0);
	for (const [index, report] of reports.entries()) {
		const group = workers[index]!.group;
		for (const [start, end] of report.holds) heldMs += clip(start, end);
		commits += report.commits.filter((at) => at >= measureFrom && at < endAt).length;
		for (const [called, started, ended] of report.transactions) {
			if (ended >= measureFrom && ended < endAt) {
				transactions += 1;
				groupTransactions[group]! += 1;
			}
			if (started >= measureFrom && started < endAt) {
				waits.push(started - called);
				groupWaits[group]!.push(started - called);
			}
		}
		recorded += report.transactions.length;
		failures += report.failures;
	}
	const check = new DatabaseSync(path, { readOnly: true });
	const rows = Number((check.prepare("SELECT COUNT(*) AS count FROM bench").get() as { count: number }).count);
	const integrity = (check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
	check.close();
	if (rows !== recorded) throw new Error(`${rows} rows for ${recorded} reported transactions`);
	if (integrity !== "ok") throw new Error(`integrity_check: ${integrity}`);
	rmSync(directory, { recursive: true, force: true });
	waits.sort((a, b) => a - b);
	const seconds = options.measureMs / 1000;
	return {
		groups: groupWaits.map((group, index) => {
			group.sort((a, b) => a - b);
			return {
				transactionsPerSecond: groupTransactions[index]! / seconds,
				waitP50Ms: percentile(group, 50),
				waitP95Ms: percentile(group, 95),
			};
		}),
		utilization: heldMs / options.measureMs,
		commitsPerSecond: commits / seconds,
		transactionsPerSecond: transactions / seconds,
		transactionsPerCommit: commits === 0 ? 0 : transactions / commits,
		waitP50Ms: percentile(waits, 50),
		waitP95Ms: percentile(waits, 95),
		waitP99Ms: percentile(waits, 99),
		waitMaxMs: waits.at(-1) ?? 0,
		failures,
	};
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const options = parseOptions(process.argv.slice(2));
const scratch = mkdtempSync(join(tmpdir(), "writer-queue-bench-"));
const variants: Variant[] = [
	{ name: "baseline", storage: materialize(options.baseline, scratch) },
	...options.holds.map((holdMs) => ({
		name: `current@${holdMs}`,
		storage: join(repository, storagePath),
		groupCommitHoldMs: holdMs,
	})),
];
const results: Record<string, Record<string, Sample[]>> = {};
for (let repeat = 0; repeat < options.repeats; repeat++)
	for (const scenario of options.scenarios) {
		// Interleave variants, rotating which goes first, so drift on the machine falls on all of them alike.
		const order = variants.map((_, index) => variants[(index + repeat) % variants.length]!);
		for (const variant of order) {
			const sample = await runOnce(scenario, variant, options, scratch);
			const byVariant = results[scenario.name] ?? {};
			results[scenario.name] = byVariant;
			byVariant[variant.name] = [...(byVariant[variant.name] ?? []), sample];
			console.error(
				`${scenario.name} ${variant.name} #${repeat + 1}: utilization ${(sample.utilization * 100).toFixed(1)}% commits/s ${sample.commitsPerSecond.toFixed(0)} tx/s ${sample.transactionsPerSecond.toFixed(0)} wait p50 ${sample.waitP50Ms.toFixed(1)} p95 ${sample.waitP95Ms.toFixed(1)} ms`,
			);
		}
	}
rmSync(scratch, { recursive: true, force: true });

const environment = {
	date: new Date().toISOString(),
	runtime: options.runtime,
	node: Bun.spawnSync([process.env.NODE ?? "node", "--version"])
		.stdout.toString()
		.trim(),
	bun: Bun.version,
	cpus: navigator.hardwareConcurrency,
	baseline: git(["rev-parse", options.baseline]).trim(),
	current: `${git(["rev-parse", "HEAD"]).trim()}${git(["status", "--porcelain", storagePath]).trim() === "" ? "" : " (with uncommitted storage changes)"}`,
	repeats: options.repeats,
	warmupMs: options.warmupMs,
	measureMs: options.measureMs,
};
const table = [
	"| scenario | variant | lock utilization | commits/s | transactions/s | transactions/commit | wait p50 ms | wait p95 ms | wait p99 ms | wait max ms | failures | per group: tx/s, wait p50/p95 ms |",
	"|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
];
for (const scenario of options.scenarios)
	for (const variant of variants) {
		const samples = results[scenario.name]![variant.name]!;
		const m = (pick: (sample: Sample) => number) => median(samples.map(pick));
		table.push(
			`| ${scenario.name} | ${variant.name} | ${(m((s) => s.utilization) * 100).toFixed(1)}% | ${m((s) => s.commitsPerSecond).toFixed(0)} | ${m((s) => s.transactionsPerSecond).toFixed(0)} | ${m((s) => s.transactionsPerCommit).toFixed(1)} | ${m((s) => s.waitP50Ms).toFixed(1)} | ${m((s) => s.waitP95Ms).toFixed(1)} | ${m((s) => s.waitP99Ms).toFixed(1)} | ${m((s) => s.waitMaxMs).toFixed(0)} | ${m((s) => s.failures)} | ${scenario.processes.map((_, group) => `${m((s) => s.groups[group]!.transactionsPerSecond).toFixed(0)}, ${m((s) => s.groups[group]!.waitP50Ms).toFixed(1)}/${m((s) => s.groups[group]!.waitP95Ms).toFixed(1)}`).join("; ")} |`,
		);
	}
console.log(JSON.stringify(environment, null, 2));
console.log(table.join("\n"));
if (options.out !== undefined) {
	mkdirSync(dirname(options.out), { recursive: true });
	writeFileSync(options.out, `${JSON.stringify({ environment, scenarios: SCENARIOS, results }, null, 2)}\n`);
}
