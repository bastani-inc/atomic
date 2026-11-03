/**
 * Starts `test/fixtures/public-pool-coordinator.mjs`, a root that runs one pooled child through the public `localWorkers`
 * options, as its own process, and reads its journal. The public pool lifecycle suites share it: each of their cases
 * crashes and resumes a root, and they are split so those processes run in parallel across workers.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { decodeStream, readStreamText, sleep, spawnProcess } from "./runtime.js";

export const PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 90_000;
export const STALE_COORDINATOR_AGE_MS = 10 * 60_000;
export const ROOT = "public-lifecycle-root-run";
const fixturePath = fileURLToPath(new URL("../fixtures/public-pool-coordinator.mjs", import.meta.url));
export const childPath = fileURLToPath(new URL("../fixtures/pool-lifecycle-child.ts", import.meta.url));

export interface CoordinatorEvent {
	event: string;
	pid?: number;
	instance?: string;
	command?: string;
	status?: string;
	outputs?: { firstPid: number; finalPid: number; firstInstance: string; finalInstance: string } | null;
	error?: string | null;
	message?: string;
}

/**
 * `settings` are run options the launch or restart passes over its defaults: the `localWorkers` and `admission` options
 * a resume from the CLI passes from the settings, its execution mode, or its opt-in to entry module changes.
 */
export function startCoordinator(
	directory: string,
	mode: "fresh" | "restart",
	{ definition = childPath, settings }: { definition?: string; settings?: object } = {},
) {
	const child = spawnProcess(
		[
			process.execPath,
			fixturePath,
			join(directory, "journal.sqlite"),
			directory,
			ROOT,
			definition,
			join(directory, "release"),
			mode,
			...(settings === undefined ? [] : [JSON.stringify(settings)]),
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
				if (parsed.event === "error" && event !== "error") assert.fail(`Coordinator failed: ${parsed.message}`);
				if (parsed.event === event) return parsed;
			}
		},
		async stop() {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		},
	};
}

export function observe<T>(directory: string, read: (database: TestSqliteDatabase) => T): T {
	const database = new TestSqliteDatabase(join(directory, "journal.sqlite"));
	try {
		return read(database);
	} finally {
		database.close();
	}
}

export async function until<T>(description: string, read: () => T | undefined): Promise<T> {
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
export interface Worker {
	pid: number;
	instance: string;
}

export function committedWorker(directory: string): Promise<Worker> {
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

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export function workItems(directory: string) {
	return observe(directory, (database) => database.query("SELECT id, state, generation FROM wf_runs_work").all()) as {
		id: string;
		state: string;
		generation: number;
	}[];
}

export function assertSingleRootRecovered(
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

/** The queued child's work descriptor, as the pool stored it. */
export function queuedWork(directory: string): { id: string; digest: string; execution: { executionMode?: string } } {
	const rows = observe(directory, (database) => database.query("SELECT id, descriptor FROM wf_runs_work").all());
	assert.equal(rows.length, 1);
	return { id: String(rows[0]!.id), ...JSON.parse(String(rows[0]!.descriptor)) };
}

/**
 * SIGKILLs a root once its pooled child recorded its first step, waits for that child's orphaned worker to exit, and
 * ages the root's lease past its liveness window, as a resume much later finds it. Returns the worker that recorded it.
 */
export async function crashAfterFirstStep(
	directory: string,
	root: ReturnType<typeof startCoordinator>,
): Promise<Worker> {
	const recorded = await committedWorker(directory);
	await root.stop();
	await until("the orphaned worker to exit", () => (pidAlive(recorded.pid) ? undefined : true));
	observe(directory, (database) =>
		database.run(
			"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? WHERE run_id = ?",
			STALE_COORDINATOR_AGE_MS,
			ROOT,
		),
	);
	return recorded;
}

export function recordedCheckpoints(directory: string): number {
	return observe(directory, (database) =>
		Number(
			database
				.query("SELECT COUNT(*) AS count FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint'")
				.get()!.count,
		),
	);
}
