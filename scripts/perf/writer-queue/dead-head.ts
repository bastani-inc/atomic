#!/usr/bin/env bun
/**
 * Dead-head probe for the writers' queue (#4316): how long the writers behind a waiter that died in the queue wait
 * for the lock once the holder lets go of it.
 *
 * Each sample starts a holder that keeps the write lock, a waiter A that queues behind it, and a waiter B that
 * queues behind A. A is killed, the holder commits `--gaps` ms later, and the probe reports the time from that
 * commit to B holding the lock. A's ticket stays live until 2 s after A last refreshed it, so B should hold the
 * lock about `2000 - gap` ms after the commit, plus up to one recheck, unless something kept the dead ticket live.
 * It compares `--baseline` (default 77746f5, before #4316) with this checkout.
 *
 *   bun run scripts/perf/writer-queue/dead-head.ts --gaps 100,1000,1500 --repeats 5
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { WriterQueueBenchmarkWorkerError } from "./errors.js";
import { parseDeadHeadOptions, repository, storagePath } from "./options.js";
import { reportFailure, WorkerChannel, withCleanup } from "./support.js";

process.on("uncaughtException", reportFailure);
const { gaps, repeats, baseline } = parseDeadHeadOptions(process.argv.slice(2));

const worker = fileURLToPath(new URL("./dead-head-worker.mjs", import.meta.url));

function git(args: readonly string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: repository });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

function materialize(revision: string, into: string): string {
	const directory = join(into, `storage-${revision}`);
	mkdirSync(directory, { recursive: true });
	for (const name of git(["ls-tree", "--name-only", `${revision}:${storagePath}`]).split("\n"))
		if (name.endsWith(".ts"))
			writeFileSync(join(directory, name), git(["show", `${revision}:${storagePath}/${name}`]));
	return directory;
}

function start(storage: string, path: string, role: "hold" | "write", label: string): WorkerChannel {
	const child = spawn(process.env.NODE ?? "node", [worker, storage, path, role], {
		stdio: ["pipe", "pipe", "inherit"],
		cwd: repository,
	});
	return new WorkerChannel(child, label);
}

async function untilQueued(writers: string, writer: WorkerChannel): Promise<void> {
	while (!(existsSync(writers) && readdirSync(writers).some((name) => name.split("-")[1] === String(writer.pid)))) {
		writer.assertRunning("queue ticket");
		await Bun.sleep(2);
	}
}

async function sample(storage: string, scratch: string, gapMs: number): Promise<number> {
	const directory = mkdtempSync(join(scratch, "dead-head-"));
	const started: WorkerChannel[] = [];
	return withCleanup(
		() => measure(storage, directory, gapMs, started),
		async () => {
			try {
				await Promise.all(started.map((channel) => channel.stop()));
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
}

async function measure(storage: string, directory: string, gapMs: number, started: WorkerChannel[]): Promise<number> {
	const path = join(directory, "probe.sqlite");
	const setup = new DatabaseSync(path);
	setup.exec("PRAGMA journal_mode = WAL; CREATE TABLE probe(role TEXT)");
	setup.close();
	const begin = (role: "hold" | "write", label: string) => {
		const channel = start(storage, path, role, label);
		started.push(channel);
		return channel;
	};
	const holder = begin("hold", "holder");
	if ((await holder.next("locked")) !== "locked")
		throw new WriterQueueBenchmarkWorkerError("worker-protocol", { worker: "holder", phase: "locked" });
	const dead = begin("write", "dead");
	const behind = begin("write", "behind");
	await Promise.all(
		[dead, behind].map(async (writer) => {
			if ((await writer.next("ready")) !== "ready")
				throw new WriterQueueBenchmarkWorkerError("worker-protocol", { worker: writer.label, phase: "ready" });
		}),
	);
	dead.send("go");
	await untilQueued(`${path}-writers`, dead);
	behind.send("go");
	await untilQueued(`${path}-writers`, behind);
	await dead.stop();
	await Bun.sleep(gapMs);
	const committed = holder.next("commit");
	const lockHeld = behind.next("lock");
	holder.send("go");
	const [committedLine, startedLine] = await Promise.all([committed, lockHeld]);
	await Promise.all([holder.finished("exit"), behind.finished("exit")]);
	return Number(startedLine.split(" ")[1]) - Number(committedLine.split(" ")[1]);
}

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const scratch = mkdtempSync(join(tmpdir(), "dead-head-"));
const variants: { name: string; storage: string }[] = [];
const results: Record<string, Record<number, number[]>> = {};
await withCleanup(
	async () => {
		variants.push(
			{ name: "baseline", storage: materialize(baseline, scratch) },
			{ name: "current", storage: join(repository, storagePath) },
		);
		for (let repeat = 0; repeat < repeats; repeat++)
			for (const gapMs of gaps)
				for (const variant of repeat % 2 === 0 ? variants : [...variants].reverse()) {
					const waitedMs = await sample(variant.storage, scratch, gapMs);
					const byGap = results[variant.name] ?? {};
					results[variant.name] = byGap;
					byGap[gapMs] = [...(byGap[gapMs] ?? []), waitedMs];
					console.error(
						`${variant.name} gap ${gapMs} ms #${repeat + 1}: next writer held the lock ${waitedMs} ms after the commit`,
					);
				}
	},
	() => rmSync(scratch, { recursive: true, force: true }),
);
console.log("| killed before the commit | expected | baseline (median, range) | current (median, range) |");
console.log("|---:|---:|---:|---:|");
for (const gapMs of gaps) {
	const cell = (name: string) => {
		const values = results[name]![gapMs]!;
		return `${median(values)} ms (${Math.min(...values)}-${Math.max(...values)})`;
	};
	console.log(`| ${gapMs} ms | about ${Math.max(0, 2000 - gapMs)} ms | ${cell("baseline")} | ${cell("current")} |`);
}
