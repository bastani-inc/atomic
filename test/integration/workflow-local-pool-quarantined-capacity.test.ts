/**
 * A real local worker whose stage's tool is refused capacity that only a quarantined permit holds.
 *
 * Before the root starts, a process permit of the root is bound to a live process group that survives its reap, so it
 * stays granted and quarantined and fills `admission.limits.process` = 1. The pooled child's agent stage then runs one
 * bash command on a real worker. Its process admission is refused once the bound passes; the stage's bash tool reports
 * the refusal to the model, which ends its turn as if nothing happened. The worker must still end the attempt as a
 * fault of the pool, so the child replays within its attempt limit and then fails, instead of completing.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { beforeAll, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { isRetryableWorkflowError } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import * as admissionHost from "../../packages/workflows/src/workers/admission-host.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	QUARANTINED_CAPACITY_WAIT_MS,
	SqlResourceAdmission,
} from "../../packages/workflows/src/workers/resource-admission.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, readTextSync, removeTempDirectory, sleep } from "../helpers/runtime.js";

/** Three attempts, each refused once the bound passes, plus starting a coordinator, workers and real stages. */
const FINISH_WITHIN_MS = 3 * QUARANTINED_CAPACITY_WAIT_MS + 90_000;
const TEST_TIMEOUT_MS = FINISH_WITHIN_MS + 60_000;
const ADMISSION = { limits: { process: 1 } };

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

/** A detached `sleep` process group the kernel reports as existing until the test kills it. */
async function liveGroup(): Promise<{ readonly group: number; kill(): Promise<void> }> {
	const leader: ChildProcess = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
	const exited = once(leader, "exit");
	await once(leader, "spawn");
	return {
		group: leader.pid!,
		async kill() {
			if (leader.exitCode !== null || leader.signalCode !== null) return;
			process.kill(-leader.pid!, "SIGKILL");
			await exited;
		},
	};
}

/**
 * Binds a permit of `root` to `group` for a worker that exited, then reaps that worker's groups with a probe that never
 * reports the group gone: the permit stays granted and quarantined, as a group that survived SIGKILL leaves it.
 */
async function quarantine(admission: SqlResourceAdmission, group: number): Promise<void> {
	const permit = await admission.acquire("process");
	await permit.bindProcess!({ kind: "unix-process-group", id: group });
	const probe = vi.spyOn(admissionHost, "processGroupState").mockReturnValue("alive");
	const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
	const pause = vi.spyOn(admissionHost, "reapPause").mockResolvedValue();
	try {
		assert.equal(await admission.releaseStoppedSessions("exited-worker"), 1);
		assert.deepEqual(await admission.reapStoppedProcesses("exited-worker"), [group]);
	} finally {
		probe.mockRestore();
		signal.mockRestore();
		pause.mockRestore();
	}
}

function workRow(path: string, root: string): { readonly state: string; readonly generation: number } {
	const journal = new DatabaseSync(path, { readOnly: true });
	try {
		const row = journal.prepare("SELECT state, generation FROM wf_runs_work WHERE root = ?").get(root);
		assert.ok(row);
		return { state: String(row.state), generation: Number(row.generation) };
	} finally {
		journal.close();
	}
}

test.skipIf(process.platform === "win32")(
	"a real worker whose stage's tool shrugs off a quarantined-capacity refusal still ends its attempt as a fault of the pool",
	async () => {
		const directory = makeTempDirectory("pool-quarantined-capacity-");
		const path = join(directory, "journal.sqlite");
		const root = testRunId("pool-quarantined-capacity");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const group = await liveGroup();
		const childPath = fileURLToPath(new URL("../fixtures/pool-quarantined-capacity-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			admission: ADMISSION,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		try {
			const admission = await SqlResourceAdmission.open(journal, { ...ADMISSION, root, holder: "exited-worker" });
			await quarantine(admission, group.group);
			const outcomes: PromiseSettledResult<{ readonly status: string }>[] = [];
			const execution = run(
				workflow({
					name: "pool-quarantined-capacity-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						outcomes.push(...(await Promise.allSettled([ctx.workflow(child, { inputs: { directory } })])));
						return {};
					},
				}),
				{},
				{ runId: root, cwd: directory, store: createStore(), durableBackend: backend },
			);
			const result = await Promise.race([
				execution,
				sleep(FINISH_WITHIN_MS).then(() => {
					throw new Error(`The root did not finish within ${FINISH_WITHIN_MS} ms`);
				}),
			]);
			assert.equal(result.status, "completed", result.error);
			assert.equal(outcomes.length, 1);
			const [outcome] = outcomes;
			assert.equal(
				outcome!.status,
				"rejected",
				"the stage went on after its tool's refusal, but the attempt still ended on the pool's fault",
			);
			const failure = outcome!.status === "rejected" ? (outcome!.reason as Error) : undefined;
			assert.ok(failure instanceof Error);
			assert.ok(isRetryableWorkflowError(failure), String(failure));
			assert.match(
				failure.message,
				new RegExp(
					`Local worker retry limit: child \\S+ \\(child\\) failed on a fault of the pool on every attempt \\(last: Local worker process cleanup unconfirmed; process permit refused after \\d+ ms: admission\\.limits\\.process \\(1\\) is held by quarantined permits of process groups ${group.group} that survived SIGKILL\\)`,
				),
			);
			assert.deepEqual(workRow(path, root), { state: "failed", generation: 3 });
			assert.equal(
				readTextSync(join(directory, "attempts.log"), "utf8").trim().split("\n").length,
				3,
				"each attempt's stage asked for the command once",
			);
			assert.deepEqual(
				(await admission.inspect())
					.filter((permit) => permit.kind === "process" && permit.state !== "released")
					.map((permit) => [permit.holder, permit.state, permit.reason]),
				[["exited-worker", "granted", "cleanup unconfirmed; permit quarantined"]],
				"the quarantined permit keeps its capacity, and no refused admission holds any",
			);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			await group.kill();
			removeTempDirectory(directory);
		}
	},
	TEST_TIMEOUT_MS,
);
