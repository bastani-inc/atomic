import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

function writeJsonAtomically(path, value) {
	writeFileSync(`${path}.tmp`, JSON.stringify(value));
	renameSync(`${path}.tmp`, path);
}


// Root host whose pooled children journal stage transcripts before it is killed.
// Arguments: mode directory rootId children failing finishing. `start` runs until the test
// SIGKILLs it; `resume` resumes the crashed root and writes outcome.json once it settles.
const [mode, directory, root, workerCount, failing = "0", finishing = "0"] = process.argv.slice(2);
const CHILDREN = Number(workerCount);
const outcome = (index) =>
	index < Number(failing) ? "fail" : index < Number(failing) + Number(finishing) ? "finish" : "hold";
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
const childPath = fileURLToPath(new URL("./pool-sigkill-status-child.ts", import.meta.url));
const exportName = "sessionChild";

if (mode === "resume") {
	// The killed host's root lease would otherwise stay fresh for its whole timeout. Its work
	// leases are pushed past the test so only the resumed incarnation's epoch fence frees them.
	const database = new DatabaseSync(path);
	database.exec("UPDATE wf_leases SET renewed_at = 0");
	database.exec("UPDATE wf_runs_work SET expires_at = expires_at + 3600000 WHERE state = 'leased'");
	database.close();
}

const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
const pool = new LocalWorkerPool(backend, {
	journalPath: path,
	workers: CHILDREN,
	definitions: [{ definition: child, path: childPath, exportName }],
});
const reportWorkers = setInterval(() => {
	writeJsonAtomically(join(directory, `workers-${mode}.json`), pool.workerPids);
	if (pool.coordinatorPid !== undefined)
		writeJsonAtomically(join(directory, `coordinator-${mode}.json`), pool.coordinatorPid);
}, 50);
const parent = workflow({
	name: "pool-sigkill-status-root",
	description: "Root whose host is killed while pooled children hold journaled stage sessions",
	inputs: {},
	outputs: {},
	async run(ctx) {
		// Children fail or finish after journaling a stage, or hold mid-stage; the root tolerates failures
		// and records how each child settled in this process.
		const settled = (index, line) => appendFileSync(join(directory, `settled-${mode}.log`), `${index} ${line}\n`);
		await Promise.allSettled(
			Array.from({ length: CHILDREN }, (_, index) =>
				ctx.workflow(child, { inputs: { directory, index, outcome: outcome(index) } }).then(
					(result) => settled(index, result.status),
					(error) => {
						settled(index, `rejected: ${error.message}`);
						throw error;
					},
				),
			),
		);
		return {};
	},
});

try {
	const store = createStore();
	if (mode === "start") {
		const result = await run(parent, {}, { runId: root, cwd: directory, store, durableBackend: backend });
		throw new Error(`The start process must be killed before its children finish: ${JSON.stringify(result)}`);
	}
	const jobs = createJobTracker();
	let completion;
	const resumed = await resumeDurableWorkflow(root, {
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
	const record = store.runs().find((candidate) => candidate.id === root);
	writeJsonAtomically(join(directory, "outcome.json"), { status: record?.status, error: record?.error ?? null });
} finally {
	clearInterval(reportWorkers);
	await pool.close();
	await backend.close();
}
