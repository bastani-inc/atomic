import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [mode, directory, workerCount] = process.argv.slice(2);
const CHILDREN = 3;
const ROOT = "3890e5c0-0000-4000-8000-000000003890";
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

const path = join(directory, "journal.sqlite");
const childPath = fileURLToPath(new URL("./pool-resume-child.ts", import.meta.url));
const exportName = "resumedChild";

if (mode === "resume") {
	const database = new DatabaseSync(path);
	database.exec("UPDATE wf_leases SET renewed_at = 0");
	database.exec("UPDATE wf_runs_work SET expires_at = expires_at + 3600000 WHERE state = 'leased'");
	database.close();
	writeFileSync(join(directory, "release"), "");
}

const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
const pool = new LocalWorkerPool(backend, {
	journalPath: path,
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
