#!/usr/bin/env bun
/**
 * Writer-queue wait of heavy pooled roots: one root alone, three roots sharing one journal file (the default before
 * the journal store, and the reason campaigns were split over hand-made journals), and three roots in the journal
 * store. Each root runs `--workers` pool processes that append `--appends` checkpoints of `--payload` bytes to the
 * database holding the root, all at once. The wait of one append is the time from the call to its commit.
 *
 *   bun run scripts/perf/journal-store/benchmark.ts [--workers 8] [--appends 300] [--payload 2048] [--repeats 3] [--out report.json]
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
}

interface Measurement {
	readonly scenario: string;
	readonly roots: number;
	readonly appends: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly max: number;
	readonly meanWaitMs: number;
	readonly wallMs: number;
	readonly appendsPerSecond: number;
}

const WRITER = resolve(import.meta.dir, "writer.ts");
const SCENARIOS = [
	{ scenario: "one root alone", roots: 1, mode: "file" },
	{ scenario: "three roots, one journal file (before)", roots: 3, mode: "file" },
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
		repeats: Number(value("repeats") ?? "3"),
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
		const target = scenario.mode === "store" ? join(directory, "journal") : join(directory, "journal.sqlite");
		const peers = scenario.roots * options.workers;
		const ready = join(directory, "ready");
		const results = await Promise.all(
			Array.from({ length: scenario.roots }, (_, root) =>
				Array.from({ length: options.workers }, (_, worker) =>
					writer([
						scenario.mode,
						target,
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
for (let repeat = 0; repeat < options.repeats; repeat++)
	for (const scenario of SCENARIOS) runs.push(await measure(options, scenario, repeat));
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
		meanWaitMs: median(of.map((run) => run.meanWaitMs)),
		appendsPerSecond: median(of.map((run) => run.appendsPerSecond)),
	};
});
const report = { options, cpus: navigator.hardwareConcurrency, summary, runs };
if (options.out !== undefined) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(
	`workers per root ${options.workers}, appends per worker ${options.appends}, payload ${options.payload} B, median of ${options.repeats}`,
);
console.log("| scenario | appends | wait p50 ms | p95 ms | p99 ms | max ms | mean ms | appends/s |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const row of summary)
	console.log(
		`| ${row.scenario} | ${row.appendsPerRun} | ${row.p50.toFixed(2)} | ${row.p95.toFixed(2)} | ${row.p99.toFixed(2)} | ${row.max.toFixed(1)} | ${row.meanWaitMs.toFixed(2)} | ${row.appendsPerSecond.toFixed(0)} |`,
	);
