import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { makeTempDirectory, readJson, readStreamText, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";

const WORKER_FAILURE_ROOT_TIMEOUT_MS = 150_000;
const ROOT_PROCESS_TIMEOUT_MS = 120_000;
const rootFixture = fileURLToPath(new URL("../fixtures/pool-worker-failure-root.mjs", import.meta.url));

interface RootOutcome {
	readonly status: string;
	readonly error: string | null;
	readonly children: readonly { readonly status: string; readonly firstPid: number; readonly finalPid: number }[];
	readonly workerPids: readonly number[];
	readonly failedWorker: number;
}

async function runRootProcess(mode: "unanswered" | "killed", directory: string) {
	const root = spawnProcess([process.execPath, rootFixture, mode, directory], {
		cwd: directory,
		stdout: "ignore",
		stderr: "pipe",
		timeout: ROOT_PROCESS_TIMEOUT_MS,
	});
	const stderr = readStreamText(root.stderr);
	const exitCode = await root.exited;
	return { exitCode, stderr: await stderr };
}

function assertReplayedOnReplacement(outcome: RootOutcome, index: number): void {
	const child = outcome.children[index];
	assert.ok(child, JSON.stringify(outcome));
	assert.equal(child.status, "completed");
	assert.equal(child.firstPid, outcome.failedWorker, "the committed checkpoint is replayed, not repeated");
	assert.notEqual(child.finalPid, outcome.failedWorker);
	assert.ok(outcome.workerPids.includes(child.finalPid), "a replacement worker finished the child");
	assert.ok(!outcome.workerPids.includes(outcome.failedWorker));
}

test.skipIf(process.platform === "win32")(
	"the root survives failed replies to a worker that died with requests pending (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-unanswered-worker-");
		try {
			const { exitCode, stderr } = await runRootProcess("unanswered", directory);
			assert.equal(exitCode, 0, stderr);
			assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error' event/);
			const outcome = await readJson<RootOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assertReplayedOnReplacement(outcome, 0);
		} finally {
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker SIGKILLed mid-child is fenced and its child replays on a replacement (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-killed-worker-");
		try {
			const { exitCode, stderr } = await runRootProcess("killed", directory);
			assert.equal(exitCode, 0, stderr);
			const outcome = await readJson<RootOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assertReplayedOnReplacement(outcome, 0);
			assert.equal(outcome.children[1]?.status, "completed");
			assert.notEqual(outcome.children[1]?.firstPid, outcome.failedWorker);
		} finally {
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);
