import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// A root of a shared pool (#4310), as one host runs it. `start` runs it; `resume` takes over a root whose host died,
// from another host. The host this process stands in for is SHARED_POOL_HOST; its agent directory SHARED_POOL_AGENT_DIR.
const [mode, directory, children, workers, scenario = "fanout"] = process.argv.slice(2);
const ROOT = process.env.SHARED_POOL_ROOT;
const jiti = createJiti(import.meta.url, { fsCache: true });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { workflow } = await load("../../packages/workflows/src/authoring/workflow.ts");
const { JournalDurableBackend } = await load("../../packages/workflows/src/durable/journal/journal-backend.ts");
const { resolveRunJournal } = await load("../../packages/workflows/src/durable/journal/resolution.ts");
const { resumeDurableWorkflow } = await load("../../packages/workflows/src/durable/resume-runtime.ts");
const { run } = await load("../../packages/workflows/src/engine/run.ts");
const { createJobTracker } = await load("../../packages/workflows/src/runs/background/job-tracker.ts");
const { createStore } = await load("../../packages/workflows/src/shared/store.ts");
const { createRegistry } = await load("../../packages/workflows/src/workflows/registry.ts");
const { loadWorkerWorkflow } = await load("../../packages/workflows/src/workers/definitions.ts");
const { isWorkspaceRestoreUnavailableError } = await load("../../packages/workflows/src/workers/placement-errors.ts");
const placementCode = (error) => {
	for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++)
		if (current.name === "WorkspaceRestoreUnavailableError") return current.code;
	return null;
};

const childPath = fileURLToPath(new URL("./shared-pool-child.ts", import.meta.url));
const exportName = { bound: "boundChild", distributed: "distributedChild" }[scenario] ?? "sharedChild";
// A journal whose server needs a token reads it from a file every host has (SHARED_POOL_TOKEN_FILE).
const secrets =
	process.env.SHARED_POOL_TOKEN_FILE === undefined ? {} : { secrets: { authToken: { file: process.env.SHARED_POOL_TOKEN_FILE } } };
const journal = await resolveRunJournal({
	agentDir: process.env.SHARED_POOL_AGENT_DIR,
	journal: {
		adapter: process.env.SHARED_POOL_ADAPTER,
		options: { url: process.env.SHARED_POOL_URL },
		prefix: process.env.SHARED_POOL_PREFIX,
		...secrets,
	},
});
const prefix = process.env.SHARED_POOL_PREFIX ?? "";
const backend = await JournalDurableBackend.open(journal);
const child = await loadWorkerWorkflow(childPath, exportName);
const outcomes = [];
const binding = process.env.SHARED_POOL_BINDING === undefined ? undefined : JSON.parse(process.env.SHARED_POOL_BINDING);
const parent = workflow({
	name: "shared-pool-root",
	description: "Root whose pooled children run on workers of several hosts",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const results = await Promise.allSettled(
			Array.from({ length: Number(children) }, (_, index) =>
				ctx.workflow(child, {
					inputs:
						scenario === "bound"
							? {}
							: scenario === "distributed"
								? { index, workMs: Number(process.env.SHARED_POOL_WORK_MS ?? "5000") }
								: { directory, index, hosts: 2 },
				}),
			),
		);
		for (const result of results)
			outcomes.push(
				result.status === "fulfilled"
					? { status: result.value.status, error: result.value.error ?? null, ...result.value.outputs }
					: {
							status: "rejected",
							error: result.reason?.message ?? String(result.reason),
							name: result.reason?.name ?? null,
							// The placement error the child failed on, found through the cause chain as the guard finds it.
							code: isWorkspaceRestoreUnavailableError(result.reason) ? placementCode(result.reason) : null,
						},
			);
		return {};
	},
});
const options = {
	localWorkers: { count: Number(workers), definitions: [{ path: childPath, exportName }] },
	workers: {
		placement: "shared",
		...(binding === undefined ? {} : { workspace: binding }),
		...(process.env.SHARED_POOL_CLAIM_WINDOW_MS === undefined ? {} : { claimWindowMs: Number(process.env.SHARED_POOL_CLAIM_WINDOW_MS) }),
	},
	admission: { limits: { session: Number(process.env.SHARED_POOL_SESSIONS ?? "8") } },
};

// Answers every ctx.ui prompt of the root's children, wherever they run.
const ui = {
	async input() {
		return "answer-from-root";
	},
	async confirm() {
		return false;
	},
	async select(_message, choices) {
		return choices[0];
	},
	async editor() {
		return "";
	},
	async custom() {
		throw new Error("The shared pool fixture shows no custom prompt");
	},
};
const store = createStore();
let record;
try {
	if (mode === "start") {
		const result = await run(parent, {}, { runId: ROOT, cwd: directory, store, ui, durableBackend: backend, ...options });
		record = { status: result.status, error: result.error ?? null };
	} else {
		// The dead host's root lease would expire on its own; the test does not wait for that.
		const { openLibsqlDatabase } = await import("../../packages/storage-libsql/libsql.js");
		const { readFileSync } = await import("node:fs");
		const database = await openLibsqlDatabase({
			url: process.env.SHARED_POOL_URL,
			...(process.env.SHARED_POOL_TOKEN_FILE === undefined
				? {}
				: { authToken: readFileSync(process.env.SHARED_POOL_TOKEN_FILE, "utf8").trim() }),
		});
		await database.run(`UPDATE ${prefix}wf_leases SET renewed_at = 0 WHERE run_id = ?`, ROOT);
		await database.close();
		const jobs = createJobTracker();
		let completion;
		const resumed = await resumeDurableWorkflow(ROOT, {
			registry: createRegistry().register(parent),
			baseRunOpts: { store, cwd: directory, ui },
			durableBackend: backend,
			jobs,
			onRunAccepted: (id) => {
				completion = jobs.get(id)?.promise;
			},
		});
		if (!resumed.ok) throw new Error(`Resume rejected: ${resumed.message}`);
		await completion;
		const root = store.runs().find((candidate) => candidate.id === ROOT);
		record = { status: root?.status, error: root?.error ?? null };
	}
	writeFileSync(join(directory, `outcome-${mode}.json`), JSON.stringify({ ...record, children: outcomes }));
} finally {
	await backend.close();
}
