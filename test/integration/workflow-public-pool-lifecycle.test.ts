import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
function startCoordinator(
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
	"a SIGKILLed public coordinator is replaced by a fresh process that finishes the same root from settings stored on it (#3869)",
	async () => {
		const directory = makeTempDirectory("public-pool-crash-");
		const first = startCoordinator(directory, "fresh");
		let second: ReturnType<typeof startCoordinator> | undefined;
		try {
			const firstReady = await first.next("ready");
			const worker = await committedWorker(directory);
			const workerPid = worker.pid;
			assert.notEqual(worker.instance, firstReady.instance);
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
			assertSingleRootRecovered(directory, worker, result, [firstReady, secondReady]);
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

/** A helper module the resumable child imports, as a workflow's gate functions import a library file. */
const helperSource = (version: string) =>
	`export function gate(label: string): string {\n\treturn "${version}:" + label;\n}\n`;
/** The lifecycle child's shape, but each step reports what the helper returned instead of a process instance id. */
const helperChildSource = `import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { gate } from "./lib/gate.ts";

export const child = workflow({
	name: "pool-resume-helper-child",
	description: "Records a step through a helper, then waits for release",
	inputs: { releasePath: Type.String() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => ({ pid: process.pid, instance: gate("first") }));
		const final = await ctx.tool("finish", {}, async () => {
			while (!existsSync(ctx.inputs.releasePath)) await delay(20);
			return { pid: process.pid, instance: gate("final") };
		});
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});
`;

test.skipIf(process.platform === "win32")(
	"a crashed root resumes after an imported helper is edited and the pool size and root limits change, keeping its recorded steps (#4196)",
	async () => {
		const directory = makeTempDirectory("public-pool-resume-changes-");
		const definition = join(directory, "workflows", "child.ts");
		const helper = join(directory, "workflows", "lib", "gate.ts");
		await writeFileEnsuringDir(definition, helperChildSource);
		await writeFileEnsuringDir(helper, helperSource("v1"));
		const first = startCoordinator(directory, "fresh", { definition });
		let second: ReturnType<typeof startCoordinator> | undefined;
		try {
			await first.next("ready");
			const recorded = await committedWorker(directory);
			assert.equal(recorded.instance, "v1:first");
			await first.stop();
			await until("the orphaned worker to exit", () => (pidAlive(recorded.pid) ? undefined : true));
			observe(directory, (database) =>
				database.run(
					"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? WHERE run_id = ?",
					STALE_COORDINATOR_AGE_MS,
					ROOT,
				),
			);
			await writeFileEnsuringDir(helper, helperSource("v2"));
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			// The fresh root saved one worker and limits { session: 2, process: 1 }; the settings have changed since.
			second = startCoordinator(directory, "restart", {
				definition,
				settings: {
					localWorkers: { count: 2, definitions: [{ path: definition, exportName: "child" }] },
					admission: { limits: { session: 3, process: 2 } },
				},
			});
			await second.next("ready");
			const result = await second.next("result");
			assert.equal(result.status, "completed", JSON.stringify(result));
			// The step recorded before the crash is replayed, not run again; the step after it runs the edited helper.
			assert.equal(result.outputs?.firstInstance, "v1:first");
			assert.equal(result.outputs?.finalInstance, "v2:final");
			assert.equal(
				observe(directory, (database) =>
					Number(
						database
							.query(
								"SELECT COUNT(*) AS count FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint'",
							)
							.get()!.count,
					),
				),
				1,
			);
			await second.stop();
			// The root records the settings it resumed with, so its next resume starts from them.
			const backend = await JournalDurableBackend.open(
				await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
			);
			try {
				await backend.hydrateWorkflow(ROOT);
				const resources = backend.getWorkflow(ROOT)?.resources;
				assert.equal(resources?.localWorkers?.count, 2);
				assert.deepEqual(resources?.admission?.limits, { session: 3, process: 2 });
			} finally {
				await backend.close();
			}
		} finally {
			await first.stop();
			await second?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);

/** The queued child's work descriptor, as the pool stored it. */
function queuedWork(directory: string): { id: string; digest: string; execution: { executionMode?: string } } {
	const rows = observe(directory, (database) => database.query("SELECT id, descriptor FROM wf_runs_work").all());
	assert.equal(rows.length, 1);
	return { id: String(rows[0]!.id), ...JSON.parse(String(rows[0]!.descriptor)) };
}

/**
 * SIGKILLs a root once its pooled child recorded its first step, waits for that child's orphaned worker to exit, and
 * ages the root's lease past its liveness window, as a resume much later finds it. Returns the worker that recorded it.
 */
async function crashAfterFirstStep(directory: string, root: ReturnType<typeof startCoordinator>): Promise<Worker> {
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

function recordedCheckpoints(directory: string): number {
	return observe(directory, (database) =>
		Number(
			database
				.query("SELECT COUNT(*) AS count FROM wf_events WHERE json_extract(payload, '$.name') = 'checkpoint'")
				.get()!.count,
		),
	);
}

test.skipIf(process.platform === "win32")(
	"a crashed root resumes under another execution mode than it launched with, and its queued child runs under the new one (#4200)",
	async () => {
		const directory = makeTempDirectory("public-pool-resume-mode-");
		const first = startCoordinator(directory, "fresh", { settings: { executionMode: "interactive" } });
		let second: ReturnType<typeof startCoordinator> | undefined;
		try {
			const firstReady = await first.next("ready");
			const recorded = await crashAfterFirstStep(directory, first);
			const queued = queuedWork(directory);
			assert.equal(queued.execution.executionMode, "interactive");
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			// A headless resume of an interactive launch.
			second = startCoordinator(directory, "restart", { settings: { executionMode: "non_interactive" } });
			const secondReady = await second.next("ready");
			const result = await second.next("result");
			assertSingleRootRecovered(directory, recorded, result, [firstReady, secondReady]);
			const rebound = queuedWork(directory);
			assert.equal(rebound.id, queued.id, "the queued child is the same work, not a second one");
			assert.equal(rebound.execution.executionMode, "non_interactive");
		} finally {
			await first.stop();
			await second?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);

/** A child whose entry module itself names the version of it that ran each step. */
const versionedChildSource = (version: string) => `import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";

export const child = workflow({
	name: "pool-resume-entry-child",
	description: "Records a step, then waits for release",
	inputs: { releasePath: Type.String() },
	outputs: { firstPid: Type.Number(), finalPid: Type.Number(), firstInstance: Type.String(), finalInstance: Type.String() },
	async run(ctx) {
		const first = await ctx.tool("checkpoint", {}, async () => ({ pid: process.pid, instance: "${version}:first" }));
		const final = await ctx.tool("finish", {}, async () => {
			while (!existsSync(ctx.inputs.releasePath)) await delay(20);
			return { pid: process.pid, instance: "${version}:final" };
		});
		return { firstPid: first.pid, finalPid: final.pid, firstInstance: first.instance, finalInstance: final.instance };
	},
});
`;

test.skipIf(process.platform === "win32")(
	"a crashed root resumes after its worker's entry module is edited only when the resume accepts the edit, and its queued child runs the edited module (#4200)",
	async () => {
		const directory = makeTempDirectory("public-pool-resume-entry-");
		const definition = join(directory, "workflows", "child.ts");
		await writeFileEnsuringDir(definition, versionedChildSource("v1"));
		const first = startCoordinator(directory, "fresh", { definition });
		let refused: ReturnType<typeof startCoordinator> | undefined;
		let accepted: ReturnType<typeof startCoordinator> | undefined;
		try {
			await first.next("ready");
			const recorded = await crashAfterFirstStep(directory, first);
			assert.equal(recorded.instance, "v1:first");
			const queued = queuedWork(directory);
			await writeFileEnsuringDir(definition, versionedChildSource("v2"));
			const edited = createHash("sha256").update(readFileSync(definition)).digest("hex");
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			// Without the opt-in the resume is refused before it starts; the refusal names the module and the opt-in.
			refused = startCoordinator(directory, "restart", { definition });
			const refusal = (await refused.next("error")).message ?? "";
			assert.ok(
				refusal.includes(
					`the entry module of worker definition ${definition}#child was edited (sha256 ${queued.digest.slice(0, 12)} to ${edited.slice(0, 12)})`,
				),
				refusal,
			);
			assert.match(refusal, /--accept-entry-changes/);
			assert.match(refusal, /acceptEntryChanges/);
			await refused.stop();
			assert.equal(recordedCheckpoints(directory), 1);

			accepted = startCoordinator(directory, "restart", { definition, settings: { acceptEntryChanges: true } });
			await accepted.next("ready");
			const result = await accepted.next("result");
			assert.equal(result.status, "completed", JSON.stringify(result));
			// The step recorded before the crash is replayed, not run again; the step after it runs the edited module.
			assert.equal(result.outputs?.firstInstance, "v1:first");
			assert.equal(result.outputs?.finalInstance, "v2:final");
			assert.equal(recordedCheckpoints(directory), 1);
			const rebound = queuedWork(directory);
			assert.equal(rebound.id, queued.id, "the queued child is the same work, not a second one");
			assert.equal(rebound.digest, edited);
			await accepted.stop();
			// The root records the module it resumed with, so a later resume of it needs no opt-in again.
			const backend = await JournalDurableBackend.open(
				await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
			);
			try {
				await backend.hydrateWorkflow(ROOT);
				assert.deepEqual(
					backend.getWorkflow(ROOT)?.resources?.definitions?.map((source) => source.digest),
					[edited],
				);
			} finally {
				await backend.close();
			}
		} finally {
			await first.stop();
			await refused?.stop();
			await accepted?.stop();
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
