import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import {
	inspectTargetedDurableWorkflow,
	type TargetedDurableInspection,
} from "../../packages/workflows/src/durable/targeted-inspection.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readDirectorySync,
	readJson,
	readStreamText,
	readTextSync,
	removeTempDirectory,
	type SpawnedProcess,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

const POOL_SIGKILL_STATUS_TIMEOUT_MS = 240_000;
const ROOT_PROCESS_TIMEOUT_MS = 120_000;
const EVENT_TIMEOUT_MS = 90_000;
// A full run id, so status resolves it exactly rather than through the catalog.
const ROOT = "3903e5c0-0000-4000-8000-000000003903";
// Child 0 fails after journaling a stage session, child 1 completes, child 2 holds mid-stage.
const CHILDREN = 3;
const HELD_CHILD = 2;
const rootFixture = fileURLToPath(new URL("../fixtures/pool-sigkill-status-root.mjs", import.meta.url));

type Mode = "start" | "resume";

function startRoot(
	directory: string,
	mode: Mode,
	children = CHILDREN,
	failing = 1,
	finishing = 1,
): { readonly process: SpawnedProcess; readonly stderr: Promise<string> } {
	const args = [rootFixture, mode, directory, ROOT, String(children), String(failing), String(finishing)];
	const root = spawnProcess([process.execPath, ...args], {
		cwd: directory,
		stdout: "ignore",
		stderr: "pipe",
		timeout: ROOT_PROCESS_TIMEOUT_MS,
	});
	return { process: root, stderr: readStreamText(root.stderr) };
}

function observe<T>(directory: string, read: (database: TestSqliteDatabase) => T): T {
	const database = new TestSqliteDatabase(join(directory, "journal.sqlite"));
	try {
		return read(database);
	} finally {
		database.close();
	}
}

async function until(description: string, ready: () => boolean, root?: ReturnType<typeof startRoot>): Promise<void> {
	const deadline = Date.now() + EVENT_TIMEOUT_MS;
	for (;;) {
		try {
			if (ready()) return;
		} catch {}
		if (root !== undefined && root.process.exitCode !== null)
			assert.fail(`Root exited before ${description}: ${await root.stderr}`);
		if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
		await sleep(50);
	}
}

function workerPids(directory: string, mode: Mode): number[] {
	return JSON.parse(readTextSync(join(directory, `workers-${mode}.json`), "utf8")) as number[];
}

/** The held child is mid-stage on a worker owned by this incarnation of the root. */
function heldChildRunning(directory: string, mode: Mode): boolean {
	const workers = workerPids(directory, mode);
	return readDirectorySync(directory).some(
		(name) => name.startsWith(`started-${HELD_CHILD}-`) && workers.includes(Number(name.split("-")[2])),
	);
}

function terminalBoundaryStatuses(directory: string): string[] {
	return observe(directory, (database) =>
		database
			.query(
				`SELECT json_extract(payload, '$.topology.boundary.status') AS status FROM wf_events
				WHERE json_extract(payload, '$.topology.boundary.event') = 'terminal' ORDER BY seq`,
			)
			.all()
			.map((row) => String(row.status)),
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

/** The same targeted inspection `workflow status <runId>` performs, against the retained journal. */
async function inspectStatus(directory: string): Promise<TargetedDurableInspection> {
	const backend = await JournalDurableBackend.open(
		await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
	);
	try {
		return await inspectTargetedDurableWorkflow(backend, ROOT);
	} finally {
		await backend.close();
	}
}

test.skipIf(process.platform === "win32")(
	"a SIGKILLed pooled root with a failed child stays inspectable and resumes its completed child from cache (#3903)",
	async () => {
		const directory = makeTempDirectory("pool-sigkill-status-");
		const roots: ReturnType<typeof startRoot>[] = [];
		try {
			const crashed = startRoot(directory, "start");
			roots.push(crashed);
			await until(
				"one failed child, one completed child and one child mid-stage",
				() => {
					const statuses = terminalBoundaryStatuses(directory);
					return (
						statuses.includes("failed") && statuses.includes("completed") && heldChildRunning(directory, "start")
					);
				},
				crashed,
			);
			const orphanedWorkers = workerPids(directory, "start");
			const orphanedCoordinator = JSON.parse(
				readTextSync(join(directory, "coordinator-start.json"), "utf8"),
			) as number;
			assert.notEqual(orphanedCoordinator, crashed.process.pid, "the pool coordinator is its own process");
			crashed.process.kill("SIGKILL");
			await crashed.process.exited;
			await until(
				"the killed root's pool coordinator and workers to exit",
				() => ![orphanedCoordinator, ...orphanedWorkers].some(pidAlive),
			);

			const inspected = await inspectStatus(directory);
			assert.equal(inspected.kind, "found", inspected.kind === "found" ? "" : inspected.message);
			const root = inspected.runs.find((run) => run.id === ROOT);
			assert.deepEqual(root?.stages.map((stage) => stage.status).sort(), ["completed", "failed", "running"]);
			const children = inspected.runs.filter((run) => run.parentRunId === ROOT).map((run) => run.status);
			assert.ok(children.includes("running") && children.includes("completed"), JSON.stringify(children));

			const leased = observe(directory, (database) =>
				database.query("SELECT id, generation, epoch FROM wf_runs_work WHERE state = 'leased'").all(),
			);
			assert.equal(leased.length, 1, "only the held child's attempt is still leased by the killed root");
			const held = leased[0]!;
			const resumed = startRoot(directory, "resume");
			roots.push(resumed);
			await until(
				"the held child to restart on a resumed worker",
				() => heldChildRunning(directory, "resume"),
				resumed,
			);
			const reclaimed = observe(directory, (database) => ({
				work: database.query("SELECT generation, epoch FROM wf_runs_work WHERE id = ?").get(held.id),
				lease: database.query("SELECT epoch FROM wf_leases WHERE run_id = ?").get(ROOT),
			}));
			assert.equal(reclaimed.work?.epoch, reclaimed.lease?.epoch, "the resumed root fenced the dead attempt");
			assert.ok(Number(reclaimed.work?.generation) > Number(held.generation));
			assert.ok(Number(reclaimed.lease?.epoch) > Number(held.epoch));

			writeTextSync(join(directory, "release"), "");
			assert.equal(await resumed.process.exited, 0, await resumed.stderr);
			const outcome = await readJson<{ status: string; error: string | null }>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.ok(fileExistsSync(join(directory, "settled-resume.log")));
			const settled = readTextSync(join(directory, "settled-resume.log"), "utf8").trim().split("\n").sort();
			assert.deepEqual(
				settled.filter((line) => !line.startsWith("0 ")),
				["1 completed", `${HELD_CHILD} completed`],
				"the completed child replays from cache and the held child finishes",
			);
		} finally {
			for (const root of roots) if (root.process.exitCode === null) root.process.kill("SIGKILL");
			await Promise.all(roots.map((root) => root.process.exited));
			removeTempDirectory(directory);
		}
	},
	POOL_SIGKILL_STATUS_TIMEOUT_MS,
);

/** Worker pids that have started the held child's stage in any incarnation so far. */
function heldChildStarts(directory: string, index: number): number[] {
	return readDirectorySync(directory)
		.filter((name) => name.startsWith(`started-${index}-`))
		.map((name) => Number(name.split("-")[2]));
}

/** Workers this incarnation owns, other than `previous`, that have started the held child's stage. */
function heldChildRestarted(directory: string, mode: Mode, index: number, previous: readonly number[]): number[] {
	const workers = workerPids(directory, mode);
	return heldChildStarts(directory, index).filter((pid) => workers.includes(pid) && !previous.includes(pid));
}

test.skipIf(process.platform === "win32")(
	"a pooled child resumed twice replays its completed stage again without an identity conflict",
	async () => {
		const directory = makeTempDirectory("pool-sigkill-twice-");
		const roots: ReturnType<typeof startRoot>[] = [];
		const killRoot = async (root: ReturnType<typeof startRoot>, mode: Mode) => {
			const workers = workerPids(directory, mode);
			const coordinator = JSON.parse(readTextSync(join(directory, `coordinator-${mode}.json`), "utf8")) as number;
			root.process.kill("SIGKILL");
			await root.process.exited;
			await until("the killed root's pool to exit", () => ![coordinator, ...workers].some(pidAlive));
		};
		try {
			// One child completes its first stage, then holds its second stage mid-turn.
			const crashed = startRoot(directory, "start", 1, 0, 0);
			roots.push(crashed);
			await until(
				"the child to hold its second stage",
				() => heldChildRestarted(directory, "start", 0, []).length > 0,
				crashed,
			);
			await killRoot(crashed, "start");

			// The first resume replays the completed stage on a new work generation, then is killed too.
			let previous = heldChildStarts(directory, 0);
			const firstResume = startRoot(directory, "resume", 1, 0, 0);
			roots.push(firstResume);
			await until(
				"the first resume to hold the child's second stage",
				() => heldChildRestarted(directory, "resume", 0, previous).length > 0,
				firstResume,
			);
			await killRoot(firstResume, "resume");

			// The second resume replays the same completed stage again on a later generation.
			previous = heldChildStarts(directory, 0);
			const secondResume = startRoot(directory, "resume", 1, 0, 0);
			roots.push(secondResume);
			await until(
				"the second resume to hold the child's second stage",
				() => heldChildRestarted(directory, "resume", 0, previous).length > 0,
				secondResume,
			);
			const generation = observe(directory, (database) =>
				Number(database.query("SELECT MAX(generation) AS generation FROM wf_runs_work").get()?.generation),
			);
			assert.ok(generation >= 3, `the child ran on a third work generation, saw ${generation}`);
			writeTextSync(join(directory, "release"), "");
			assert.equal(await secondResume.process.exited, 0, await secondResume.stderr);
			const outcome = await readJson<{ status: string; error: string | null }>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.deepEqual(readTextSync(join(directory, "settled-resume.log"), "utf8").trim().split("\n"), [
				"0 completed",
			]);
		} finally {
			for (const root of roots) if (root.process.exitCode === null) root.process.kill("SIGKILL");
			await Promise.all(roots.map((root) => root.process.exited));
			removeTempDirectory(directory);
		}
	},
	POOL_SIGKILL_STATUS_TIMEOUT_MS,
);
