import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import {
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	sleep,
	spawnProcess,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

/** A public pooled root paused, resumed and quit, then resumed by a fresh process (#3869). */

const PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 90_000;
const ROOT = "public-lifecycle-root-run";
const fixturePath = fileURLToPath(new URL("../fixtures/public-pool-coordinator.mjs", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/pool-lifecycle-child.ts", import.meta.url));

interface CoordinatorEvent {
	event: string;
	pid?: number;
	instance?: string;
	command?: string;
	status?: string;
	outputs?: { firstPid: number; finalPid: number; firstInstance: string; finalInstance: string } | null;
	error?: string | null;
	message?: string;
}

function startCoordinator(directory: string, mode: "fresh" | "restart") {
	const child = spawnProcess(
		[
			process.execPath,
			fixturePath,
			join(directory, "journal.sqlite"),
			directory,
			ROOT,
			childPath,
			join(directory, "release"),
			mode,
		],
		{
			cwd: directory,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: join(directory, "agent") },
		},
	);
	assert.ok(child.stdout);
	const reader = decodeStream(child.stdout).getReader();
	const stderr = readStreamText(child.stderr);
	let buffer = "";
	return {
		child,
		send(command: "pause" | "resume" | "quit") {
			child.stdin?.write(`${JSON.stringify({ command })}\n`);
		},
		async next(event: string): Promise<CoordinatorEvent> {
			const deadline = Date.now() + EVENT_TIMEOUT_MS;
			for (;;) {
				while (!buffer.includes("\n")) {
					const read = await Promise.race([
						reader.read(),
						sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const),
					]);
					if (read === "timeout") assert.fail(`Coordinator did not emit ${event}: ${await stderr}`);
					if (read.done) assert.fail(`Coordinator exited before ${event}: ${await stderr}`);
					buffer += read.value;
				}
				const end = buffer.indexOf("\n");
				const parsed = JSON.parse(buffer.slice(0, end)) as CoordinatorEvent;
				buffer = buffer.slice(end + 1);
				if (parsed.event === "error") assert.fail(`Coordinator failed: ${parsed.message}`);
				if (parsed.event === event) return parsed;
			}
		},
		async stop() {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		},
	};
}

function observe<T>(directory: string, read: (database: TestSqliteDatabase) => T): T {
	const database = new TestSqliteDatabase(join(directory, "journal.sqlite"));
	try {
		return read(database);
	} finally {
		database.close();
	}
}

async function until<T>(description: string, read: () => T | undefined): Promise<T> {
	const deadline = Date.now() + EVENT_TIMEOUT_MS;
	for (;;) {
		try {
			const value = read();
			if (value !== undefined) return value;
		} catch {}
		if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
		await sleep(25);
	}
}

/** The worker process that took the child's checkpoint: its pid, and its instance id (a pid can be reused). */
interface Worker {
	pid: number;
	instance: string;
}

function committedWorker(directory: string): Promise<Worker> {
	return until("the child's first checkpoint", () =>
		observe(directory, (database) => {
			const row = database
				.query(
					`SELECT json_extract(payload, '$.output') AS worker FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint' LIMIT 1`,
				)
				.get();
			return row?.worker === undefined ? undefined : (JSON.parse(String(row.worker)) as Worker);
		}),
	);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function workItems(directory: string) {
	return observe(directory, (database) => database.query("SELECT id, state, generation FROM wf_runs_work").all()) as {
		id: string;
		state: string;
		generation: number;
	}[];
}

function assertSingleRootRecovered(
	directory: string,
	first: Worker,
	result: CoordinatorEvent,
	coordinators: CoordinatorEvent[],
): void {
	assert.equal(result.status, "completed", JSON.stringify(result));
	assert.equal(result.outputs?.firstPid, first.pid, "the committed checkpoint is not repeated");
	assert.equal(result.outputs?.firstInstance, first.instance, "the committed checkpoint is not repeated");
	// A new process finished the work: its instance id differs from the first worker's, which its pid may not.
	assert.notEqual(result.outputs?.finalInstance, first.instance);
	assert.ok(
		!coordinators.some((coordinator) => coordinator.instance === result.outputs!.finalInstance),
		"the child ran on a worker, not the coordinator",
	);
	const workers = observe(directory, (database) =>
		database
			.query(
				`SELECT DISTINCT json_extract(payload, '$.output') AS worker FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint'`,
			)
			.all(),
	);
	assert.deepEqual(
		workers.map((row) => JSON.parse(String(row.worker))),
		[first],
	);
	assert.equal(
		observe(directory, (database) => Number(database.query("SELECT COUNT(*) AS count FROM wf_runs").get()!.count)),
		1,
	);
}

test.skipIf(process.platform === "win32")(
	"a public root pauses, resumes and quits, then a fresh process resumes the retained work to completion (#3869)",
	async () => {
		const directory = makeTempDirectory("public-pool-quit-");
		const first = startCoordinator(directory, "fresh");
		let second: ReturnType<typeof startCoordinator> | undefined;
		const status = () =>
			observe(
				directory,
				(database) => database.query("SELECT status FROM wf_runs WHERE run_id = ?").get(ROOT)?.status,
			);
		try {
			const firstReady = await first.next("ready");
			const worker = await committedWorker(directory);
			const workerPid = worker.pid;
			const [before] = workItems(directory);
			first.send("pause");
			await first.next("controlled");
			assert.equal(status(), "paused");
			first.send("resume");
			await first.next("controlled");
			assert.equal(status(), "running");
			first.send("quit");
			const quit = await first.next("result");
			assert.equal(quit.status, "paused");
			await first.child.exited;
			await until("the worker to be torn down", () => (pidAlive(workerPid) ? undefined : true));
			const [retained] = workItems(directory);
			assert.equal(retained!.id, before!.id);
			assert.notEqual(retained!.state, "completed");
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			second = startCoordinator(directory, "restart");
			const secondReady = await second.next("ready");
			const result = await second.next("result");
			assertSingleRootRecovered(directory, worker, result, [firstReady, secondReady]);
			const after = workItems(directory);
			assert.equal(after.length, 1);
			assert.equal(after[0]!.id, before!.id);
			assert.equal(after[0]!.state, "completed");
		} finally {
			await first.stop();
			await second?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);
