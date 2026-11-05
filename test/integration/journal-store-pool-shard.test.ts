import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { journalStoreDirectory, journalStoreEnvironment } from "../helpers/journal-store.js";
import { testRunId } from "../helpers/run-id.js";
import {
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/journal-store-pooled-root.mjs", import.meta.url));
const CHILD = fileURLToPath(new URL("../fixtures/pool-lifecycle-child.ts", import.meta.url));
/** Two roots each start a coordinator and a worker process, and load the workflow sources in each. */
const POOLED_ROOTS_TIMEOUT_MS = 240_000;
const PROCESS_DISCOVERY_TIMEOUT_MS = 120_000;

function parentOf(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
	} catch {
		return undefined;
	}
}

function descendsFrom(pid: number, ancestor: number): boolean {
	for (
		let current: number | undefined = parentOf(pid);
		current !== undefined && current > 1;
		current = parentOf(current)
	)
		if (current === ancestor) return true;
	return false;
}

/** The store's database files each process below `ancestor` has open, by pid, read from `/proc/<pid>/fd`. */
function openStoreFiles(ancestor: number, store: string): Map<number, Set<string>> {
	const opened = new Map<number, Set<string>>();
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isSafeInteger(pid) || pid <= 1 || !descendsFrom(pid, ancestor)) continue;
		let descriptors: string[];
		try {
			descriptors = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue;
		}
		for (const descriptor of descriptors) {
			let target: string;
			try {
				target = readlinkSync(`/proc/${pid}/fd/${descriptor}`);
			} catch {
				continue;
			}
			if (!target.startsWith(`${store}/`) || !/\.sqlite(-wal|-shm)?$/.test(target)) continue;
			const files = opened.get(pid) ?? new Set<string>();
			files.add(basename(target).replace(/-(wal|shm)$/, ""));
			opened.set(pid, files);
		}
	}
	return opened;
}

function startRoot(directory: string, runId: string) {
	const release = join(directory, `release-${runId}`);
	const child = spawnProcess([process.execPath, FIXTURE, directory, runId, CHILD, release], {
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
		env: journalStoreEnvironment(directory),
	});
	assert.ok(child.stdout);
	const reader = decodeStream(child.stdout).getReader();
	const stderr = readStreamText(child.stderr);
	let buffer = "";
	return {
		child,
		release,
		stderr,
		async next(event: string): Promise<{ event: string; pid?: number; status?: string; error?: string | null }> {
			for (;;) {
				while (!buffer.includes("\n")) {
					const read = await reader.read();
					if (read.done) assert.fail(`Root exited before ${event}: ${await stderr}`);
					buffer += read.value;
				}
				const end = buffer.indexOf("\n");
				const parsed = JSON.parse(buffer.slice(0, end));
				buffer = buffer.slice(end + 1);
				if (parsed.event === event || parsed.event === "error") return parsed;
			}
		},
	};
}

test.skipIf(process.platform !== "linux")(
	"pool coordinators and workers open only their root's shard of the journal store (#4325)",
	async () => {
		const directory = makeTempDirectory("journal-store-pool-shard-");
		const store = journalStoreDirectory(directory);
		const roots = [testRunId("journal-store-pool-a"), testRunId("journal-store-pool-b")];
		const started = roots.map((runId) => startRoot(directory, runId));
		try {
			const ready = await Promise.all(started.map((root) => root.next("ready")));
			const pids = ready.map((event) => event.pid!);
			const deadline = Date.now() + PROCESS_DISCOVERY_TIMEOUT_MS;
			let observed = pids.map(() => new Map<number, Set<string>>());
			while (observed.some((processes) => processes.size < 2)) {
				assert.ok(
					Date.now() < deadline,
					`pool processes did not open the store: ${JSON.stringify(observed.map((processes) => [...processes.keys()]))}`,
				);
				await sleep(100);
				observed = pids.map((pid) => openStoreFiles(pid, store));
			}
			const catalog = new DatabaseSync(join(store, "catalog.sqlite"), { readOnly: true });
			const shards = roots.map((runId) => {
				const row = catalog
					.prepare(
						"SELECT shards.path AS path FROM catalog_runs AS runs JOIN catalog_shards AS shards ON shards.id = runs.shard WHERE runs.run_id = ?",
					)
					.get(runId);
				return basename(String(row?.path));
			});
			catalog.close();
			assert.notEqual(shards[0], shards[1], "the two roots are on different shards");
			for (const [index, processes] of observed.entries()) {
				for (const [pid, files] of processes)
					assert.deepEqual(
						[...files],
						[shards[index]],
						`pool process ${pid} of ${roots[index]} opened only its root's shard`,
					);
			}
			for (const root of started) writeFileSync(root.release, "go");
			for (const root of started) {
				const result = await root.next("result");
				assert.equal(result.status, "completed", JSON.stringify(result));
			}
			assert.ok(existsSync(join(store, shards[0]!)));
		} finally {
			for (const root of started) {
				if (!existsSync(root.release)) writeFileSync(root.release, "go");
				if (root.child.exitCode === null) root.child.kill("SIGKILL");
				await root.child.exited;
			}
			removeTempDirectory(directory);
		}
	},
	POOLED_ROOTS_TIMEOUT_MS,
);
