// Root of the elastic-workers benchmark (#4768): fans out ELASTIC_CHILDREN pooled children with shared placement and
// writes one JSON result: wall time, every child's per-checkpoint latencies and host, and how many children failed.
//   ELASTIC_DB_URL, [ELASTIC_TOKEN_FILE], ELASTIC_PREFIX, ATOMIC_CODING_AGENT_DIR, ELASTIC_CHILDREN, ELASTIC_STEPS,
//   ELASTIC_LOCAL=1 runs the same fan-out on this machine's own default journal, without shared placement.
//   ELASTIC_PAYLOAD_BYTES, ELASTIC_WORK_MS, ELASTIC_ROOT_WORKERS, ELASTIC_RESULT_FILE, ELASTIC_SESSIONS,
//   ELASTIC_CHECKPOINT_SHIPPING (JSON), ELASTIC_LEASE_MS
//   ELASTIC_IDLE_PROBE=N (#5230): once the fan-out settled, the root leaves every worker idle for ELASTIC_IDLE_SETTLE_MS,
//   then runs N one-step children one after another, each after a random gap, and records how long after its enqueue
//   each started. ELASTIC_PHASE_FILE gets one line per phase (`main-done`, `probe-start`, `probe-done`) as it begins.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadWorkerWorkflow, run, workflow } from "@bastani/atomic/workflows";

const env = (name, fallback) => process.env[name] ?? fallback;
const adapter = env("ELASTIC_ADAPTER", fileURLToPath(new URL("../../../packages/storage-libsql/libsql.js", import.meta.url)));
const childPath = fileURLToPath(new URL("./bench-child.mjs", import.meta.url));
const children = Number(env("ELASTIC_CHILDREN", "16"));
const steps = Number(env("ELASTIC_STEPS", "20"));
const payloadBytes = Number(env("ELASTIC_PAYLOAD_BYTES", "256"));
const workMs = Number(env("ELASTIC_WORK_MS", "0"));
const stageMs = Number(env("ELASTIC_STAGE_MS", "0"));
const model = process.env.ELASTIC_MODEL;
const progressFile = process.env.ELASTIC_PROGRESS_FILE;
mkdirSync(env("ATOMIC_CODING_AGENT_DIR"), { recursive: true });
const child = await loadWorkerWorkflow(childPath, "benchChild");
const outcomes = [];
const idleProbe = Number(env("ELASTIC_IDLE_PROBE", "0"));
const idleSettleMs = Number(env("ELASTIC_IDLE_SETTLE_MS", "10000"));
const phaseFile = process.env.ELASTIC_PHASE_FILE;
const phase = (name) => {
	if (phaseFile) appendFileSync(phaseFile, `${name} ${Date.now()}\n`);
};
/** The idle probe's children: when each was enqueued and started, by the clock of the root and of its host. */
const probes = [];
const root = workflow({
	name: "elastic-bench-root",
	description: "Fans out pooled children that commit checkpoints",
	inputs: {},
	outputs: {},
	async run(ctx) {
		const settled = await Promise.allSettled(
			Array.from({ length: children }, (_, index) =>
				ctx.workflow(child, { inputs: { index, steps, payloadBytes, workMs, stageMs, ...(model ? { model } : {}) } }).then((value) => {
					if (progressFile) appendFileSync(progressFile, `${JSON.stringify({ index, at: Date.now(), status: value.status })}\n`);
					return value;
				}),
			),
		);
		for (const result of settled)
			outcomes.push(
				result.status === "fulfilled"
					? {
							status: result.value.status,
							...(result.value.outputs ?? {}),
							error: result.value.error?.message ?? null,
							detail: result.value.error ? JSON.stringify(result.value.error, Object.getOwnPropertyNames(result.value.error)).slice(0, 6000) : undefined,
						}
					: {
							status: "rejected",
							error: result.reason?.message ?? String(result.reason),
							name: result.reason?.name,
							detail: (() => {
								const chain = [];
								for (let e = result.reason, d = 0; e && d < 6; e = e.cause, d++) chain.push(`${e.name}: ${e.message}\n${e.stack ?? ""}`);
								return chain.join("\n--cause--\n").slice(0, 8000);
							})(),
						},
			);
		if (idleProbe > 0) {
			phase("main-done");
			await new Promise((resolve) => setTimeout(resolve, idleSettleMs));
			phase("probe-start");
			for (let index = 0; index < idleProbe; index++) {
				// A random point of any poll cycle, as work arriving from elsewhere lands.
				await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 700));
				const enqueuedAt = Date.now();
				const value = await ctx.workflow(child, {
					inputs: { index: 1_000_000 + index, steps: 1, payloadBytes, workMs: 0, stageMs: 0 },
				});
				probes.push({
					enqueuedAt,
					startedAt: value.outputs?.startedAt ?? null,
					host: value.outputs?.host ?? null,
					status: value.status,
				});
			}
			phase("probe-done");
		}
		return {};
	},
});
const began = Date.now();
const result = await run(
	root,
	{},
	{
		cwd: process.cwd(),
		...(process.env.ELASTIC_LOCAL === "1"
			? {}
			: {
					journal: {
						adapter,
						options: { url: env("ELASTIC_DB_URL") },
						prefix: env("ELASTIC_PREFIX", ""),
						...(process.env.ELASTIC_TOKEN_FILE ? { secrets: { authToken: { file: process.env.ELASTIC_TOKEN_FILE } } } : {}),
					},
					workers: {
						placement: "shared",
						// ELASTIC_CHECKPOINT_SHIPPING: the root's `checkpointShipping`, as JSON (#4768).
						...(process.env.ELASTIC_CHECKPOINT_SHIPPING
							? { checkpointShipping: JSON.parse(process.env.ELASTIC_CHECKPOINT_SHIPPING) }
							: {}),
					},
				}),
		localWorkers: {
			count: Number(env("ELASTIC_ROOT_WORKERS", "1")),
			definitions: [{ path: childPath, exportName: "benchChild" }],
			...(process.env.ELASTIC_LEASE_MS ? { leaseMs: Number(process.env.ELASTIC_LEASE_MS) } : {}),
		},
		admission: { limits: { session: Number(env("ELASTIC_SESSIONS", "64")) } },
	},
);
const ended = Date.now();
const output = { status: result.status, runId: result.runId ?? null, began, ended, wallMs: ended - began, children, steps, payloadBytes, workMs, stageMs, model: model ?? null, outcomes, probes, error: result.error === undefined ? null : String(result.error?.stack ?? result.error?.message ?? result.error) };
writeFileSync(env("ELASTIC_RESULT_FILE", "result.json"), JSON.stringify(output));
process.stderr.write(`root ${result.status} in ${output.wallMs} ms\n`);
process.exit(0);
