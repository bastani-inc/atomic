#!/usr/bin/env bun
/**
 * Writer-queue wait of heavy pooled roots: one root alone, three roots sharing one journal file (the default before
 * the journal store), three roots with one hand-made journal file each (the same load and process count as the store,
 * and what campaigns did by hand), and three roots in the journal store. Each root runs `--workers` pool processes that append `--appends` checkpoints of `--payload` bytes to the
 * database holding the root, all at once. The wait of one append is the time from the call to its commit, which
 * includes the commit and its fsync. The lock wait is the part spent waiting for the database's write lock, read from
 * each process's writer-queue statistics: the median of the processes' median waits, and of their 95th percentiles.
 * The repeats start the scenarios in a rotating order, and the median of the repeats is reported with the smallest
 * and the largest lock-wait median among them.
 *
 *   bun run scripts/perf/journal-store/benchmark.ts [--workers 8] [--appends 300] [--payload 2048] [--repeats 7] [--out report.json]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface Options {
	readonly workers: number;
	readonly appends: number;
	readonly payload: number;
	readonly repeats: number;
	readonly out?: string;
}

interface WriterResult {
	readonly root: string;
	readonly worker: string;
	readonly waits: readonly number[];
	readonly elapsedMs: number;
	readonly lockWait: { readonly p50: number; readonly p95: number };
}

interface Measurement {
	readonly scenario: string;
	readonly roots: number;
	readonly appends: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly max: number;
	readonly lockWaitP50: number;
	readonly lockWaitP95: number;
	readonly meanWaitMs: number;
	readonly wallMs: number;
	readonly appendsPerSecond: number;
}

const WRITER = resolve(import.meta.dir, "writer.ts");
const SCENARIOS = [
	{ scenario: "one root alone", roots: 1, mode: "file" },
	{ scenario: "three roots, one journal file (before)", roots: 3, mode: "file" },
	{ scenario: "three roots, one hand-made journal file each (load-matched)", roots: 3, mode: "files" },
	{ scenario: "three roots, journal store (after)", roots: 3, mode: "store" },
] as const;

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		workers: Number(value("workers") ?? "8"),
		appends: Number(value("appends") ?? "300"),
		payload: Number(value("payload") ?? "2048"),
		repeats: Number(value("repeats") ?? "7"),
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

function writer(args: readonly string[]): Promise<WriterResult> {
	return new Promise((resolveResult, reject) => {
		const child = spawn(process.execPath, [WRITER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("exit", (code) => {
			if (code !== 0) reject(new Error(`writer exited ${code}: ${stderr}`));
			else resolveResult(JSON.parse(stdout.trim().split("\n").at(-1)!) as WriterResult);
		});
	});
}

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function measure(options: Options, scenario: (typeof SCENARIOS)[number], repeat: number): Promise<Measurement> {
	const directory = mkdtempSync(join(tmpdir(), "journal-store-bench-"));
	try {
		const targetOf = (root: number): string =>
			scenario.mode === "store"
				? join(directory, "journal")
				: scenario.mode === "files"
					? join(directory, `journal-${root}.sqlite`)
					: join(directory, "journal.sqlite");
		const peers = scenario.roots * options.workers;
		const ready = join(directory, "ready");
		const results = await Promise.all(
			Array.from({ length: scenario.roots }, (_, root) =>
				Array.from({ length: options.workers }, (_, worker) =>
					writer([
						scenario.mode === "files" ? "file" : scenario.mode,
						targetOf(root),
						`root-${repeat}-${root}`,
						String(worker),
						String(options.appends),
						String(options.payload),
						ready,
						String(peers),
					]),
				),
			).flat(),
		);
		const wallMs = Math.max(...results.map((result) => result.elapsedMs));
		const waits = results.flatMap((result) => result.waits).sort((left, right) => left - right);
		return {
			scenario: scenario.scenario,
			roots: scenario.roots,
			appends: waits.length,
			p50: percentile(waits, 0.5),
			p95: percentile(waits, 0.95),
			p99: percentile(waits, 0.99),
			max: waits.at(-1)!,
			lockWaitP50: median(results.map((result) => result.lockWait.p50)),
			lockWaitP95: median(results.map((result) => result.lockWait.p95)),
			meanWaitMs: waits.reduce((sum, wait) => sum + wait, 0) / waits.length,
			wallMs,
			appendsPerSecond: (waits.length / wallMs) * 1000,
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)]!;
}

const options = parseOptions(process.argv.slice(2));
const runs: Measurement[] = [];
for (let repeat = 0; repeat < options.repeats; repeat++) {
	// Each repeat starts the scenarios in a different order, so none always runs first on a cold or warm machine.
	const order = [...SCENARIOS.slice(repeat % SCENARIOS.length), ...SCENARIOS.slice(0, repeat % SCENARIOS.length)];
	for (const scenario of order) runs.push(await measure(options, scenario, repeat));
}
const summary = SCENARIOS.map((scenario) => {
	const of = runs.filter((run) => run.scenario === scenario.scenario);
	return {
		scenario: scenario.scenario,
		roots: scenario.roots,
		appendsPerRun: of[0]!.appends,
		p50: median(of.map((run) => run.p50)),
		p95: median(of.map((run) => run.p95)),
		p99: median(of.map((run) => run.p99)),
		max: median(of.map((run) => run.max)),
		lockWaitP50: median(of.map((run) => run.lockWaitP50)),
		lockWaitP50Min: Math.min(...of.map((run) => run.lockWaitP50)),
		lockWaitP50Max: Math.max(...of.map((run) => run.lockWaitP50)),
		lockWaitP95: median(of.map((run) => run.lockWaitP95)),
		meanWaitMs: median(of.map((run) => run.meanWaitMs)),
		appendsPerSecond: median(of.map((run) => run.appendsPerSecond)),
	};
});
const report = { options, cpus: navigator.hardwareConcurrency, summary, runs };
if (options.out !== undefined) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	`workers per root ${options.workers}, appends per worker ${options.appends}, payload ${options.payload} B, median of ${options.repeats}`,
);
console.log(
	"| scenario | appends | append p50 ms | p95 ms | p99 ms | max ms | mean ms | lock wait p50 ms (min-max) | lock wait p95 ms | appends/s |",
);
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of summary)
	console.log(
		`| ${row.scenario} | ${row.appendsPerRun} | ${row.p50.toFixed(2)} | ${row.p95.toFixed(2)} | ${row.p99.toFixed(2)} | ${row.max.toFixed(1)} | ${row.meanWaitMs.toFixed(2)} | ${row.lockWaitP50.toFixed(2)} (${row.lockWaitP50Min.toFixed(2)}-${row.lockWaitP50Max.toFixed(2)}) | ${row.lockWaitP95.toFixed(2)} | ${row.appendsPerSecond.toFixed(0)} |`,
	);
