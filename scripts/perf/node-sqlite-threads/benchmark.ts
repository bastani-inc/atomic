#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabase } from "../../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";

const SEQUENTIAL_APPENDS = 200;
const CONCURRENT_APPENDS = 64;
const LARGE_APPENDS = 50;
const POINT_READS = 1_000;

interface Options {
	readonly rounds: number;
	readonly out?: string;
}

function parseOptions(argv: readonly string[]): Options {
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(`--${name}`);
		return index === -1 ? undefined : argv[index + 1];
	};
	return {
		rounds: Number(value("rounds") ?? "5"),
		...(value("out") === undefined ? {} : { out: value("out") }),
	};
}

/** Records each turn of the event loop with a `setImmediate` chain: the longest gap is the longest block. */
class TurnProbe {
	private last = performance.now();
	private running = true;
	private longest = 0;

	constructor() {
		const turn = () => {
			const now = performance.now();
			this.longest = Math.max(this.longest, now - this.last);
			this.last = now;
			if (this.running) setImmediate(turn);
		};
		setImmediate(turn);
	}

	reset(): void {
		this.last = performance.now();
		this.longest = 0;
	}

	async read(): Promise<number> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		return this.longest;
	}

	stop(): void {
		this.running = false;
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

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const probe = new TurnProbe();
	const rounds: Sample[][] = [];
	try {
		for (let index = 0; index < options.rounds; index++) rounds.push(await round(probe));
	} finally {
		probe.stop();
	}
	const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? `Node ${process.version}` : "Bun";
	const lines = [
		`${runtime} on ${process.platform}, ${options.rounds} rounds`,
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
