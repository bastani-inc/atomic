import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// `settings`, when given, is the JSON of run options this launch or restart passes, such as the `localWorkers` and
// `admission` options the CLI passes from the current settings, or the execution mode of the launch or the resume. A
// fresh launch passes them over its defaults; a restart without them runs with the settings its root saved.
const [journalPath, directory, runId, childPath, releasePath, mode, settings] = process.argv.slice(2);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Transforms cached on disk, keyed by source hash, as packages/workflows/src/workers/local-worker-entry.mjs caches
// them: loading the workflow sources uncached costs this process about twice the CPU at every start.
const jiti = createJiti(import.meta.url, { fsCache: true });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { loadWorkerWorkflow, run, workflow } = await load("../../packages/workflows/src/index.ts");
const { createToolControlRegistry } = await load("../../packages/workflows/src/engine/run-tool-control-registry.ts");
const { Type } = await import("typebox");

const child = await loadWorkerWorkflow(childPath, "child");
const parent = workflow({
	name: "public-lifecycle-root",
	description: "Public local-worker lifecycle fixture",
	inputs: {},
	outputs: {
		firstPid: Type.Number(),
		finalPid: Type.Number(),
		firstInstance: Type.String(),
		finalInstance: Type.String(),
	},
	async run(ctx) {
		const result = await ctx.workflow(child, { inputs: { releasePath } });
		const { firstPid, finalPid, firstInstance, finalInstance } = result.outputs;
		return { firstPid, finalPid, firstInstance, finalInstance };
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

// The same instance id the fixture children report (test/fixtures/process-instance.ts), so a child that wrongly ran in
// this process would report this one.
const instanceKey = Symbol.for("atomic.test.processInstance");
globalThis[instanceKey] ??= randomUUID();
send({ event: "ready", pid: process.pid, instance: globalThis[instanceKey] });
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
			...(settings ? JSON.parse(settings) : {}),
		},
	);
	send({ event: "result", status: result.status, outputs: result.result ?? null, error: result.error ?? null });
	process.exit(0);
} catch (error) {
	send({ event: "error", message: String(error?.message ?? error) });
	process.exit(1);
}
