import { existsSync, writeFileSync } from "node:fs";
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
const { createStageControlRegistry } = await load("../../packages/workflows/src/runs/foreground/stage-control-registry.ts");
const { StageUiBroker } = await load("../../packages/workflows/src/shared/stage-ui-broker.ts");
const { pendingStageMessageRouter } = await load("../../packages/workflows/src/shared/external-run-routes.ts");
const { isWorkspaceRestoreUnavailableError } = await load("../../packages/workflows/src/workers/placement-errors.ts");
const { WorkflowGitRequiredError } = await load("../../packages/workflows/src/shared/workflow-git-required-error.ts");
const { GitUnavailableError, isGitUnavailableError } = await jiti.import("@bastani/atomic");
/** The WorkflowGitRequiredError in the failure's cause chain, as the root rebuilt it, described for the test (#4378). */
const typedFailure = (error) => {
	let current = error;
	for (let depth = 0; current && depth < 8 && !(current instanceof WorkflowGitRequiredError); depth++) current = current.cause;
	if (!(current instanceof WorkflowGitRequiredError)) return null;
	return {
		name: current.name,
		code: current.code,
		fields: current.fields,
		hint: current.hint,
		retryable: current.retryable,
		cause: {
			name: current.cause?.name ?? null,
			code: current.cause?.code ?? null,
			instance: current.cause instanceof GitUnavailableError,
			guard: isGitUnavailableError(current.cause),
		},
	};
};
const placementCode = (error) => {
	for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth++)
		if (current.name === "WorkspaceRestoreUnavailableError") return current.code;
	return null;
};

const childPath = fileURLToPath(new URL("./shared-pool-child.ts", import.meta.url));
const exportName =
	{ bound: "boundChild", distributed: "distributedChild", typed: "typedFailureChild", remote: "remoteStageChild" }[scenario] ??
	"sharedChild";
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
						scenario === "bound" || scenario === "typed"
							? {}
							: scenario === "remote"
								? { directory }
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
							typed: typedFailure(result.reason),
						},
			);
		return {};
	},
});
const options = {
	localWorkers: {
		count: Number(workers),
		definitions: [{ path: childPath, exportName }],
		...(process.env.SHARED_POOL_LEASE_MS === undefined ? {} : { leaseMs: Number(process.env.SHARED_POOL_LEASE_MS) }),
	},
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
// The remote scenario (#4391): an operator on the root's host steers the stage that runs on another host, sends it an
// Intercom message through the root's bridge, as the broker hands one over, and answers its ask_user_question form.
const broker = new StageUiBroker(store);
const registry = createStageControlRegistry();
const remoteOptions = scenario === "remote" ? { stageUiBroker: broker, stageControlRegistry: registry } : {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function operate() {
	// With SHARED_POOL_REMOTE_FAILOVER=1, the host running the stage is killed once the steer and the Intercom message
	// reached it: the operator writes that host's id to `failover-request` and waits for `failover-done`, then goes on
	// with the host that took the stage over, which asks its question again. That host's replay waits for the answer
	// before it takes text, so the operator holds the stage's reply (`hold-replies`) until the steer reached it.
	const failover = process.env.SHARED_POOL_REMOTE_FAILOVER === "1";
	const hostOf = (stage) => String(stage.workerExecution?.worker ?? "").split("/")[0];
	const found = (skipHost) => {
		for (const candidate of store.runs())
			for (const stage of candidate.stages)
				if (
					stage.name === "agent" &&
					hostOf(stage) !== skipHost &&
					broker.peekStageQuestionnaire(candidate.id, stage.id) !== undefined
				)
					return { runId: candidate.id, stage };
		return undefined;
	};
	// What the operator did and waits for, on stderr: a test that times out shows it.
	const step = (text) => process.stderr.write(`operator: ${text}\n`);
	let target;
	while ((target = found(undefined)) === undefined) await sleep(50);
	const { runId, stage } = target;
	let handle;
	while ((handle = registry.get(runId, stage.id)) === undefined) await sleep(50);
	const questionParams = broker.peekStageQuestionnaire(runId, stage.id).params;
	const steer = await handle.sendUserMessage("steer-from-root", { deliverAs: "steer" });
	const route = async (id, text, expectsReply) => {
		const event = {
			handled: false,
			runId: ROOT,
			target: `workflow:${ROOT}/${runId}/${stage.id}`,
			from: { id: "operator", name: "operator", group: `workflow:${ROOT}` },
			message: { id, timestamp: Date.now(), content: { text }, ...(expectsReply ? { expectsReply: true } : {}) },
		};
		pendingStageMessageRouter(store).route(event);
		return event.handled ? await event.completion : { outcome: "unhandled" };
	};
	const routed = await route("intercom-remote-1", "intercom-body-from-root", false);
	const ask = await route("intercom-remote-ask", "can you answer?", true);
	while (store.pendingStageMessagesFor(runId, stage.id).length > 0) await sleep(50);
	let killed;
	if (failover) {
		// The stage's first host took the Intercom message into its session: it dies with the message there.
		killed = hostOf(store.run(runId).stages.find((candidate) => candidate.id === stage.id));
		writeFileSync(join(directory, "failover-request"), killed);
		step(`steered ${steer} and delivered the Intercom message on ${killed}; asked for its failover`);
		while (!existsSync(join(directory, "failover-done"))) await sleep(50);
		while (found(killed) === undefined) await sleep(50);
		step("the stage asks again on the host that took it over");
		writeFileSync(join(directory, "hold-replies"), "");
	}
	const worker = () =>
		store.run(runId).stages.find((candidate) => candidate.id === stage.id).workerExecution?.worker ?? null;
	const answeredOn = worker();
	broker.answerStagePrompt(runId, stage.id, { optionLabels: ["yes"] });
	if (failover) {
		// The replacement takes the steer again under its own attempt once it has the answer.
		const generation = store.run(runId).stages.find((candidate) => candidate.id === stage.id).workerExecution.generation;
		const { openLibsqlDatabase } = await import("../../packages/storage-libsql/libsql.js");
		const database = await openLibsqlDatabase({ url: process.env.SHARED_POOL_URL });
		try {
			for (let polls = 1; ; polls++) {
				const inputs = await database.all(
					`SELECT seq, kind, op, state FROM ${prefix}wf_runs_stage_inputs WHERE root = ? ORDER BY seq`,
					ROOT,
				);
				const steered = inputs.some(
					(input) => input.kind === "user-message" && input.op.endsWith(`:${generation}`) && input.state === "done",
				);
				if (steered) break;
				if (polls % 100 === 0) step(`waiting for the steer on attempt ${generation}: ${JSON.stringify(inputs)}`);
				await sleep(50);
			}
		} finally {
			await database.close();
		}
		step("the steer reached the host that took the stage over");
		writeFileSync(join(directory, "release-replies"), "");
	}
	return { steer, routed, ask, questionParams, worker: answeredOn, ...(killed === undefined ? {} : { killed }) };
}
let record;
try {
	if (mode === "start") {
		const execution = run(parent, {}, {
			runId: ROOT,
			cwd: directory,
			store,
			ui,
			durableBackend: backend,
			...options,
			...remoteOptions,
		});
		const operating =
			scenario === "remote"
				? operate().then(
						(value) => ({ value }),
						(error) => ({ error: error?.stack ?? String(error) }),
					)
				: undefined;
		const result = await execution;
		const operator = await operating;
		record = { status: result.status, error: result.error ?? null, ...(operator === undefined ? {} : { operator }) };
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
