import { pathToFileURL } from "node:url";

const [sdkBundle, journalPath, directory, childPath, runId, token, launcher] = process.argv.slice(2);

if (launcher) {
	process.env.ATOMIC_CODING_AGENT = "true";
	Object.defineProperty(process, "execPath", { value: launcher, configurable: true });
}

const { loadWorkerWorkflow, run, workflow } = await import(pathToFileURL(sdkBundle).href);
const { Type } = await import("typebox");

const child = await loadWorkerWorkflow(childPath, "child");
const parent = workflow({
	name: "packaged-worker-root",
	description: "Runs one child on a packaged local worker",
	inputs: {},
	outputs: { pid: Type.Number(), token: Type.String() },
	async run(ctx) {
		const result = await ctx.workflow(child, { inputs: { token } });
		return { pid: result.outputs.pid, token: result.outputs.token };
	},
});

try {
	const result = await run(
		parent,
		{},
		{
			runId,
			cwd: directory,
			journal: { path: journalPath },
			localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
			admission: { limits: { session: 2, process: 2 } },
		},
	);
	console.log(
		JSON.stringify({
			status: result.status,
			outputs: result.result ?? null,
			error: result.error ?? null,
			coordinatorPid: process.pid,
		}),
	);
	process.exit(result.status === "completed" ? 0 : 1);
} catch (error) {
	console.error(String(error?.stack ?? error));
	process.exit(1);
}
