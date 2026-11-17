#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShipShard, shipShardPath } from "../../../packages/workflows/src/workers/ship-shard.js";

const ROOT = "benchmark-root";
const LEASE_MS = 600_000;
const ISOLATED_ACCEPTS = 50;
const SEQUENTIAL_ACCEPTS = 50;
const CONCURRENT_ACCEPTS = 16;
const SEAL_BATCH = 64;

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

class TurnProbe {
	private last = performance.now();
	private running = true;
	private longest = 0;
	turns = 0;

	constructor() {
		const turn = () => {
			const now = performance.now();
			this.longest = Math.max(this.longest, now - this.last);
			this.last = now;
			this.turns += 1;
			if (this.running) setImmediate(turn);
		};
		setImmediate(turn);
	}

	reset(): void {
		this.last = performance.now();
		this.longest = 0;
		this.turns = 0;
	}

	async read(): Promise<{ readonly blockMs: number; readonly turns: number }> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		return { blockMs: this.longest, turns: this.turns };
	}

	stop(): void {
		this.running = false;
	}
}

interface Sample {
	readonly elapsedMs: number;
	readonly blockMs: number;
	readonly turns: number;
}

const samples = new Map<string, Sample[]>();

function record(name: string, sample: Sample): void {
	const list = samples.get(name) ?? [];
	list.push(sample);
	samples.set(name, list);
}

async function measure<T>(probe: TurnProbe, name: string, operation: () => Promise<T>): Promise<T> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	probe.reset();
	const started = performance.now();
	const result = await operation();
	const elapsedMs = performance.now() - started;
	const { blockMs, turns } = await probe.read();
	record(name, { elapsedMs, blockMs, turns });
	return result;
}

const payload = (bytes: number, seed: string) => JSON.stringify({ seed, fill: "x".repeat(bytes) });

async function round(directory: string, index: number, probe: TurnProbe): Promise<void> {
	const path = shipShardPath(directory, `journal-${index}`, ROOT);
	const shard = await measure(probe, "open", () => ShipShard.open(path, ROOT));
	const lease = { id: `work-${index}`, generation: 1, worker: "host/1", epoch: 1 };
	await measure(probe, "hold (first claim)", () => shard.hold(lease, LEASE_MS));
	let key = 0;
	const accept = (bytes: number) => shard.accept(ROOT, lease, `key-${key++}`, payload(bytes, `${key}`), key);
	for (const bytes of [4_096, 65_536])
		for (let each = 0; each < ISOLATED_ACCEPTS; each++)
			await measure(probe, `accept, one ${bytes / 1024} KiB`, () => accept(bytes));
	await measure(probe, `accept x${SEQUENTIAL_ACCEPTS} in sequence, 16 KiB`, async () => {
		for (let each = 0; each < SEQUENTIAL_ACCEPTS; each++) await accept(16_384);
	});
	await measure(probe, `accept x${CONCURRENT_ACCEPTS} at once, 16 KiB`, () =>
		Promise.all(Array.from({ length: CONCURRENT_ACCEPTS }, () => accept(16_384))),
	);
	const sealed = await measure(probe, `seal ${SEAL_BATCH}`, () => shard.seal(lease, SEAL_BATCH));
	await measure(probe, `shipped ${SEAL_BATCH}`, () => shard.shipped(lease, sealed!.events.at(-1)!.localSeq));
	const [first] = await shard.pending(lease, 1);
	await measure(probe, "discard", () => shard.discard(lease, first!.localSeq));
	await measure(probe, "fence", () => shard.fence(lease));
	await measure(probe, "close (retire)", () => shard.close({ retire: true }));
}

function quantile(values: readonly number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
}

function report(options: Options): string {
	const ms = (value: number) => value.toFixed(2);
	const lines = [
		`Runtime: ${typeof Bun === "undefined" ? `Node ${process.version}` : `Bun ${Bun.version}`}, ${process.platform}/${process.arch}, rounds: ${options.rounds}`,
		"",
		"| case | samples | elapsed p50 ms | elapsed max ms | block p50 ms | block max ms | turns p50 |",
		"|---|---:|---:|---:|---:|---:|---:|",
	];
	for (const [name, list] of samples) {
		const elapsed = list.map((sample) => sample.elapsedMs);
		const block = list.map((sample) => sample.blockMs);
		const turns = list.map((sample) => sample.turns);
		lines.push(
			`| ${name} | ${list.length} | ${ms(quantile(elapsed, 0.5))} | ${ms(Math.max(...elapsed))} | ${ms(quantile(block, 0.5))} | ${ms(Math.max(...block))} | ${quantile(turns, 0.5)} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

const options = parseOptions(process.argv.slice(2));
const directory = mkdtempSync(join(tmpdir(), "checkpoint-shard-benchmark-"));
const probe = new TurnProbe();
try {
	for (let index = 0; index < options.rounds; index++) await round(directory, index, probe);
} finally {
	probe.stop();
	rmSync(directory, { recursive: true, force: true });
}
const table = report(options);
process.stdout.write(table);
if (options.out !== undefined) writeFileSync(options.out, table);
