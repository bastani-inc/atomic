import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import {
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	sleep,
	spawnProcess,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS = 180_000;
const EVENT_TIMEOUT_MS = 90_000;
const STALE_COORDINATOR_AGE_MS = 10 * 60_000;
const ROOT = "public-lifecycle-root-run";
const fixturePath = fileURLToPath(new URL("../fixtures/public-pool-coordinator.mjs", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/pool-lifecycle-child.ts", import.meta.url));

interface CoordinatorEvent {
	event: string;
	pid?: number;
	command?: string;
	status?: string;
	outputs?: { firstPid: number; finalPid: number } | null;
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

function committedWorkerPid(directory: string): Promise<number> {
	return until("the child's first checkpoint", () =>
		observe(directory, (database) => {
			const row = database
				.query(
					`SELECT json_extract(payload, '$.output') AS pid FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint' LIMIT 1`,
				)
				.get();
			return row?.pid === undefined ? undefined : Number(row.pid);
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
	firstPid: number,
	result: CoordinatorEvent,
	coordinators: number[],
): void {
	assert.equal(result.status, "completed", JSON.stringify(result));
	assert.equal(result.outputs?.firstPid, firstPid, "the committed checkpoint is not repeated");
	assert.notEqual(result.outputs?.finalPid, firstPid);
	assert.ok(!coordinators.includes(result.outputs!.finalPid), "the child ran on a worker, not the coordinator");
	const pids = observe(directory, (database) =>
		database
			.query(
				`SELECT DISTINCT json_extract(payload, '$.output') AS pid FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint'`,
			)
			.all(),
	);
	assert.deepEqual(
		pids.map((row) => Number(row.pid)),
		[firstPid],
	);
	assert.equal(
		observe(directory, (database) => Number(database.query("SELECT COUNT(*) AS count FROM wf_runs").get()!.count)),
		1,
	);
}

test.skipIf(process.platform === "win32")(
	"a SIGKILLed public coordinator is replaced by a fresh process that finishes the same root from settings stored on it (#3869)",
	async () => {
		const directory = makeTempDirectory("public-pool-crash-");
		const first = startCoordinator(directory, "fresh");
		let second: ReturnType<typeof startCoordinator> | undefined;
		try {
			const firstReady = await first.next("ready");
			const workerPid = await committedWorkerPid(directory);
			assert.notEqual(workerPid, firstReady.pid);
			const [before] = workItems(directory);
			await first.stop();
			await until("the orphaned worker to exit", () => (pidAlive(workerPid) ? undefined : true));
			observe(directory, (database) =>
				database.run(
					"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? WHERE run_id = ?",
					STALE_COORDINATOR_AGE_MS,
					ROOT,
				),
			);
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			second = startCoordinator(directory, "restart");
			const secondReady = await second.next("ready");
			const result = await second.next("result");
			assertSingleRootRecovered(directory, workerPid, result, [firstReady.pid!, secondReady.pid!]);
			const after = workItems(directory);
			assert.equal(after.length, 1);
			assert.equal(after[0]!.id, before!.id);
			assert.equal(after[0]!.state, "completed");
			assert.ok(after[0]!.generation > before!.generation, "the restart takes a new fenced attempt");
		} finally {
			await first.stop();
			await second?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);

test.runIf(process.platform === "win32")(
	"the public worker opt-in refuses Windows before registering a root or launching a worker (#3869)",
	async () => {
		const directory = makeTempDirectory("public-pool-windows-");
		const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
		const backend = await JournalDurableBackend.open(journal);
		try {
			const child = await loadWorkerWorkflow(childPath, "child");
			const parent = workflow({
				name: "public-windows-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.workflow(child, { inputs: { releasePath: join(directory, "release") } });
					return {};
				},
			});
			await assert.rejects(
				run(
					parent,
					{},
					{
						runId: ROOT,
						cwd: directory,
						durableBackend: backend,
						localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
					},
				),
				/containment.*Windows/i,
			);
			assert.equal(
				observe(directory, (database) =>
					Number(database.query("SELECT COUNT(*) AS count FROM wf_runs").get()!.count),
				),
				0,
			);
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);
