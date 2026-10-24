import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [directory, leaseMs, stallMs, mode = "live"] = process.argv.slice(2);
const stopped = mode === "stopped";
const REPEATED_STALL_PERIOD_MS = 1_000;
const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { workflow } = await load("../../packages/workflows/src/authoring/workflow.ts");
const { JournalDurableBackend } = await load("../../packages/workflows/src/durable/journal/journal-backend.ts");
const { resolveRunJournal } = await load("../../packages/workflows/src/durable/journal/resolution.ts");
const { run } = await load("../../packages/workflows/src/engine/run.ts");
const { createStore } = await load("../../packages/workflows/src/shared/store.ts");
const { definitionDigest, loadWorkerDefinition } = await load("../../packages/workflows/src/workers/definitions.ts");
const { LocalWorkerPool } = await load("../../packages/workflows/src/workers/local-pool.ts");

const path = join(directory, "journal.sqlite");
const childPath = fileURLToPath(new URL(stopped ? "./pool-child.ts" : "./pool-resume-child.ts", import.meta.url));
const exportName = stopped ? "stalledChild" : "resumedChild";
const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
const pool = new LocalWorkerPool(backend, {
	journalPath: path,
	workers: 1,
	leaseMs: Number(leaseMs),
	definitions: [{ definition: child, path: childPath, exportName }],
});

const busy = (ms) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {}
};
const stall = stopped
	? setInterval(() => busy(Number(stallMs)), REPEATED_STALL_PERIOD_MS)
	: setInterval(() => {
			if (!readdirSync(directory).some((name) => name.startsWith("started-"))) return;
			clearInterval(stall);
			busy(Number(stallMs));
			writeFileSync(join(directory, "release"), "");
		}, 20);

const children = [];
const parent = workflow({
	name: "pool-lease-stall-root",
	description: "Root whose event loop stalls past the work lease while its worker is alive",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const result = await ctx.workflow(child, stopped ? {} : { inputs: { directory, index: 0 } });
		children.push({ status: result.status, ...result.outputs });
		return {};
	},
});

try {
	const result = await run(
		parent,
		{},
		{ runId: "pool-lease-stall-root", cwd: directory, store: createStore(), durableBackend: backend },
	);
	writeFileSync(
		join(directory, "outcome.json"),
		JSON.stringify({ status: result.status, error: result.error ?? null, children, workerPids: pool.workerPids }),
	);
} finally {
	clearInterval(stall);
	await pool.close();
	await backend.close();
}
