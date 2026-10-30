import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const [mode, directory, workerCount] = process.argv.slice(2);
const CHILDREN = 3;
const ROOT = process.env.POOL_RESUME_ROOT ?? "3890e5c0-0000-4000-8000-000000003890";
const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { workflow } = await load("../../packages/workflows/src/authoring/workflow.ts");
const { JournalDurableBackend } = await load("../../packages/workflows/src/durable/journal/journal-backend.ts");
const { resolveRunJournal } = await load("../../packages/workflows/src/durable/journal/resolution.ts");
const { resumeDurableWorkflow } = await load("../../packages/workflows/src/durable/resume-runtime.ts");
const { run } = await load("../../packages/workflows/src/engine/run.ts");
const { createJobTracker } = await load("../../packages/workflows/src/runs/background/job-tracker.ts");
const { createStore } = await load("../../packages/workflows/src/shared/store.ts");
const { createRegistry } = await load("../../packages/workflows/src/workflows/registry.ts");
const { definitionDigest, loadWorkerDefinition } = await load("../../packages/workflows/src/workers/definitions.ts");
const { LocalWorkerPool } = await load("../../packages/workflows/src/workers/local-pool.ts");
const { coordinationPath, poolDurableJournal } = await load("../../packages/workflows/src/workers/pool-journal.ts");

const path = join(directory, "journal.sqlite");
// The journal is opened through a storage adapter, so the pool keeps its tables in a coordination database of its own:
//   adapter  a delegating adapter that is not a SQL journal to the pool, over the SQLite file `path`;
//   libsql   the libSQL adapter over `path` as a file: URL;
//   sqld     the libSQL adapter over the server at POOL_RESUME_LIBSQL_URL.
// Unset, the journal is `path` itself and the pool shares it.
const kind = process.env.POOL_RESUME_JOURNAL;
const remote = kind !== undefined;
const libsqlUrl = kind === "sqld" ? process.env.POOL_RESUME_LIBSQL_URL : pathToFileURL(path).href;
const adapterOptions = {
	adapter: fileURLToPath(
		new URL(kind === "adapter" ? "./delegating-run-journal-adapter.mjs" : "../../packages/storage-libsql/libsql.js", import.meta.url),
	),
	options:
		kind === "adapter"
			? { path }
			: { url: libsqlUrl, ...(process.env.POOL_RESUME_LIBSQL_NAMESPACE ? { namespace: process.env.POOL_RESUME_LIBSQL_NAMESPACE } : {}) },
};
const open = () =>
	resolveRunJournal(
		remote ? { agentDir: join(directory, "home", "agent"), journal: adapterOptions } : { journal: { path } },
	);
let journal = remote ? await open() : undefined;
const poolPath = remote ? coordinationPath(poolDurableJournal(journal)) : path;
const childPath = fileURLToPath(new URL("./pool-resume-child.ts", import.meta.url));
const exportName = "resumedChild";

if (mode === "resume") {
	if (kind === "libsql" || kind === "sqld") {
		// Through the adapter that owns the journal: another SQLite library writing a libSQL file in WAL mode is not safe.
		const { openLibsqlDatabase } = await import("../../packages/storage-libsql/libsql.js");
		const database = await openLibsqlDatabase(adapterOptions.options);
		await database.run("UPDATE wf_leases SET renewed_at = 0 WHERE run_id = ?", ROOT);
		await database.close();
	} else {
		const database = new DatabaseSync(path);
		database.exec("PRAGMA busy_timeout=5000");
		database.exec("UPDATE wf_leases SET renewed_at = 0");
		database.close();
	}
	const work = new DatabaseSync(poolPath);
	work.exec("UPDATE wf_runs_work SET expires_at = expires_at + 3600000 WHERE state = 'leased'");
	work.close();
	writeFileSync(join(directory, "release"), "");
}

journal ??= await open();
const backend = await JournalDurableBackend.open(journal);
const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
const pool = new LocalWorkerPool(backend, {
	journalPath: poolPath,
	...(remote ? { durable: poolDurableJournal(journal) } : {}),
	workers: Number(workerCount),
	definitions: [{ definition: child, path: childPath, exportName }],
});
const children = [];
const parent = workflow({
	name: "pool-resume-root",
	description: "Root whose host process dies while pooled children hold leases",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const results = await Promise.all(
			Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { directory, index } })),
		);
		for (const result of results) children.push({ status: result.status, ...result.outputs });
		return {};
	},
});

try {
	const store = createStore();
	if (mode === "start") {
		await run(parent, {}, { runId: ROOT, cwd: directory, store, durableBackend: backend });
		throw new Error("The start process must be killed before its children finish");
	}
	const jobs = createJobTracker();
	let completion;
	const resumed = await resumeDurableWorkflow(ROOT, {
		registry: createRegistry().register(parent),
		baseRunOpts: { store, cwd: directory },
		durableBackend: backend,
		jobs,
		onRunAccepted: (id) => {
			completion = jobs.get(id)?.promise;
		},
	});
	if (!resumed.ok) throw new Error(`Resume rejected: ${resumed.message}`);
	await completion;
	const record = store.runs().find((candidate) => candidate.id === ROOT);
	writeFileSync(
		join(directory, "outcome.json"),
		JSON.stringify({ status: record?.status, error: record?.error ?? null, children, workerPids: pool.workerPids }),
	);
} finally {
	await pool.close();
	await backend.close();
}
