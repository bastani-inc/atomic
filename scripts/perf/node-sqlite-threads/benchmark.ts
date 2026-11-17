#!/usr/bin/env bun
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "../../../packages/coding-agent/src/core/storage/database.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";

const SEQUENTIAL_APPENDS = 200;
const CONCURRENT_APPENDS = 64;
const LARGE_APPENDS = 50;
const POINT_READS = 1_000;

interface Options {
	readonly rounds: number;
	/** Processes that keep a CPU busy for the whole run, as a loaded machine. */
	readonly load: number;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		rounds: Number(value("rounds") ?? "5"),
		load: Number(value("load") ?? "0"),
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

/**
 * The longest block of the event loop, from a 1 ms timer's lateness. A timer rather than a `setImmediate` chain: the
 * loop sleeps between turns, as the interactive host's does, so a reply from a connection's thread has to wake it.
 * A loop kept busy never sleeps and hides that wake-up, which on a busy Windows host is most of a request's time.
 */
class TurnProbe {
	private readonly histogram = monitorEventLoopDelay({ resolution: 1 });

	constructor() {
		this.histogram.enable();
	}

	reset(): void {
		this.histogram.reset();
	}

	async read(): Promise<number> {
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
		return this.histogram.max / 1e6;
	}

	stop(): void {
		this.histogram.disable();
	}
}

interface Sample {
	readonly blockMs: number;
	readonly elapsedMs: number;
	/** Operations the case ran, for its throughput. */
	readonly operations: number;
}

const CASES = [
	"open",
	`append x${SEQUENTIAL_APPENDS} in sequence, 1 KiB`,
	`append x${SEQUENTIAL_APPENDS} in sequence, 1 KiB, wrapped (no writers' queue or holder record)`,
	`append x${CONCURRENT_APPENDS} at once, 1 KiB`,
	`append x${LARGE_APPENDS} in sequence, 64 KiB`,
	`point read x${POINT_READS} in sequence`,
	"read every row",
	"close",
] as const;

async function measure(probe: TurnProbe, operations: number, run: () => Promise<unknown>): Promise<Sample> {
	probe.reset();
	const started = performance.now();
	await run();
	const elapsedMs = performance.now() - started;
	return { blockMs: await probe.read(), elapsedMs, operations };
}

function append(database: SqliteDatabase, payload: string): Promise<unknown> {
	return database.transaction((tx) => tx.run("INSERT INTO events (payload) VALUES (?)", payload));
}

async function round(probe: TurnProbe): Promise<Sample[]> {
	const directory = mkdtempSync(join(tmpdir(), "atomic-node-sqlite-bench-"));
	const path = join(directory, "journal.sqlite");
	const small = "x".repeat(1024);
	const large = "y".repeat(64 * 1024);
	try {
		let database!: SqliteDatabase;
		const samples: Sample[] = [];
		samples.push(
			await measure(probe, 1, async () => {
				database = await openNodeSqliteDatabase(path);
				await database.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
			}),
		);
		samples.push(
			await measure(probe, SEQUENTIAL_APPENDS, async () => {
				for (let index = 0; index < SEQUENTIAL_APPENDS; index++) await append(database, small);
			}),
		);
		// The same appends through a wrapped connection, which runs on this thread and has no writers' queue or holder
		// record: the difference is what those, and the connection's own thread, cost per write.
		const connection = new DatabaseSync(join(directory, "wrapped.sqlite"));
		const wrapped = wrapNodeSqliteDatabase(connection);
		await wrapped.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
		samples.push(
			await measure(probe, SEQUENTIAL_APPENDS, async () => {
				for (let index = 0; index < SEQUENTIAL_APPENDS; index++) await append(wrapped, small);
			}),
		);
		await wrapped.close();
		connection.close();
		samples.push(
			await measure(probe, CONCURRENT_APPENDS, () =>
				Promise.all(Array.from({ length: CONCURRENT_APPENDS }, () => append(database, small))),
			),
		);
		samples.push(
			await measure(probe, LARGE_APPENDS, async () => {
				for (let index = 0; index < LARGE_APPENDS; index++) await append(database, large);
			}),
		);
		samples.push(
			await measure(probe, POINT_READS, async () => {
				for (let index = 0; index < POINT_READS; index++) await database.get("SELECT ? AS value", index);
			}),
		);
		samples.push(await measure(probe, 1, () => database.all("SELECT seq, payload FROM events")));
		samples.push(await measure(probe, 1, () => database.close()));
		return samples;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Starts `count` processes that each keep a CPU busy until they are killed. */
function startLoad(count: number): ChildProcess[] {
	return Array.from({ length: count }, () =>
		spawn(process.execPath, ["-e", "for (;;) {}"], { stdio: "ignore", windowsHide: true }),
	);
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const load = startLoad(options.load);
	const probe = new TurnProbe();
	const rounds: Sample[][] = [];
	try {
		for (let index = 0; index < options.rounds; index++) rounds.push(await round(probe));
	} finally {
		probe.stop();
		for (const child of load) child.kill();
	}
	const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? `Node ${process.version}` : "Bun";
	const lines = [
		`${runtime} on ${process.platform}, ${options.rounds} rounds, ${options.load} busy processes`,
		"",
		"| case | longest block, worst (ms) | elapsed p50 (ms) | per operation p50 (ms) |",
		"|---|---:|---:|---:|",
	];
	for (const [index, name] of CASES.entries()) {
		const samples = rounds.map((samples) => samples[index]!);
		const elapsed = median(samples.map((sample) => sample.elapsedMs));
		lines.push(
			`| ${name} | ${Math.max(...samples.map((sample) => sample.blockMs)).toFixed(2)} | ${elapsed.toFixed(2)} | ${(
				elapsed / samples[0]!.operations
			).toFixed(3)} |`,
		);
	}
	const table = `${lines.join("\n")}\n`;
	process.stdout.write(table);
	if (options.out !== undefined) writeFileSync(options.out, table);
}

await main();
