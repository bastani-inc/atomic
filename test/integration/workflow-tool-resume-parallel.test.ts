import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { WorkflowRunContext } from "../../packages/workflows/src/authoring.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { INTERACTIVE_WORKFLOW_POLICY } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { sleep } from "../helpers/runtime.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { createMockSdk } from "../unit/durable-dbos-backend-helpers.js";

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + TEST_TIMEOUT_MS / 2;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "workflow did not reach expected state");
		await sleep(10);
	}
}

afterEach(() => {
	store.clear();
	setDurableBackend(undefined);
});

type ToolContext = Pick<WorkflowRunContext, "tool">;
type Gates = (ctx: ToolContext) => Promise<unknown>;

/** Runs `gates` until the run fails on a thrown tool, then restarts the host and returns a resumer. */
async function failThenRestart(initialGates: Gates) {
	const sdk = createMockSdk();
	let backend = new DbosDurableBackend(sdk);
	setDurableBackend(backend);
	let gates = initialGates;
	const definition = workflow({
		name: "parallel-gates",
		description: "parallel ctx.tool gates",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await gates(ctx);
			return {};
		},
	});
	const entries: SessionEntry[] = [];
	const runtime = createExtensionRuntime({
		store,
		registry: createRegistry([definition]),
		adapters: { prompt: { prompt: async (text) => text } },
		persistence: {
			appendEntry: (type, payload) => {
				entries.push({
					id: String(entries.length),
					type,
					payload: structuredClone(payload) as NonNullable<SessionEntry["payload"]>,
				});
			},
		},
	});
	const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
	assert.ok(started.action === "run");
	const runId = started.runId;
	await waitFor(() => store.runs().some((run) => run.id === runId && run.endedAt !== undefined));
	await jobTracker.get(runId)?.promise;
	const source = store.runs().find((run) => run.id === runId)!;
	assert.equal(source.status, "failed");
	assert.ok(source.failedToolNodeId !== undefined, "run failed on a tool");
	await backend.flush(runId);

	const restart = async (): Promise<void> => {
		backend = new DbosDurableBackend(sdk);
		await backend.hydrateWorkflow(runId);
		setDurableBackend(backend);
		store.clear();
		restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "never", persistRuns: true }, store);
	};
	const resume = async (nextGates: Gates) => {
		await restart();
		gates = nextGates;
		const resumed = await workflowResumeAction(
			{ action: "resume", runId },
			{
				getRuntime: () => runtime,
				policy: INTERACTIVE_WORKFLOW_POLICY,
				ensureWorkflowResourcesLoaded: async () => {},
			},
		);
		assert.ok(resumed.action === "resume");
		if (resumed.status !== "running") return { status: resumed.status, error: resumed.message };
		await waitFor(() => store.runs().some((run) => run.id === runId && run.endedAt !== undefined));
		await jobTracker.get(runId)?.promise;
		const run = store.runs().find((candidate) => candidate.id === runId)!;
		return { status: run.status, error: run.error };
	};
	return { source, resume, backend: () => backend };
}

function abortable(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) =>
		signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
	);
}

test("a tool-failed run resumes when an uncheckpointed parallel sibling is called before the failed tool (#3314)", async () => {
	const calls = { slow: 0, gate: 0 };
	let failGate = true;
	const gates: Gates = (ctx) =>
		Promise.all([
			ctx.tool("slow-sibling", {}, async ({ signal }) => {
				calls.slow++;
				if (failGate) await abortable(signal);
				return "slow";
			}),
			ctx.tool("git-gate", {}, async () => {
				calls.gate++;
				await sleep(20);
				if (failGate) throw new Error("spawn EBADF");
				return "gate";
			}),
		]);
	const { source, resume } = await failThenRestart(gates);
	assert.equal(source.toolNodes?.find((node) => node.id === source.failedToolNodeId)?.name, "git-gate");
	assert.equal(source.toolNodes?.find((node) => node.name === "slow-sibling")?.status, "cancelled");
	failGate = false;
	const resumed = await resume(gates);
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(calls, { slow: 2, gate: 2 });
});

test("a resume that fails the frontier check leaves the failed tool unrun and the run resumable (#3314)", async () => {
	const calls = { gate: 0, inserted: 0 };
	let failGate = true;
	const gate = (ctx: ToolContext) =>
		ctx.tool("git-gate", {}, async () => {
			calls.gate++;
			if (failGate) throw new Error("spawn EBADF");
			return "gate";
		});
	const { source, resume, backend } = await failThenRestart((ctx) => gate(ctx));
	const target = source.toolNodes!.find((node) => node.id === source.failedToolNodeId)!;
	failGate = false;
	const changed = await resume((ctx) =>
		Promise.all([
			ctx.tool("inserted-gate", {}, async () => {
				calls.inserted++;
				return "inserted";
			}),
			gate(ctx),
		]),
	);
	assert.equal(changed.status, "failed");
	assert.match(changed.error ?? "", /replay topology mismatch for unfinished tool/);
	assert.deepEqual(calls, { gate: 1, inserted: 0 }, "no live callback ran past the rejected frontier");
	assert.equal(backend().getToolCheckpoint(source.id, target.argsHash), undefined);

	const restored = await resume((ctx) => gate(ctx));
	assert.equal(restored.status, "completed", restored.error);
	assert.deepEqual(calls, { gate: 2, inserted: 0 });
});

test("a run whose parallel tools both threw resumes and retries both (#3314)", async () => {
	const calls = { first: 0, second: 0 };
	let fail = true;
	const gates: Gates = (ctx) =>
		Promise.all(
			(["first", "second"] as const).map((name) =>
				ctx.tool(`${name}-gate`, {}, async () => {
					calls[name]++;
					if (fail) throw new Error(`spawn EBADF (${name})`);
					return name;
				}),
			),
		);
	const { source, resume } = await failThenRestart(gates);
	const failed = source.toolNodes?.filter((node) => node.status === "failed") ?? [];
	assert.equal(failed.length, 2, "both concurrent gates failed");
	fail = false;
	const resumed = await resume(gates);
	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(calls, { first: 2, second: 2 });
});
