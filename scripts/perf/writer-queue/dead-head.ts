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

const argv = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
	const index = argv.indexOf(`--${name}`);
	return index === -1 ? fallback : argv[index + 1]!;
};
const gaps = value("gaps", "100,1000,1500").split(",").map(Number);
const repeats = Number(value("repeats", "5"));
const baseline = value("baseline", "77746f5");

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const storagePath = "packages/coding-agent/src/core/storage";
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

function start(storage: string, path: string, role: "hold" | "write") {
	const child = spawn(process.env.NODE ?? "node", [worker, storage, path, role], {
		stdio: ["pipe", "pipe", "inherit"],
		cwd: repository,
	});
	const exited = new Promise((resolve) => child.once("exit", resolve));
	let buffered = "";
	const waiting: ((line: string) => void)[] = [];
	const queued: string[] = [];
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffered += chunk;
		for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
			const line = buffered.slice(0, end);
			buffered = buffered.slice(end + 1);
			const next = waiting.shift();
			if (next === undefined) queued.push(line);
			else next(line);
		}
	});
	return {
		child,
		exited,
		next: () => {
			const line = queued.shift();
			return line === undefined ? new Promise<string>((resolve) => waiting.push(resolve)) : Promise.resolve(line);
		},
		send: () => child.stdin.end("go\n"),
	};
}

async function untilQueued(writers: string, pid: number): Promise<void> {
	while (!(existsSync(writers) && readdirSync(writers).some((name) => name.split("-")[1] === String(pid))))
		await Bun.sleep(2);
}

async function sample(storage: string, scratch: string, gapMs: number): Promise<number> {
	const directory = mkdtempSync(join(scratch, "dead-head-"));
	const path = join(directory, "probe.sqlite");
	const setup = new DatabaseSync(path);
	setup.exec("PRAGMA journal_mode = WAL; CREATE TABLE probe(role TEXT)");
	setup.close();
	const holder = start(storage, path, "hold");
	if ((await holder.next()) !== "locked") throw new Error("holder did not take the lock");
	const dead = start(storage, path, "write");
	const behind = start(storage, path, "write");
	for (const writer of [dead, behind]) if ((await writer.next()) !== "ready") throw new Error("writer did not start");
	dead.send();
	await untilQueued(`${path}-writers`, dead.child.pid!);
	behind.send();
	await untilQueued(`${path}-writers`, behind.child.pid!);
	dead.child.kill("SIGKILL");
	await dead.exited;
	await Bun.sleep(gapMs);
	const committed = holder.next();
	const started = behind.next();
	holder.send();
	const committedAt = Number((await committed).split(" ")[1]);
	const startedAt = Number((await started).split(" ")[1]);
	await Promise.all([holder.exited, behind.exited]);
	rmSync(directory, { recursive: true, force: true });
	return startedAt - committedAt;
}

const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const scratch = mkdtempSync(join(tmpdir(), "dead-head-"));
const variants = [
	{ name: "baseline", storage: materialize(baseline, scratch) },
	{ name: "current", storage: join(repository, storagePath) },
];
const results: Record<string, Record<number, number[]>> = {};
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
rmSync(scratch, { recursive: true, force: true });
console.log("| killed before the commit | expected | baseline (median, range) | current (median, range) |");
console.log("|---:|---:|---:|---:|");
for (const gapMs of gaps) {
	const cell = (name: string) => {
		const values = results[name]![gapMs]!;
		return `${median(values)} ms (${Math.min(...values)}-${Math.max(...values)})`;
	};
	console.log(`| ${gapMs} ms | about ${Math.max(0, 2000 - gapMs)} ms | ${cell("baseline")} | ${cell("current")} |`);
}
