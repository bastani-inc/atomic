import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const WORKER_DEATH_TIMEOUT_MS = 30_000;
const [mode, directory] = process.argv.slice(2);
const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { workflow } = await load("../../packages/workflows/src/authoring/workflow.ts");
const { JournalDurableBackend } = await load("../../packages/workflows/src/durable/journal/journal-backend.ts");
const { resolveRunJournal } = await load("../../packages/workflows/src/durable/journal/resolution.ts");
const { run } = await load("../../packages/workflows/src/engine/run.ts");
const { createStore } = await load("../../packages/workflows/src/shared/store.ts");
const { definitionDigest, loadWorkerDefinition } = await load("../../packages/workflows/src/workers/definitions.ts");
const { LocalWorkerPool } = await load("../../packages/workflows/src/workers/local-pool.ts");

const marker = (name) => join(directory, name);
const processState = (pid) => {
	try {
		return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
const holdUntilDead = (pid) => {
	const deadline = Date.now() + WORKER_DEATH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const state = processState(pid);
		if (state === "" || state.startsWith("Z")) return;
	}
	throw new Error(`Worker ${pid} did not die`);
};

const unanswered = mode === "unanswered";
const exportName = unanswered ? "unansweredChild" : "releasedChild";
const childPath = fileURLToPath(new URL("./pool-worker-failure-child.ts", import.meta.url));
const path = join(directory, "journal.sqlite");
const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
const pool = new LocalWorkerPool(backend, {
	journalPath: path,
	workers: unanswered ? 1 : 2,
	definitions: [{ definition: child, path: childPath, exportName }],
});

let failedWorker;
const watcher = setInterval(() => {
	if (unanswered) {
		if (!existsSync(marker("dying"))) return;
		clearInterval(watcher);
		failedWorker = Number(readFileSync(marker("dying"), "utf8"));
		writeFileSync(marker("go"), "");
		holdUntilDead(failedWorker);
		return;
	}
	if (!existsSync(marker("started-0")) || !existsSync(marker("started-1"))) return;
	clearInterval(watcher);
	failedWorker = Number(readFileSync(marker("started-0"), "utf8"));
	process.kill(failedWorker, "SIGKILL");
	writeFileSync(marker("release"), "");
}, 20);

const children = [];
const parent = workflow({
	name: "pool-worker-failure-root",
	description: "Root whose local worker fails while serving a child",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const results = await Promise.all(
			(unanswered ? [0] : [0, 1]).map((index) => ctx.workflow(child, { inputs: { directory, index } })),
		);
		for (const result of results) children.push({ status: result.status, ...result.outputs });
		return {};
	},
});

try {
	const result = await run(
		parent,
		{},
		{ runId: "pool-worker-failure-root", cwd: directory, store: createStore(), durableBackend: backend },
	);
	writeFileSync(
		marker("outcome.json"),
		JSON.stringify({
			status: result.status,
			error: result.error ?? null,
			children,
			workerPids: pool.workerPids,
			failedWorker,
		}),
	);
} finally {
	clearInterval(watcher);
	await pool.close();
	await backend.close();
}
