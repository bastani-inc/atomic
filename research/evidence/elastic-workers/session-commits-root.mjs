// Root of the session-commit measurement (#4768): fans out SC_CHILDREN children of session-commits-child.mjs with shared
// placement on the journal the counting adapter wraps, and writes its result to SC_RESULT_FILE.
//   SC_ADAPTER (counting-adapter.mjs), SC_DB_URL, SC_PREFIX, SC_CHILDREN, SC_STAGES, SC_WORKERS, SC_SHIPPING (JSON or
//   "sync"), ATOMIC_CODING_AGENT_DIR.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadWorkerWorkflow, run, workflow } from "@bastani/atomic/workflows";

const env = (name, fallback) => process.env[name] ?? fallback;
const childPath = fileURLToPath(new URL("./session-commits-child.mjs", import.meta.url));
const children = Number(env("SC_CHILDREN", "8"));
const stages = Number(env("SC_STAGES", "4"));
mkdirSync(env("ATOMIC_CODING_AGENT_DIR"), { recursive: true });
const child = await loadWorkerWorkflow(childPath, "sessionCommitsChild");
const outcomes = [];
const root = workflow({
	name: "session-commits-root",
	description: "Fans out agent-stage children",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const settled = await Promise.allSettled(
			Array.from({ length: children }, (_, index) => ctx.workflow(child, { inputs: { index, stages } })),
		);
		for (const result of settled)
			outcomes.push(
				result.status === "fulfilled"
					? { status: result.value.status, replies: result.value.outputs?.replies ?? 0 }
					: { status: "rejected", error: String(result.reason?.message ?? result.reason) },
			);
		return {};
	},
});
const shipping = env("SC_SHIPPING", "sync");
const began = Date.now();
const result = await run(root, {}, {
	cwd: process.cwd(),
	journal: { adapter: env("SC_ADAPTER"), options: { url: env("SC_DB_URL") }, prefix: env("SC_PREFIX", "") },
	workers: { placement: "shared", ...(shipping === "sync" ? {} : { checkpointShipping: JSON.parse(shipping) }) },
	localWorkers: { count: Number(env("SC_WORKERS", "4")), definitions: [{ path: childPath, exportName: "sessionCommitsChild" }] },
	admission: { limits: { session: 64 } },
});
writeFileSync(env("SC_RESULT_FILE", "result.json"), JSON.stringify({ status: result.status, wallMs: Date.now() - began, children, stages, outcomes, error: result.error === undefined ? null : String(result.error?.message ?? result.error) }));
process.exit(0);
