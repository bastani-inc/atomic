import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { copyFileSync, spawnSyncCollect } from "./runtime.js";

export const PACKAGED_WORKER_ROOT = "packaged-worker-root";
export const PACKAGED_WORKER_TIMEOUT_MS = 120_000;

const coordinator = fileURLToPath(new URL("../fixtures/packaged-worker-coordinator.mjs", import.meta.url));
const childFixture = fileURLToPath(new URL("../fixtures/packaged-worker-child.ts", import.meta.url));

interface CoordinatorOutput {
	status: string;
	outputs: { pid: number; parentPid: number; token: string } | null;
	error: string | null;
	rootPid: number;
}

export function stageChildWorkflow(directory: string): string {
	const childPath = join(directory, "authored-child.ts");
	copyFileSync(childFixture, childPath);
	return childPath;
}

export function runPackagedWorkerRoot(options: {
	sdkBundle: string;
	directory: string;
	childPath: string;
	token: string;
	launcher?: string;
}): CoordinatorOutput {
	const args = [
		process.execPath,
		coordinator,
		resolve(options.sdkBundle),
		join(options.directory, "journal.sqlite"),
		options.directory,
		options.childPath,
		PACKAGED_WORKER_ROOT,
		options.token,
		...(options.launcher ? [options.launcher] : []),
	];
	const result = spawnSyncCollect(args, {
		cwd: options.directory,
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: join(options.directory, "agent") },
		timeout: PACKAGED_WORKER_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, `${result.stdout.toString()}\n${result.stderr.toString()}`);
	const line = result.stdout.toString().trim().split("\n").at(-1);
	assert.ok(line, `coordinator printed no result: ${result.stderr.toString()}`);
	return JSON.parse(line) as CoordinatorOutput;
}

export function assertWorkerCompletedUnderRoot(directory: string, output: CoordinatorOutput, token: string): void {
	assert.equal(output.status, "completed", JSON.stringify(output));
	assert.equal(output.outputs?.token, token);
	const workerPid = output.outputs?.pid;
	assert.ok(workerPid !== undefined && workerPid !== output.rootPid, "the child ran on a worker process");
	const workerParent = output.outputs?.parentPid;
	assert.ok(
		workerParent !== undefined && workerParent !== output.rootPid && workerParent !== workerPid,
		"the worker is a child of the pool's coordinator process, not of the root",
	);
	const database = new TestSqliteDatabase(join(directory, "journal.sqlite"));
	try {
		const runs = database.query("SELECT run_id FROM wf_runs").all();
		assert.deepEqual(
			runs.map((row) => row.run_id),
			[PACKAGED_WORKER_ROOT],
		);
		const checkpoints = database
			.query(
				"SELECT json_extract(payload, '$.output') AS pid FROM wf_events WHERE run_id = ? AND json_extract(payload, '$.name') = 'checkpoint'",
			)
			.all(PACKAGED_WORKER_ROOT);
		assert.deepEqual(
			checkpoints.map((row) => Number(row.pid)),
			[workerPid],
		);
		const work = database.query("SELECT state FROM wf_runs_work").all();
		assert.deepEqual(
			work.map((row) => row.state),
			["completed"],
		);
	} finally {
		database.close();
	}
}
