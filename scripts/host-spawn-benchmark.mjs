#!/usr/bin/env node
/**
 * How much starting processes stalls a host that holds a lot of memory, the way a host running many agents does.
 *
 * The workload is what such a host started: worktree snapshot captures of an unchanged checkout (the Git processes of
 * each turn that called a file-writing tool) and one short command a second, through `pi.exec`'s `execCommand`. It
 * runs once per memory size with the host's own starts (`native` on Linux) and once through `child_process`
 * (`ATOMIC_HOST_SPAWN=child-process`, how every start worked before), and reports for each:
 *
 * - the event-loop delay's p50, p99 and maximum, from `monitorEventLoopDelay`;
 * - processes started a second;
 * - the share of time the event loop was busy (`eventLoopUtilization`), the main thread's load.
 *
 * Run it under Node, which npm installs of Atomic use, after `npm run build` (it loads the built package):
 *
 *   node scripts/host-spawn-benchmark.mjs [--gb 0,2,6,8] [--seconds 15] [--captures-per-second 0.5] [--json]
 *
 * Each memory size runs in a child process of its own, so one size's memory never inflates another's, with its own
 * agent directory, so the snapshot store it writes is thrown away. The event-loop delay is sampled every millisecond,
 * so an idle loop shows about 1 ms.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "packages", "coding-agent", "dist");
const GIB = 1024 ** 3;
const CHUNK = 256 * 1024 * 1024;
const REPOSITORY_FILES = 2000;

function option(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

/** One measurement, in this process: hold `gb` GiB, run the workload for `seconds`, print one JSON line. */
async function measure(gb, seconds, capturesPerSecond, backend) {
	const held = [];
	for (let left = gb * GIB; left > 0; left -= CHUNK) held.push(Buffer.alloc(Math.min(CHUNK, left), 1));
	const { captureWorktreeSnapshot, MemorySnapshotBlobStore } = await import(
		pathToFileURL(join(dist, "core", "worktree-snapshot", "index.js")).href
	);
	const { execCommand } = await import(pathToFileURL(join(dist, "core", "exec.js")).href);
	const { hostSpawnBackend } = await import(pathToFileURL(join(dist, "utils", "host-spawn.js")).href);

	const repository = mkdtempSync(join(tmpdir(), "atomic-spawn-bench-"));
	const git = (...args) =>
		execFileSync("git", ["-C", repository, "-c", "user.name=bench", "-c", "user.email=bench@example.com", ...args], {
			stdio: "ignore",
		});
	git("init", "-q");
	for (let file = 0; file < REPOSITORY_FILES; file++) writeFileSync(join(repository, `file-${file}.txt`), `${file}\n`);
	git("add", "-A");
	git("-c", "commit.gpgSign=false", "commit", "-q", "-m", "fixture");
	writeFileSync(join(repository, "file-0.txt"), "changed\n");

	const blobs = new MemorySnapshotBlobStore();
	const first = await captureWorktreeSnapshot(repository, { blobs });
	if (first.status !== "captured") throw new Error(`the first capture was ${first.status}`);

	let started = 0;
	const countStarts = (promise, processes) => promise.then(() => (started += processes));
	// Git processes an unchanged capture starts, counted once from the snapshot code's own resolver calls below.
	const { setWorktreeSnapshotGit } = await import(
		pathToFileURL(join(dist, "core", "worktree-snapshot", "git.js")).href
	);
	const { resolveGit } = await import(pathToFileURL(join(dist, "utils", "tools-manager.js")).href);
	const executable = await resolveGit();
	setWorktreeSnapshotGit(async () => {
		started++;
		return executable;
	});

	// Samples every millisecond; an idle loop records about 1 ms.
	const delay = monitorEventLoopDelay({ resolution: 1 });
	const deadline = performance.now() + seconds * 1000;
	const elu = performance.eventLoopUtilization();
	delay.enable();
	const work = [];
	const captureEvery = 1000 / capturesPerSecond;
	let nextCapture = performance.now();
	let nextCommand = performance.now();
	while (performance.now() < deadline) {
		const now = performance.now();
		if (now >= nextCapture) {
			work.push(captureWorktreeSnapshot(repository, { blobs, previous: first.snapshot }));
			nextCapture += captureEvery;
		}
		if (now >= nextCommand) {
			work.push(countStarts(execCommand("git", ["--version"], repository), 1));
			nextCommand += 1000;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	await Promise.all(work);
	delay.disable();
	const busy = performance.eventLoopUtilization(elu);
	rmSync(repository, { recursive: true, force: true });
	const ms = (nanoseconds) => Math.round(nanoseconds / 1e4) / 100;
	process.stdout.write(
		`${JSON.stringify({
			platform: process.platform,
			runtime: `node ${process.version}`,
			gb,
			backend,
			effectiveBackend: hostSpawnBackend(),
			rssGb: Math.round((process.memoryUsage().rss / GIB) * 100) / 100,
			processesPerSecond: Math.round((started / seconds) * 10) / 10,
			eventLoopDelayMs: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) },
			mainThreadBusyPercent: Math.round(busy.utilization * 1000) / 10,
			held: held.length,
		})}\n`,
	);
}

if (process.argv[2] === "--measure") {
	const [, , , gb, seconds, capturesPerSecond, backend] = process.argv;
	await measure(Number(gb), Number(seconds), Number(capturesPerSecond), backend);
} else {
	const sizes = option("gb", "0,2,6,8").split(",").map(Number);
	const seconds = option("seconds", "15");
	const capturesPerSecond = option("captures-per-second", "0.5");
	const backends = process.platform === "linux" ? ["native", "child-process"] : ["child-process"];
	const rows = [];
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-spawn-bench-agent-"));
	for (const gb of sizes) {
		for (const backend of backends) {
			const run = spawnSync(
				process.execPath,
				[
					`--max-old-space-size=${Math.max(4096, (gb + 2) * 1024)}`,
					fileURLToPath(import.meta.url),
					"--measure",
					String(gb),
					seconds,
					capturesPerSecond,
					backend,
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						ATOMIC_HOST_SPAWN: backend === "native" ? "" : "child-process",
						ATOMIC_CODING_AGENT_DIR: agentDir,
					},
					maxBuffer: 16 * 1024 * 1024,
				},
			);
			if (run.status !== 0) throw new Error(`the ${gb} GiB ${backend} run failed:\n${run.stderr}`);
			rows.push(JSON.parse(run.stdout.trim().split("\n").at(-1)));
		}
	}
	rmSync(agentDir, { recursive: true, force: true });
	if (process.argv.includes("--json")) {
		for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
	} else {
		process.stdout.write(
			`| RSS (GiB) | start | processes/s | event-loop delay p50 / p99 / max (ms) | main thread busy |\n|---|---|---|---|---|\n`,
		);
		for (const row of rows) {
			const { p50, p99, max } = row.eventLoopDelayMs;
			process.stdout.write(
				`| ${row.rssGb} | ${row.effectiveBackend} | ${row.processesPerSecond} | ${p50} / ${p99} / ${max} | ${row.mainThreadBusyPercent}% |\n`,
			);
		}
	}
}
