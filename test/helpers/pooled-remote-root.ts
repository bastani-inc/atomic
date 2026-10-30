import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import {
	closeCoordinationJournals,
	coordinationDatabase,
	coordinationPath,
	poolDurableJournal,
	poolHostId,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import { expectExitedCleanly, spawnWithinBudget } from "./budgeted-process.js";
import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "./pool-budget.js";
import { makeTempDirectory, readJson, removeTempDirectory, sleep } from "./runtime.js";

export const REMOTE_JOURNAL_POOL_TIMEOUT_MS = 180_000;
const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
const rootFixture = fileURLToPath(new URL("../fixtures/pool-resume-root.mjs", import.meta.url));

type Row = Record<string, unknown>;
type JournalSettings = NonNullable<Parameters<typeof resolveRunJournal>[0]>["journal"];

/** A journal in another database, as one test opens it. */
export interface JournalFlavor {
	/** The selection the root and every pool process open the journal with. */
	readonly journal: JournalSettings;
	/** `POOL_RESUME_JOURNAL` and what that mode of `pool-resume-root.mjs` needs besides. */
	readonly resumeEnv: Record<string, string>;
	/** A child's fan-out barrier reads this file when the journal is one that node:sqlite may read; otherwise the children leave markers. */
	readonly journalFile?: string;
	/** Appends the adapter logged, when it logs them. */
	readonly appendLog?: string;
	/** A read-only statement on the journal's own database, outside the pool. */
	query(sql: string, ...args: (string | number)[]): Promise<Row[]>;
	/** Removes what a run left in a database that outlives the test. */
	forget?(runId: string): Promise<void>;
}

/** The journal is a SQLite file read directly; `forget` is not needed because the file goes with the directory. */
export function fileFlavor(
	path: string,
	journal: JournalSettings,
	resumeEnv: Record<string, string>,
	appendLog?: string,
): JournalFlavor {
	return {
		journal,
		resumeEnv,
		journalFile: path,
		...(appendLog === undefined ? {} : { appendLog }),
		async query(sql, ...args) {
			const database = new DatabaseSync(path, { readOnly: true });
			try {
				return database.prepare(sql).all(...args) as Row[];
			} finally {
				database.close();
			}
		},
	};
}

/**
 * The journal is a libSQL database, a file or a server, read through the adapter and never by another SQLite library: a
 * file the libSQL driver has open in WAL mode must not be read by one. A server outlives the test, so `shared` removes
 * the run's rows. `namespace` selects a sqld namespace.
 */
export function libsqlFlavor(
	url: string,
	adapter: string,
	{
		resume,
		shared,
		namespace,
	}: { readonly resume: Record<string, string>; readonly shared: boolean; readonly namespace?: string | undefined },
): JournalFlavor {
	const withDatabase = async <T>(use: (database: Awaited<ReturnType<typeof openLibsqlDatabase>>) => Promise<T>) => {
		const database = await openLibsqlDatabase({ url, ...(namespace === undefined ? {} : { namespace }) });
		try {
			return await use(database);
		} finally {
			await database.close();
		}
	};
	return {
		journal: { adapter, options: { url, ...(namespace === undefined ? {} : { namespace }) } },
		resumeEnv: { ...resume, ...(namespace === undefined ? {} : { POOL_RESUME_LIBSQL_NAMESPACE: namespace }) },
		query: (sql, ...args) => withDatabase((database) => database.all(sql, ...args)),
		...(shared
			? {
					forget: (runId: string) =>
						withDatabase(async (database) => {
							for (const table of ["wf_events", "wf_leases", "wf_runs"])
								await database.run(`DELETE FROM ${table} WHERE run_id = ?`, runId);
						}),
				}
			: {}),
	};
}

function sqlite(path: string): DatabaseSync {
	return new DatabaseSync(path, { readOnly: true });
}

/** Every table of the journal's database, and that none of them is the pool's. */
async function assertNoPoolTables(flavor: JournalFlavor): Promise<void> {
	const tables = (await flavor.query("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) =>
		String(row.name),
	);
	assert.deepEqual(
		tables.filter((name) => /_work|pool|resource/.test(name)),
		[],
		"the journal holds none of the pool's tables",
	);
}

/**
 * A root with two children in a pool of two workers, on `flavor`'s journal. With `crash`, one child's worker is killed
 * after a committed checkpoint and the replacement replays it from the journal. Every process of the pool opens the
 * journal by the same selection, and the pool's own tables live only in the machine's coordination database.
 */
export async function runPooledRoot(
	flavor: (directory: string) => JournalFlavor,
	{ crash, label }: { readonly crash: boolean; readonly label: string },
): Promise<void> {
	const directory = makeTempDirectory(`${label}-`);
	const agentDir = join(directory, "home", "agent");
	const barrierDirectory = join(directory, "arrivals");
	mkdirSync(barrierDirectory);
	const rootId = `remote-root-${randomUUID()}`;
	const selected = flavor(directory);
	const journal = await resolveRunJournal({ agentDir, journal: selected.journal });
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
					ctx.workflow(child, {
						inputs: {
							crash: dies,
							during: false,
							journalPath: selected.journalFile ?? "",
							...(selected.journalFile === undefined ? { barrierDirectory } : {}),
						},
					}),
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
				runId: rootId,
				store,
				cwd: directory,
				durableBackend: backend,
				localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
				admission: { limits: { session: 2, process: 2 } },
			},
		);
		assert.equal(result.status, "completed", JSON.stringify(result));

		// The pool's tables live in this machine's coordination database, never in the journal's.
		const pool = coordinationPath(poolDurableJournal(journal));
		assert.ok(pool.startsWith(join(directory, "home", "workflows", "pool")), pool);
		assert.ok(existsSync(pool), "the coordination database exists");
		await assertNoPoolTables(selected);
		const poolDatabase = sqlite(pool);
		try {
			const names = poolDatabase
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all()
				.map((row) => String(row.name));
			assert.ok(names.includes("wf_runs_work") && names.includes("wf_runs_pool_outbox"));
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
		assert.deepEqual(
			await selected.query(
				"SELECT key, COUNT(*) AS n FROM wf_events WHERE run_id = ? AND key IS NOT NULL GROUP BY key HAVING COUNT(*) > 1",
				rootId,
			),
			[],
			"no key was recorded twice",
		);
		if (selected.appendLog !== undefined) {
			const appended = readFileSync(selected.appendLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { key: string | null; status: string })
				.filter((entry) => entry.status === "appended" && entry.key !== null);
			assert.equal(new Set(appended.map((entry) => entry.key)).size, appended.length, "no key was appended twice");
		}
		await backend.hydrateWorkflow(rootId);
		const checkpoints = backend.listCheckpoints(rootId);
		const starts = checkpoints.filter(
			(entry) =>
				entry.kind === "stage" &&
				entry.topology?.boundary?.event === "start" &&
				entry.topology.run?.runId === rootId,
		);
		assert.equal(starts.length, 2);
		assert.deepEqual(backend.getWorkflow(rootId)?.resources?.coordinator, {
			host: poolHostId(agentDir),
			database: coordinationDatabase(poolDurableJournal(journal)),
		});

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
		await selected.forget?.(rootId).catch(() => {});
		removeTempDirectory(directory);
	}
}

const CHILDREN = 3;
/** A root process over one pool: it loads the workflow runtime through jiti itself, and its pool starts three more. */
const ROOT_PROCESS_COLD_STARTS = 4;
const RESUME_BUDGET = (() => {
	const waitMs = Math.min(poolTestBudgetMs(2 * ROOT_PROCESS_COLD_STARTS).waitMs, 600_000 - POOL_CLEANUP_HEADROOM_MS);
	return { waitMs, timeoutMs: waitMs + POOL_CLEANUP_HEADROOM_MS };
})();
export const REMOTE_JOURNAL_RESUME_TIMEOUT_MS = RESUME_BUDGET.timeoutMs;

function startedWorkers(directory: string): number[] {
	return readdirSync(directory)
		.filter((name) => name.startsWith("started-"))
		.map((name) => Number(name.split("-")[2]));
}

/**
 * The crashed root and its resumed incarnation each run in their own process, one after the other: the root is
 * SIGKILLed while three children hold leases, and a new process resumes it on the same journal.
 */
export async function resumeCrashedRoot(
	flavor: (directory: string) => JournalFlavor,
	{ label }: { readonly label: string },
): Promise<void> {
	const deadline = Date.now() + RESUME_BUDGET.waitMs;
	const directory = makeTempDirectory(`${label}-`);
	// A resumed run id is a full UUID.
	const rootId = randomUUID();
	const selected = flavor(directory);
	const env = { ...process.env, ...selected.resumeEnv, POOL_RESUME_ROOT: rootId };
	try {
		const crashed = spawnWithinBudget(
			[process.execPath, rootFixture, "start", directory, String(CHILDREN)],
			{ cwd: directory, stdout: "ignore", env },
			deadline,
		);
		while (startedWorkers(directory).length < CHILDREN) {
			if (crashed.process.exitCode !== null)
				assert.fail(`the crashed root ended before its children started:\n${await expectExitedCleanly(crashed)}`);
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
		await assertNoPoolTables(selected);
	} finally {
		await selected.forget?.(rootId).catch(() => {});
		removeTempDirectory(directory);
	}
}
