// A pooled root that runs one child on a local worker with no journal setting, so its pool uses the root's shard of
// the default journal store under ATOMIC_CODING_AGENT_DIR. It reports its pid when ready, waits for the child to
// finish (the child waits for `releasePath`), and reports the result.
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [directory, runId, childPath, releasePath] = process.argv.slice(2);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const jiti = createJiti(import.meta.url, { fsCache: true });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { loadWorkerWorkflow, run, workflow } = await load("../../packages/workflows/src/index.ts");
const { Type } = await import("typebox");

const child = await loadWorkerWorkflow(childPath, "child");
const parent = workflow({
	name: "journal-store-pooled-root",
	description: "One pooled child on the root's shard",
	inputs: {},
	outputs: { finalPid: Type.Number() },
	async run(ctx) {
		const result = await ctx.workflow(child, { inputs: { releasePath } });
		return { finalPid: result.outputs.finalPid };
	},
});

send({ event: "ready", pid: process.pid });
try {
	const result = await run(
		parent,
		{},
		{
			runId,
			cwd: directory,
			localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
		},
	);
	send({ event: "result", status: result.status, outputs: result.result ?? null, error: result.error ?? null });
	process.exit(0);
} catch (error) {
	send({ event: "error", message: String(error?.message ?? error) });
	process.exit(1);
}
