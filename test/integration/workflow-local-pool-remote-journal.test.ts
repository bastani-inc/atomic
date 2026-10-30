import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import {
	closeCoordinationJournals,
	coordinationPath,
	poolDurableJournal,
	poolHostId,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import { expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";
import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "../helpers/runtime.js";

const REMOTE_JOURNAL_POOL_TIMEOUT_MS = 180_000;
const adapter = fileURLToPath(new URL("../fixtures/delegating-run-journal-adapter.mjs", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));

function tablesOf(path: string): string[] {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all()
			.map((row) => String(row.name));
	} finally {
		database.close();
	}
}

/**
 * The root's journal is opened through a storage adapter that only implements the public RunJournal members, so the
 * pool cannot reach its tables in its own SQL transactions; the adapter's file stands in for a remote database that
 * every pool process opens by the same selection.
 */
test.skipIf(process.platform === "win32").each([{ crash: false }, { crash: true }])(
	"a pooled root runs on a journal in another database, with a dead worker's child replayed from it=$crash",
	async ({ crash }) => {
		const directory = makeTempDirectory("remote-journal-pool-");
		const agentDir = join(directory, "home", "agent");
		const remote = join(directory, "remote.sqlite");
		const log = join(directory, "appends.jsonl");
		const journal = await resolveRunJournal({ agentDir, journal: { adapter, options: { path: remote, log } } });
		const backend = await JournalDurableBackend.open(journal);
		const child = await loadWorkerWorkflow(childPath, "child");
		const store = createStore();
		const parent = workflow({
			name: "remote-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const children = await Promise.all(
					[crash, false].map((dies) =>
						ctx.workflow(child, { inputs: { crash: dies, during: false, journalPath: remote } }),
					),
				);
				assert.ok(children.every((result) => result.status === "completed"));
				assert.equal(new Set(children.map((result) => result.outputs.firstPid)).size, 2);
				assert.ok(children.every((result) => result.outputs.firstPid !== process.pid));
				// The instance id of a process is never reused; its pid may be.
				if (crash) assert.notEqual(children[0]!.outputs.firstInstance, children[0]!.outputs.finalInstance);
				assert.equal(children[1]!.outputs.firstInstance, children[1]!.outputs.finalInstance);
				// A replacement replays what the dead worker committed: its stage session is the first process's.
				assert.equal(Number(children[0]!.outputs.stagePid), children[0]!.outputs.firstPid);
				return {};
			},
		});
		try {
			const result = await run(
				parent,
				{},
				{
					runId: "remote-root",
					store,
					cwd: directory,
					durableBackend: backend,
					localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
					admission: { limits: { session: 2, process: 2 } },
				},
			);
			assert.equal(result.status, "completed", JSON.stringify(result));

			// The pool's tables live in this machine's coordination database, never in the journal's.
			const durable = poolDurableJournal(journal);
			const pool = coordinationPath(durable);
			assert.ok(pool.startsWith(join(directory, "home", "workflows", "pool")), pool);
			assert.ok(existsSync(pool), "the coordination database exists");
			assert.equal(tablesOf(remote).filter((name) => /work|pool|resource/.test(name)).length, 0);
			const coordination = tablesOf(pool);
			assert.ok(coordination.includes("wf_runs_work") && coordination.includes("wf_runs_pool_outbox"));
			const poolDatabase = new DatabaseSync(pool, { readOnly: true });
			try {
				assert.equal(Number(poolDatabase.prepare("SELECT COUNT(*) AS n FROM wf_events").get()!.n), 0);
				// One work item per child; the dead worker's is attempted twice.
				assert.deepEqual(
					poolDatabase
						.prepare("SELECT generation FROM wf_runs_work ORDER BY generation")
						.all()
						.map((row) => Number(row.generation)),
					crash ? [1, 2] : [1, 1],
				);
				assert.equal(Number(poolDatabase.prepare("SELECT COUNT(*) AS n FROM wf_runs_pool_outbox").get()!.n), 0);
			} finally {
				poolDatabase.close();
			}

			// Every checkpoint is in the journal, once: a key the journal already had answers `exists`, never a second event.
			const appends = readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { type: string; key: string | null; status: string });
			const appended = appends.filter((entry) => entry.status === "appended" && entry.key !== null);
			assert.equal(new Set(appended.map((entry) => entry.key)).size, appended.length, "no key was recorded twice");
			await backend.hydrateWorkflow("remote-root");
			const checkpoints = backend.listCheckpoints("remote-root");
			const starts = checkpoints.filter(
				(entry) =>
					entry.kind === "stage" &&
					entry.topology?.boundary?.event === "start" &&
					entry.topology.run?.runId === "remote-root",
			);
			assert.equal(starts.length, 2);
			assert.deepEqual(backend.getWorkflow("remote-root")?.resources?.coordinator, { host: poolHostId(agentDir) });

			// A finished pooled stage's transcript is read from the coordination database through the journal's identity.
			const sessions = await poolSessionStore(backend);
			assert.ok(sessions, "pooled stage sessions are reachable");
			try {
				const ids = checkpoints.flatMap((entry) =>
					entry.kind === "stage" && entry.sessionId ? [entry.sessionId] : [],
				);
				assert.ok(ids.length >= 2);
				for (const id of ids) assert.ok((await sessions.load(id)).entries.length > 0);
			} finally {
				await sessions.close();
			}
		} finally {
			await backend.close();
			await closeCoordinationJournals();
			removeTempDirectory(directory);
		}
	},
	REMOTE_JOURNAL_POOL_TIMEOUT_MS,
);

const CHILDREN = 3;
/** A root process over one pool: it loads the workflow runtime through jiti itself, and its pool starts three more. */
const ROOT_PROCESS_COLD_STARTS = 4;
const rootFixture = fileURLToPath(new URL("../fixtures/pool-resume-root.mjs", import.meta.url));
const RESUME_BUDGET = (() => {
	const waitMs = Math.min(poolTestBudgetMs(2 * ROOT_PROCESS_COLD_STARTS).waitMs, 600_000 - POOL_CLEANUP_HEADROOM_MS);
	return { waitMs, timeoutMs: waitMs + POOL_CLEANUP_HEADROOM_MS };
})();

function startedWorkers(directory: string): number[] {
	return readdirSync(directory)
		.filter((name) => name.startsWith("started-"))
		.map((name) => Number(name.split("-")[2]));
}

/** The crashed root and its resumed incarnation each run in their own process, one after the other. */
test.skipIf(process.platform === "win32")(
	"resuming a crashed pooled root on a journal in another database replays its children from the journal and the coordination database (#3890)",
	async () => {
		const deadline = Date.now() + RESUME_BUDGET.waitMs;
		const directory = makeTempDirectory("pool-remote-root-resume-");
		const env = { ...process.env, POOL_RESUME_JOURNAL: "adapter" };
		try {
			const crashed = spawnWithinBudget(
				[process.execPath, rootFixture, "start", directory, String(CHILDREN)],
				{ cwd: directory, stdout: "ignore", env },
				deadline,
			);
			while (startedWorkers(directory).length < CHILDREN) {
				if (crashed.process.exitCode !== null)
					assert.fail(
						`the crashed root ended before its children started:\n${await expectExitedCleanly(crashed)}`,
					);
				await sleep(50);
			}
			const deadWorkers = startedWorkers(directory);
			crashed.process.kill("SIGKILL");
			await crashed.process.exited;

			const resumed = spawnWithinBudget(
				[process.execPath, rootFixture, "resume", directory, String(CHILDREN)],
				{ cwd: directory, stdout: "ignore", env },
				deadline,
			);
			const stderr = await expectExitedCleanly(resumed);
			assert.doesNotMatch(stderr, /Stale work lease|cleanup was not confirmed/);
			const outcome = await readJson<{
				status: string;
				children: { status: string; firstPid: number; finalPid: number }[];
				workerPids: number[];
			}>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.equal(outcome.children.length, CHILDREN);
			for (const child of outcome.children) {
				assert.equal(child.status, "completed");
				assert.ok(
					deadWorkers.includes(child.firstPid),
					"the committed checkpoint is replayed from the journal, not repeated",
				);
				assert.ok(outcome.workerPids.includes(child.finalPid), "a worker of the resumed root finished the child");
			}
			// The resumed root reopened the one coordination database; the journal still holds no pool table.
			assert.equal(
				tablesOf(join(directory, "journal.sqlite")).filter((name) => /work|pool|resource/.test(name)).length,
				0,
			);
		} finally {
			removeTempDirectory(directory);
		}
	},
	RESUME_BUDGET.timeoutMs,
);
