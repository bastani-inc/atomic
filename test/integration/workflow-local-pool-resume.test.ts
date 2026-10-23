import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	makeTempDirectory,
	readJson,
	readStreamText,
	removeTempDirectory,
	sleep,
	spawnProcess,
} from "../helpers/runtime.js";

const CRASHED_ROOT_RESUME_TIMEOUT_MS = 180_000;
const ROOT_PROCESS_TIMEOUT_MS = 90_000;
const CHILDREN = 3;
const rootFixture = fileURLToPath(new URL("../fixtures/pool-resume-root.mjs", import.meta.url));

interface ResumeOutcome {
	readonly status: string;
	readonly error: string | null;
	readonly children: readonly { readonly status: string; readonly firstPid: number; readonly finalPid: number }[];
	readonly workerPids: readonly number[];
}

function startedWorkers(directory: string): number[] {
	return readdirSync(directory)
		.filter((name) => name.startsWith("started-"))
		.map((name) => Number(name.split("-")[2]));
}

test.skipIf(process.platform === "win32")(
	"resuming a crashed pooled root replays children leased by the dead incarnation (#3890)",
	async () => {
		const directory = makeTempDirectory("pool-crashed-root-resume-");
		try {
			const crashed = spawnProcess([process.execPath, rootFixture, "start", directory, String(CHILDREN)], {
				cwd: directory,
				stdout: "ignore",
				stderr: "pipe",
				timeout: ROOT_PROCESS_TIMEOUT_MS,
			});
			const crashedStderr = readStreamText(crashed.stderr);
			const deadline = Date.now() + ROOT_PROCESS_TIMEOUT_MS;
			while (startedWorkers(directory).length < CHILDREN) {
				if (Date.now() >= deadline) assert.fail(await crashedStderr);
				await sleep(50);
			}
			const deadWorkers = startedWorkers(directory);
			crashed.kill("SIGKILL");
			await crashed.exited;

			const resumed = spawnProcess([process.execPath, rootFixture, "resume", directory, String(CHILDREN)], {
				cwd: directory,
				stdout: "ignore",
				stderr: "pipe",
				timeout: ROOT_PROCESS_TIMEOUT_MS,
			});
			const stderr = readStreamText(resumed.stderr);
			assert.equal(await resumed.exited, 0, await stderr);
			assert.doesNotMatch(await stderr, /Stale work lease|cleanup was not confirmed/);
			const outcome = await readJson<ResumeOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.equal(outcome.children.length, CHILDREN);
			for (const child of outcome.children) {
				assert.equal(child.status, "completed");
				assert.ok(deadWorkers.includes(child.firstPid), "the committed checkpoint is replayed, not repeated");
				assert.ok(outcome.workerPids.includes(child.finalPid), "a worker of the resumed root finished the child");
			}
		} finally {
			removeTempDirectory(directory);
		}
	},
	CRASHED_ROOT_RESUME_TIMEOUT_MS,
);

const LEASE_STALL_TIMEOUT_MS = 120_000;
const STALL_TEST_LEASE_MS = 2_000;
const ROOT_STALL_MS = 3 * STALL_TEST_LEASE_MS;
const stallFixture = fileURLToPath(new URL("../fixtures/pool-lease-stall-root.mjs", import.meta.url));

test.skipIf(process.platform === "win32")(
	"a root stall longer than the work lease does not fence a live worker (#3888)",
	async () => {
		const directory = makeTempDirectory("pool-lease-stall-");
		try {
			const root = spawnProcess(
				[process.execPath, stallFixture, directory, String(STALL_TEST_LEASE_MS), String(ROOT_STALL_MS)],
				{ cwd: directory, stdout: "ignore", stderr: "pipe", timeout: ROOT_PROCESS_TIMEOUT_MS },
			);
			const stderr = readStreamText(root.stderr);
			assert.equal(await root.exited, 0, await stderr);
			assert.doesNotMatch(await stderr, /Stale work lease/);
			const outcome = await readJson<ResumeOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			const [child] = outcome.children;
			assert.equal(child?.status, "completed");
			assert.equal(child.finalPid, child.firstPid, "the live worker kept its child through the stall");
			assert.deepEqual(outcome.workerPids, [child.firstPid]);
		} finally {
			removeTempDirectory(directory);
		}
	},
	LEASE_STALL_TIMEOUT_MS,
);
