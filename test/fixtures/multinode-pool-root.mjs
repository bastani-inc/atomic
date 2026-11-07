import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The root of a pooled campaign on node A (#4329, scenario 3): a root bound to a real worktree on this node, whose
// children run on worker hosts of other nodes. It captures the worktree as it starts (#4492), and every child carries
// that snapshot, so a host that never had the tree restores it. The shared journal is the libSQL database every node
// opens (SHARED_POOL_ADAPTER, SHARED_POOL_URL, SHARED_POOL_PREFIX); the worktree is MULTINODE_WORKTREE; the node's
// agent directory is SHARED_POOL_AGENT_DIR. It writes `outcome-start.json` into `directory` when the root ends.
const [directory, children, workers] = process.argv.slice(2);
const ROOT = process.env.SHARED_POOL_ROOT;
const worktree = process.env.MULTINODE_WORKTREE;
const jiti = createJiti(import.meta.url, { fsCache: true });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { workflow } = await load("../../packages/workflows/src/authoring/workflow.ts");
const { JournalDurableBackend } = await load("../../packages/workflows/src/durable/journal/journal-backend.ts");
const { resolveRunJournal } = await load("../../packages/workflows/src/durable/journal/resolution.ts");
const { run } = await load("../../packages/workflows/src/engine/run.ts");
const { createStore } = await load("../../packages/workflows/src/shared/store.ts");
const { loadWorkerWorkflow } = await load("../../packages/workflows/src/workers/definitions.ts");
const { isWorkspaceRestoreUnavailableError } = await load("../../packages/workflows/src/workers/placement-errors.ts");
const { workspace } = await jiti.import("@bastani/atomic");

const childPath = fileURLToPath(new URL("./multinode-pool-child.ts", import.meta.url));
const exportName = "campaignChild";
const journal = await resolveRunJournal({
	agentDir: process.env.SHARED_POOL_AGENT_DIR,
	journal: {
		adapter: process.env.SHARED_POOL_ADAPTER,
		options: { url: process.env.SHARED_POOL_URL },
		prefix: process.env.SHARED_POOL_PREFIX,
	},
});
const backend = await JournalDurableBackend.open(journal);
const child = await loadWorkerWorkflow(childPath, exportName);
const outcomes = [];
const parent = workflow({
	name: "multinode-pool-root",
	description: "A root whose children run on the worker hosts of other nodes",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const results = await Promise.allSettled(
			Array.from({ length: Number(children) }, (_, index) => ctx.workflow(child, { inputs: { directory, index } })),
		);
		for (const result of results)
			outcomes.push(
				result.status === "fulfilled"
					? { status: result.value.status, error: result.value.error ?? null, ...result.value.outputs }
					: {
							status: "rejected",
							name: result.reason?.name ?? null,
							error: result.reason?.message ?? String(result.reason),
							// The placement error the child failed on, as the guard finds it in the cause chain.
							placement: isWorkspaceRestoreUnavailableError(result.reason) ? "workspace-restore-unavailable" : null,
						},
			);
		return {};
	},
});
let record;
try {
	const result = await run(parent, {}, {
		runId: ROOT,
		cwd: directory,
		store: createStore(),
		durableBackend: backend,
		localWorkers: {
			count: Number(workers),
			definitions: [{ path: childPath, exportName }],
			...(process.env.SHARED_POOL_LEASE_MS === undefined ? {} : { leaseMs: Number(process.env.SHARED_POOL_LEASE_MS) }),
		},
		workers: {
			placement: "shared",
			workspace: workspace({ repo: worktree, branch: "main", base: "main", worktree }),
			...(process.env.SHARED_POOL_CLAIM_WINDOW_MS === undefined
				? {}
				: { claimWindowMs: Number(process.env.SHARED_POOL_CLAIM_WINDOW_MS) }),
		},
		admission: { limits: { session: 8 } },
	});
	record = { status: result.status, error: result.error ?? null };
	writeFileSync(join(directory, "outcome-start.json"), JSON.stringify({ ...record, children: outcomes }));
} finally {
	await backend.close();
}
