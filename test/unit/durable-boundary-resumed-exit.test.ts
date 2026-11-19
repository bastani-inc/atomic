import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { resolveBoundaryLifecycle } from "../../packages/workflows/src/durable/boundary-lifecycle.js";
import {
	DurableNestedTopologyError,
	prepareDurableChildInvocation,
} from "../../packages/workflows/src/durable/boundary-topology.js";
import {
	durableNestedRunSnapshots,
	durableWorkflowRunSnapshots,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowUIAdapter } from "../../packages/workflows/src/shared/types.js";
import { resolveBoundaryLifecycle as previousResolveBoundaryLifecycle } from "../helpers/reference-nested-run-snapshots/boundary-lifecycle.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

const ROOT = "root";

function boundaryDescriptor(backend: JournalDurableBackend<MemoryRunJournal>) {
	return {
		workflowId: ROOT,
		rootWorkflowId: ROOT,
		backend,
		replayKey: "workflow:child:fingerprint:1",
		boundaryName: "workflow:child",
		alias: "child",
		workflow: "child",
		childRunName: "child",
		invocationFingerprint: "fingerprint",
		runTopology: { runId: ROOT, runName: "root" },
	};
}

test("a boundary that failed, was resumed and then skipped by ctx.exit stays readable in a journal read back (#4863)", async () => {
	const journal = new MemoryRunJournal();
	const writer = await JournalDurableBackend.open(journal, { ownsJournal: false });
	try {
		await writer.commitWorkflowRegistration({
			workflowId: ROOT,
			name: "root",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		const failed = prepareDurableChildInvocation(boundaryDescriptor(writer));
		await failed.recordStart([], 0);
		// An attempt the process left before any terminal is prepared again.
		assert.equal(
			prepareDurableChildInvocation(boundaryDescriptor(writer)).identity.childRunId,
			failed.identity.childRunId,
		);
		await failed.recordTerminal("failed");
		const exited = prepareDurableChildInvocation(boundaryDescriptor(writer));
		assert.equal(exited.identity.childRunId, failed.identity.childRunId);
		await exited.recordStart([], 0);
		await exited.recordTerminal("skipped");
	} finally {
		await writer.close();
	}

	// The history an earlier release wrote, read back by a new process.
	const reader = await JournalDurableBackend.open(journal, { ownsJournal: false });
	try {
		const stages = boundaryStages(reader);
		assert.deepEqual(
			stages.flatMap((stage) =>
				stage.topology?.boundary?.event === "terminal" ? [stage.topology.boundary.status] : [],
			),
			["failed", "skipped"],
		);
		const resolved = resolveBoundaryLifecycle(startOf(stages), stages, true);
		assert.ok("lifecycle" in resolved, "error" in resolved ? resolved.error : "");
		assert.equal(resolved.lifecycle.latestTerminal?.topology?.boundary?.status, "skipped");
		// A skipped child is not run again, exactly as when it had never failed before.
		assert.throws(
			() => prepareDurableChildInvocation(boundaryDescriptor(reader)),
			(error: unknown) =>
				error instanceof DurableNestedTopologyError && /no valid replayable child result/.test(error.message),
		);
	} finally {
		await reader.close();
	}
});

test("a failed child resumed and ended by ctx.exit keeps the run's nested history readable and forkable (#4863, #5616)", async () => {
	const backend = await createMemoryTestBackend();
	let attempt = 0;
	const secondStarted = Promise.withResolvers<void>();
	const child = workflow({
		name: "flaky-child",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("child-step", {}, async () => "done");
			if (attempt === 1) throw new Error("child failed on its first attempt");
			// Later attempts run until the parent's ctx.exit ends them.
			secondStarted.resolve();
			await new Promise(() => {});
			return {};
		},
	});
	const sibling = workflow({
		name: "steady-child",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("steady-step", {}, async () => "done");
			return {};
		},
	});
	const parent = workflow({
		name: "exit-parent",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(sibling);
			await Promise.all([
				ctx.workflow(child),
				attempt === 2
					? secondStarted.promise.then(() => ctx.exit({ status: "skipped", reason: "stop" }))
					: undefined,
			]);
			return {};
		},
	});
	const runId = testRunId("resumed-exit");
	const runAttempt = async () => {
		attempt += 1;
		return run(parent, {}, { runId, store: createStore(), durableBackend: backend });
	};

	assert.equal((await runAttempt()).status, "failed");
	assert.ok(
		durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!).some(
			(snapshot) => snapshot.name === "flaky-child" && snapshot.status === "failed",
		),
		"inspect the child that ran before the boundary failed (#5616)",
	);
	const exited = await runAttempt();
	assert.equal(exited.status, "skipped", exited.error);

	// The completed sibling's nested run stays visible, and the exited child's boundary reads as skipped.
	const nestedRuns = (runs: readonly RunSnapshot[], rootId: string) =>
		runs.filter((snapshot) => snapshot.parentRunId === rootId).map((snapshot) => [snapshot.name, snapshot.status]);
	const boundaries = (snapshot: RunSnapshot | undefined) =>
		snapshot?.stages.map((stage) => [stage.name, stage.status]);
	const [root, ...nested] = durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!);
	assert.equal(root?.id, runId);
	assert.deepEqual(boundaries(root), [
		["workflow:steady-child", "completed"],
		["workflow:flaky-child", "skipped"],
	]);
	const expectedChildren = [
		["steady-child", "completed"],
		["flaky-child", "cancelled"],
	];
	assert.deepEqual(nestedRuns(nested, runId), expectedChildren);
	// Replay restores only the completed sibling; the skipped child runs again (#5616).
	assert.deepEqual(nestedRuns(durableNestedRunSnapshots(backend, runId), runId), [["steady-child", "completed"]]);

	// Running the exited run once more refuses the skipped child as it would one that never failed. That attempt ends
	// before it reaches the child's boundary, so its history, durable as live, holds only what it reached (#4874).
	const again = await runAttempt();
	assert.match(again.error ?? "", /no valid replayable child result/);
	const latest = durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!)[0];
	assert.deepEqual(
		boundaries(latest),
		again.stages.map((stage) => [stage.name, stage.status]),
	);
	assert.deepEqual(boundaries(latest), [["workflow:steady-child", "completed"]]);

	const { runId: forkId } = await forkDurableRun(backend, {
		source: "sdk",
		runId,
		cwd: tmpdir(),
		carryMessages: "all",
		definition: parent,
	});
	const [forkRoot, ...forkNested] = durableWorkflowRunSnapshots(backend, backend.getWorkflow(forkId)!);
	assert.equal(forkRoot?.id, forkId);
	assert.deepEqual(boundaries(forkRoot), boundaries(latest));
	assert.deepEqual(nestedRuns(forkNested, forkId), [["steady-child", "completed"]]);
});

test.each([
	["ran a tool", false],
	["only answered a prompt", true],
])(
	"resuming after a failed child that %s runs that child again and replays only its completed sibling (#5616)",
	async (_shape, prompt) => {
		const backend = await createMemoryTestBackend();
		const calls = { steady: 0, flaky: 0 };
		const ui: WorkflowUIAdapter = {
			confirm: async () => true,
			input: async () => "",
			select: async <T extends string>(_message: string, options: readonly T[]) => options[0]!,
			custom: async () => undefined as never,
			editor: async () => "",
		};
		const flaky = workflow({
			name: "flaky-child",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				calls.flaky++;
				if (prompt) await ctx.ui.confirm("continue?");
				else await ctx.tool("flaky-step", { attempt: calls.flaky }, async () => "done");
				if (calls.flaky === 1) throw new Error("child failed on its first attempt");
				// A finished child needs a tracked node; the prompt alone does not make one.
				if (prompt) await ctx.tool("recovery-step", {}, async () => "done");
				return {};
			},
		});
		const steady = workflow({
			name: "steady-child",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				calls.steady++;
				await ctx.tool("steady-step", {}, async () => "done");
				return {};
			},
		});
		const parent = workflow({
			name: "resume-parent",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(steady);
				await ctx.workflow(flaky);
				return {};
			},
		});
		const runId = testRunId(`resume-failed-child-${prompt}`);
		const nestedRuns = (runs: readonly RunSnapshot[]) =>
			runs.filter((snapshot) => snapshot.parentRunId === runId).map((snapshot) => [snapshot.name, snapshot.status]);

		const failed = await run(parent, {}, { runId, store: createStore(), durableBackend: backend, ui });
		assert.equal(failed.status, "failed");
		const inspected = durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!);
		assert.deepEqual(nestedRuns(inspected), [
			["steady-child", "completed"],
			["flaky-child", "failed"],
		]);
		assert.deepEqual(nestedRuns(durableNestedRunSnapshots(backend, runId)), [["steady-child", "completed"]]);

		const store = createStore();
		const resumed = await run(parent, {}, { runId, store, durableBackend: backend, ui });
		assert.equal(resumed.status, "completed", resumed.error);
		assert.deepEqual(calls, { steady: 1, flaky: 2 });
		assert.deepEqual(nestedRuns(store.runs()), [
			["steady-child", "completed"],
			["flaky-child", "completed"],
		]);
	},
);

test("replaying a completed child restores the failed grandchild it handled, without rerunning it (#5616)", async () => {
	const backend = await createMemoryTestBackend();
	let calls = 0;
	const leaf = workflow({
		name: "handled-failure",
		description: "",
		inputs: {},
		outputs: {},
		async run() {
			calls++;
			throw new Error("handled by parent");
		},
	});
	const middle = workflow({
		name: "handles-failure",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(leaf).catch(() => {});
			return {};
		},
	});
	const root = workflow({
		name: "replay-handled",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(middle);
			return {};
		},
	});
	const runId = testRunId("replay-handled");
	for (const store of [createStore(), createStore()]) {
		const result = await run(root, {}, { runId, store, durableBackend: backend });
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(
			store.runs().map((r) => [r.name, r.status]),
			[
				[root.name, "completed"],
				[middle.name, "completed"],
				[leaf.name, "failed"],
			],
		);
		assert.equal(calls, 1);
	}
});

type TerminalStatus = "completed" | "failed" | "skipped";
const TERMINAL_STATUSES: readonly TerminalStatus[] = ["completed", "failed", "skipped"];

/** A small seeded generator, so a failing history can be replayed from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

async function registeredBackend(): Promise<JournalDurableBackend<MemoryRunJournal>> {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: "root",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	return backend;
}

function boundaryStages(backend: JournalDurableBackend<MemoryRunJournal>): DurableStageCheckpoint[] {
	return backend
		.listCheckpoints(ROOT)
		.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
}

function startOf(stages: readonly DurableStageCheckpoint[]): DurableStageCheckpoint {
	return stages.find((stage) => stage.topology?.boundary?.event === "start")!;
}

test("every history the boundary writers record is one the lifecycle validator accepts (#4863)", async () => {
	for (let seed = 1; seed <= 60; seed += 1) {
		const next = random(seed);
		const backend = await registeredBackend();
		const written: TerminalStatus[] = [];
		for (;;) {
			const invocation = prepareDurableChildInvocation(boundaryDescriptor(backend));
			await invocation.recordStart([], 0);
			const status = TERMINAL_STATUSES[Math.floor(next() * TERMINAL_STATUSES.length)]!;
			await invocation.recordTerminal(
				status,
				status === "completed"
					? { workflow: "child", runId: invocation.identity.childRunId, status, exited: false, outputs: {} }
					: undefined,
			);
			written.push(status);
			const stages = boundaryStages(backend);
			const resolved = resolveBoundaryLifecycle(startOf(stages), stages, true);
			assert.ok("lifecycle" in resolved, `seed ${seed} [${written}]: ${"error" in resolved ? resolved.error : ""}`);
			assert.equal(resolved.lifecycle.latestTerminal?.topology?.boundary?.status, status, `seed ${seed}`);
			if (status !== "failed") break;
		}
		// Only a failed child is started again: a completed one is replayed from its result, a skipped one is not run.
		assert.throws(
			() => prepareDurableChildInvocation(boundaryDescriptor(backend)),
			(error: unknown) =>
				error instanceof DurableNestedTopologyError && /no valid replayable child result/.test(error.message),
		);
	}
});

test("the lifecycle validator accepts exactly the per-attempt histories and every history earlier releases read (#4863)", async () => {
	const backend = await registeredBackend();
	const invocation = prepareDurableChildInvocation(boundaryDescriptor(backend));
	await invocation.recordStart([], 0);
	await invocation.recordTerminal("failed");
	const [start, template] = [startOf(boundaryStages(backend)), boundaryStages(backend)[1]!];
	const childRunId = invocation.identity.childRunId;
	const terminal = (status: TerminalStatus, completedAt: number, id: number): DurableStageCheckpoint => ({
		...template,
		checkpointId: `${template.checkpointId}:${id}`,
		completedAt,
		endedAt: completedAt,
		topology: { ...template.topology!, status, boundary: { ...template.topology!.boundary!, status } as never },
		...(status === "completed"
			? {
					output: { workflow: "child", runId: childRunId, status: "completed", exited: false, outputs: {} },
					result: "completed",
				}
			: { output: undefined, result: undefined }),
	});
	let legal = 0;
	const newlyReadable = new Set<string>();
	for (let seed = 1; seed <= 400; seed += 1) {
		const next = random(seed);
		const history = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) => ({
			status: TERMINAL_STATUSES[Math.floor(next() * TERMINAL_STATUSES.length)]!,
			completedAt: 10 + Math.floor(next() * 6),
			id: index,
		}));
		const ordered = [...history].sort((left, right) => left.completedAt - right.completedAt);
		// Legal per attempt: one terminal each, in time order, and every attempt but the last one failed.
		const perAttempt =
			new Set(history.map((entry) => entry.status)).size === history.length &&
			ordered.every(
				(entry, index) =>
					index === 0 ||
					(entry.completedAt !== ordered[index - 1]!.completedAt && ordered[index - 1]!.status === "failed"),
			);
		const records = [start, ...history.map((entry) => terminal(entry.status, entry.completedAt, entry.id))];
		const resolved = resolveBoundaryLifecycle(start, records, true);
		const previous = previousResolveBoundaryLifecycle(start, records, true);
		const label = `seed ${seed}: ${JSON.stringify(history)}`;
		// Whatever earlier releases read stays readable, with the same latest state.
		assert.equal("lifecycle" in resolved, perAttempt || "lifecycle" in previous, label);
		if ("error" in resolved && new Set(history.map((entry) => entry.status)).size === history.length)
			assert.equal(resolved.error, "boundary has an illegal terminal transition", label);
		if ("lifecycle" in previous && "lifecycle" in resolved)
			assert.equal(resolved.lifecycle.latestTerminal, previous.lifecycle.latestTerminal, label);
		if ("lifecycle" in resolved) {
			legal += 1;
			if (!("lifecycle" in previous)) newlyReadable.add(ordered.map((entry) => entry.status).join(","));
			assert.equal(resolved.lifecycle.latestTerminal?.topology?.boundary?.status, ordered.at(-1)!.status, label);
		}
		// Terminals without their start are never a lifecycle.
		assert.ok(
			"error" in
				resolveBoundaryLifecycle(
					start,
					history.map((entry) => terminal(entry.status, entry.completedAt, entry.id)),
					true,
				),
			label,
		);
	}
	assert.ok(legal > 40 && legal < 360, `both legal and illegal histories are generated (${legal} legal)`);
	assert.deepEqual([...newlyReadable], ["failed,skipped"]);
});
