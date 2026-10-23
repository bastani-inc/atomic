import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const [journalPath, directory, runId, childPath, releasePath, mode] = process.argv.slice(2);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { loadWorkerWorkflow, run, workflow } = await load("../../packages/workflows/src/index.ts");
const { createToolControlRegistry } = await load("../../packages/workflows/src/engine/run-tool-control-registry.ts");
const { Type } = await import("typebox");

const child = await loadWorkerWorkflow(childPath, "child");
const parent = workflow({
	name: "public-lifecycle-root",
	description: "Public local-worker lifecycle fixture",
	inputs: {},
	outputs: { firstPid: Type.Number(), finalPid: Type.Number() },
	async run(ctx) {
		const result = await ctx.workflow(child, { inputs: { releasePath } });
		return { firstPid: result.outputs.firstPid, finalPid: result.outputs.finalPid };
	},
});

const controls = createToolControlRegistry();
const control = async (command) => {
	const registered = controls.runControl(runId);
	if (!registered) throw new Error("Root run control is not registered");
	await registered[command]();
	send({ event: "controlled", command });
};
createInterface({ input: process.stdin }).on("line", (line) => {
	const { command } = JSON.parse(line);
	control(command).catch((error) => send({ event: "error", message: String(error?.message ?? error) }));
});

send({ event: "ready", pid: process.pid });
try {
	const result = await run(
		parent,
		{},
		{
			runId,
			cwd: directory,
			journal: { path: journalPath },
			toolControlRegistry: controls,
			...(mode === "fresh"
				? {
						localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
						admission: { limits: { session: 2, process: 1 } },
					}
				: {}),
		},
	);
	send({ event: "result", status: result.status, outputs: result.result ?? null, error: result.error ?? null });
	process.exit(0);
} catch (error) {
	send({ event: "error", message: String(error?.message ?? error) });
	process.exit(1);
}
