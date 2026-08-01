/**
 * P4 gate for the `@dbos-inc/dbos-sdk` 4.23.6 -> 4.24.16 bump (design D2).
 *
 * Thirteen minors across the SDK that backs workflow durability. The API surface
 * is not the risk; replay and hydration are. The three required parts:
 *
 *  1. a workflow with at least two `ctx.tool` checkpoints, killed mid-run and
 *     resumed, replays every completed tool result from its checkpoint without
 *     re-invoking the callback;
 *  2. hydration validation on resume covers the acyclic-topology check for a
 *     bounded loop that materializes distinct per-iteration nodes;
 *  3. a nested child workflow survives a parent resume with stable per-iteration
 *     identity and call order.
 *
 * "Killed mid-run" is modelled the way the rest of this suite models it: only
 * state the SDK had already committed is carried into a second
 * `DbosDurableBackend` with its own executor id and an empty in-memory mirror,
 * which is precisely what a new process sees. A re-executed side effect here is
 * a failure, not a flake — every callback counter is exact.
 *
 * The kill boundary is also a serialization boundary, and this probe crosses the
 * real one. DBOS 4.24.16 persists step output with `DBOSJSON`: a `superjson`
 * serialization wrapped in a JSON envelope branded with an explicit
 * `__dbos_serializer` marker. `dbosPersistedCopy` below is that encoding,
 * transcribed from `node_modules/@dbos-inc/dbos-sdk/dist/src/serialization.js`,
 * and every checkpoint the mirror carries across the modelled kill is written and
 * read back through it — so a payload the SDK could not persist fails here rather
 * than quietly changing shape in a new process.
 *
 * It is transcribed rather than imported because the SDK does not list
 * `./dist/src/serialization` in its `exports` map, so a deep import of
 * `DBOSJSON` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. `superjson` itself is
 * imported rather than reached through hoisting: the root workspace declares it
 * at the 1.13.3 the SDK resolves. Two guards keep the transcription from going
 * stale — the SDK version is pinned at the one it was taken against, and the
 * marker constants are read back out of the installed serializer — so a bump
 * that moves either fails here instead of leaving a stale copy running.
 *
 * Which serializer runs is not cosmetic. A checkpoint is a
 * `WorkflowSerializableValue`, so most of what SuperJSON adds — `Date`, `Map`,
 * `Set`, `BigInt` — cannot reach one. The difference that survives that
 * narrowing is an `undefined` property, which the type does permit: SuperJSON
 * keeps the key, plain `JSON` drops it. A `JSON.parse(JSON.stringify(...))`
 * handoff would therefore be stricter than the persistence it models, and the
 * boundary test below fails if the handoff is narrowed to one.
 *
 * Still not covered, and out of scope for a dependency gate: a live
 * Postgres-backed replay across two real processes, and a parent killed *after*
 * one nested child boundary completed while a later one is in flight. Resuming
 * that second shape from a fresh DBOS mirror fails to reconstruct the completed
 * child subtree. It is unrelated to this bump — the same shape resumes cleanly
 * on `InMemoryDurableBackend`, and this sync changes nothing under
 * `packages/workflows/src` — so it belongs to the durable layer that owns it.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import superjson from "superjson";
import type { SuperJSONResult } from "superjson/dist/types.js";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { directChildTopologyError } from "../../packages/workflows/src/durable/stage-topology-validation.js";
import type {
	DurableStageCheckpoint,
	DurableStageRunTopology,
	DurableToolCheckpoint,
} from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { moduleDir, readJson, readText } from "../helpers/runtime.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

type MockSdk = ReturnType<typeof createMockSdk>;

/** The SDK version this file's `DBOSJSON` transcription was taken against. */
const MEASURED_DBOS_SDK_VERSION = "4.24.16";

const dbosSdkDir = join(moduleDir(import.meta.url), "../../node_modules/@dbos-inc/dbos-sdk");

/**
 * The envelope `DBOSJSON` brands its SuperJSON writes with, so a reader can tell
 * them from the legacy format. Both constants are read back out of the installed
 * serializer by the boundary test, so a bump that renames either fails there.
 */
const DBOS_SERIALIZER_MARKER_KEY = "__dbos_serializer";
const DBOS_SERIALIZER_MARKER_VALUE = "superjson";

function isDbosBrandedSuperjsonRecord(value: unknown): value is SuperJSONResult {
	return (
		typeof value === "object" &&
		value !== null &&
		DBOS_SERIALIZER_MARKER_KEY in value &&
		value[DBOS_SERIALIZER_MARKER_KEY] === DBOS_SERIALIZER_MARKER_VALUE &&
		"json" in value
	);
}

/** `DBOSJSON.stringify`, transcribed: SuperJSON, branded, then plain JSON. */
function dbosStringify(value: WorkflowSerializableValue): string {
	return JSON.stringify({
		...superjson.serialize(value),
		[DBOS_SERIALIZER_MARKER_KEY]: DBOS_SERIALIZER_MARKER_VALUE,
	});
}

/** `DBOSJSON.parse`, transcribed, on the branded path this file always writes. */
function dbosParse(text: string): WorkflowSerializableValue {
	const parsed: unknown = JSON.parse(text);
	assert.ok(isDbosBrandedSuperjsonRecord(parsed), "a DBOSJSON write must carry the SuperJSON marker");
	return superjson.deserialize<WorkflowSerializableValue>(parsed);
}

/** One `DBOSJSON` write, and the read the next process performs against it. */
function dbosPersistedCopy(value: WorkflowSerializableValue): WorkflowSerializableValue {
	return dbosParse(dbosStringify(value));
}

/**
 * Everything the SDK had committed at the moment of the kill, and nothing else.
 *
 * Step outputs cross through `DBOSJSON` — the serializer DBOS persists them
 * with — rather than through a clone, so a checkpoint the SDK could not write
 * fails here instead of surviving a boundary production would not let it cross.
 */
function committedState(sdk: MockSdk): MockSdk {
	const persisted = createMockSdk();
	for (const [key, value] of sdk.state.workflows) persisted.state.workflows.set(key, { ...value });
	for (const [key, value] of sdk.state.steps) persisted.state.steps.set(key, dbosPersistedCopy(value));
	return persisted;
}

test("the modelled kill boundary is the DBOS serializer, and it keeps an explicitly-undefined property", async () => {
	// The transcription's two anchors. Pin the SDK version it was taken against,
	// and read the marker constants back out of the installed serializer, so a
	// bump that changes either fails here rather than leaving this file writing
	// an envelope DBOS no longer reads.
	const sdkManifest = await readJson<{ version: string }>(join(dbosSdkDir, "package.json"));
	assert.equal(sdkManifest.version, MEASURED_DBOS_SDK_VERSION);

	const installedSerializer = await readText(join(dbosSdkDir, "dist/src/serialization.js"));
	assert.ok(
		installedSerializer.includes(`SERIALIZER_MARKER_KEY = '${DBOS_SERIALIZER_MARKER_KEY}'`),
		`the installed serializer no longer brands with ${DBOS_SERIALIZER_MARKER_KEY}`,
	);
	assert.ok(
		installedSerializer.includes(`SERIALIZER_MARKER_VALUE = '${DBOS_SERIALIZER_MARKER_VALUE}'`),
		`the installed serializer no longer brands with ${DBOS_SERIALIZER_MARKER_VALUE}`,
	);

	// The handoff really runs SuperJSON: the encoded text carries DBOS's brand,
	// which a clone or a JSON round trip cannot produce.
	const checkpoint: WorkflowSerializableValue = { settled: true, cancelled: undefined };
	assert.ok(isDbosBrandedSuperjsonRecord(JSON.parse(dbosStringify(checkpoint))));

	const sdk = createMockSdk();
	sdk.state.steps.set("run:checkpoint:probe", checkpoint);

	const carried = committedState(sdk).state.steps.get("run:checkpoint:probe") as Record<string, unknown>;

	assert.equal(carried.settled, true);
	assert.ok(
		Object.hasOwn(carried, "cancelled"),
		"an explicitly-undefined checkpoint property must survive the kill boundary",
	);

	// And the direction that would be easy to get wrong: plain JSON drops that
	// key, so narrowing the handoff to a JSON round trip makes the probe stricter
	// than the persistence it models.
	assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(checkpoint)) as object, "cancelled"), false);
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const completeAdapter = { complete: { complete: async (text: string): Promise<string> => text } };

test("two completed tool checkpoints replay from DBOS after a mid-run kill without re-invoking the callback", async () => {
	const sdk = createMockSdk();
	const firstBackend = new DbosDurableBackend(sdk, { executorId: "killed-process" });
	const runId = "dbos-replay-two-tools";
	const calls = { first: 0, second: 0, third: 0 };
	const thirdStarted = deferred();
	const thirdGate = deferred();

	const definition = workflow({
		name: "two-tool-replay",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const first = await ctx.tool("first-effect", { step: 1 }, async () => {
				calls.first += 1;
				return "first-output";
			});
			const second = await ctx.tool("second-effect", { step: 2 }, async () => {
				calls.second += 1;
				return "second-output";
			});
			const third = await ctx.tool("third-effect", { step: 3 }, async () => {
				calls.third += 1;
				thirdStarted.resolve();
				await thirdGate.promise;
				return "third-output";
			});
			return { value: `${first}/${second}/${third}` };
		},
	});

	const controller = new AbortController();
	const killedRun = run(
		definition,
		{},
		{
			runId,
			store: createStore(),
			durableBackend: firstBackend,
			signal: controller.signal,
			adapters: completeAdapter,
		},
	);
	await thirdStarted.promise;
	await firstBackend.flush();
	const persistedSdk = committedState(sdk);
	controller.abort(new Error("process killed mid-run"));
	thirdGate.resolve();
	await killedRun;

	assert.deepEqual(calls, { first: 1, second: 1, third: 1 }, "the killed process must have run each effect once");

	const resumedBackend = new DbosDurableBackend(persistedSdk, { executorId: "resumed-process" });
	assert.equal(resumedBackend.listCheckpoints(runId).length, 0, "a fresh backend starts with an empty mirror");
	await resumedBackend.hydrateWorkflow(runId);

	const toolCheckpoints = resumedBackend
		.listCheckpoints(runId)
		.filter((checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool")
		.filter((checkpoint) => checkpoint.name.endsWith("-effect"));
	assert.deepEqual(
		toolCheckpoints.map((checkpoint) => checkpoint.name).sort(),
		["first-effect", "second-effect"],
		"only the two completed tools may have reached DBOS",
	);

	const resumed = await run(
		definition,
		{},
		{ runId, store: createStore(), durableBackend: resumedBackend, adapters: completeAdapter },
	);

	assert.equal(resumed.status, "completed");
	assert.equal(resumed.result?.value, "first-output/second-output/third-output");
	assert.deepEqual(
		calls,
		{ first: 1, second: 1, third: 2 },
		"a completed tool re-executed its side effect instead of replaying its checkpoint",
	);
});

/** The tool nodes a child run contributes, which its stages legitimately name as parents. */
function childToolNodeIds(backend: DbosDurableBackend, runId: string, childRunId: string): Set<string> {
	return new Set(
		backend
			.listCheckpoints(runId)
			.filter((checkpoint): checkpoint is DurableToolCheckpoint => checkpoint.kind === "tool")
			.filter((checkpoint) => checkpoint.topology?.run?.runId === childRunId)
			.map((checkpoint) => checkpoint.topology?.nodeId ?? ""),
	);
}

interface BoundaryRecord {
	readonly replayScope: string;
	readonly child: DurableStageRunTopology;
	readonly stageId: string;
	readonly name: string;
}

function boundaryStarts(backend: DbosDurableBackend, runId: string): BoundaryRecord[] {
	return backend
		.listCheckpoints(runId)
		.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage")
		.flatMap((checkpoint) => {
			const boundary = checkpoint.topology?.boundary;
			if (boundary === undefined || boundary.event !== "start") return [];
			return [
				{
					replayScope: boundary.replayScope,
					child: boundary.child,
					stageId: checkpoint.topology?.stageId ?? "",
					name: checkpoint.name,
				},
			];
		});
}

function loopWorkflows(calls: { child: number; tool: number }, iterations: number) {
	const child = workflow({
		name: "bounded-loop-child",
		description: "",
		inputs: { index: Type.Number() },
		outputs: { value: Type.String() },
		run: async (ctx) => {
			calls.child += 1;
			const effect = await ctx.tool("iteration-effect", { index: ctx.inputs.index }, async () => {
				calls.tool += 1;
				return `effect-${ctx.inputs.index}`;
			});
			const staged = await ctx.stage(`iteration-stage-${ctx.inputs.index}`).complete(`stage-${ctx.inputs.index}`);
			return { value: `${effect}:${staged}` };
		},
	});
	const parent = workflow({
		name: "bounded-loop-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const parts: string[] = [];
			// A bounded loop that materializes a distinct node set per iteration:
			// each pass gets its own boundary stage, child run, and tool node.
			for (let index = 0; index < iterations; index += 1) {
				const iteration = await ctx.workflow(child, { inputs: { index }, stageName: `iteration-${index}` });
				if (iteration.exited) throw new Error("child exited");
				parts.push(iteration.outputs.value);
			}
			return { value: parts.join(",") };
		},
	});
	return { child, parent };
}

test("hydration validates the acyclic topology of a bounded loop's per-iteration nodes", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend(sdk, { executorId: "loop-process" });
	const runId = "dbos-replay-bounded-loop";
	const calls = { child: 0, tool: 0 };
	const { parent } = loopWorkflows(calls, 3);

	const completed = await run(
		parent,
		{},
		{ runId, store: createStore(), durableBackend: backend, adapters: completeAdapter },
	);
	assert.equal(completed.status, "completed", completed.error);
	assert.deepEqual(calls, { child: 3, tool: 3 }, "each iteration must run its child and its effect exactly once");
	await backend.flush();

	const hydrated = new DbosDurableBackend(committedState(sdk), { executorId: "loop-hydrating-process" });
	await hydrated.hydrateWorkflow(runId);
	assert.equal(hydrated.isWorkflowLoadable(runId), true, "hydration rejected a valid bounded-loop topology");

	const boundaries = boundaryStarts(hydrated, runId);
	assert.deepEqual(
		boundaries.map((boundary) => boundary.name),
		["iteration-0", "iteration-1", "iteration-2"],
	);
	assert.equal(new Set(boundaries.map((b) => b.stageId)).size, 3, "iterations must materialize distinct nodes");
	assert.equal(
		new Set(boundaries.map((b) => b.child.runId)).size,
		3,
		"iterations must materialize distinct child runs",
	);

	const stages = hydrated
		.listCheckpoints(runId)
		.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");

	for (const boundary of boundaries) {
		assert.equal(
			directChildTopologyError(
				stages,
				boundary.replayScope,
				boundary.child,
				true,
				childToolNodeIds(hydrated, runId, boundary.child.runId),
			),
			undefined,
			`${boundary.name} failed the hydration topology check`,
		);
	}

	// The same check, over the same hydrated records, with one iteration's stage
	// made its own ancestor. Without this the assertions above would also pass
	// against a validator that had stopped looking for cycles.
	const scoped = boundaries[1] as BoundaryRecord;
	const cyclic = stages.map((stage) => {
		if (stage.topology?.run?.runId !== scoped.child.runId || stage.topology.boundary !== undefined) return stage;
		return { ...stage, topology: { ...stage.topology, parentIds: [stage.topology.stageId] } };
	});
	assert.match(
		directChildTopologyError(
			cyclic,
			scoped.replayScope,
			scoped.child,
			true,
			childToolNodeIds(hydrated, runId, scoped.child.runId),
		) ?? "",
		/cycle/u,
	);
});

test("a nested child workflow survives a parent resume with stable per-iteration identity and call order", async () => {
	const sdk = createMockSdk();
	const firstBackend = new DbosDurableBackend(sdk, { executorId: "loop-killed-process" });
	const runId = "dbos-replay-nested-resume";
	const calls = { child: 0, tool: 0 };
	const order: string[] = [];
	const firstIterationStarted = deferred();
	const firstIterationGate = deferred();

	const child = workflow({
		name: "nested-resume-child",
		description: "",
		inputs: { index: Type.Number() },
		outputs: { value: Type.String() },
		run: async (ctx) => {
			calls.child += 1;
			const effect = await ctx.tool("iteration-effect", { index: ctx.inputs.index }, async () => {
				calls.tool += 1;
				order.push(`effect-${ctx.inputs.index}`);
				if (ctx.inputs.index === 0) {
					firstIterationStarted.resolve();
					await firstIterationGate.promise;
				}
				return `effect-${ctx.inputs.index}`;
			});
			const staged = await ctx.stage(`iteration-stage-${ctx.inputs.index}`).complete(effect);
			return { value: staged };
		},
	});
	const parent = workflow({
		name: "nested-resume-parent",
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const parts: string[] = [];
			for (let index = 0; index < 3; index += 1) {
				const iteration = await ctx.workflow(child, { inputs: { index }, stageName: `iteration-${index}` });
				if (iteration.exited) throw new Error("child exited");
				parts.push(iteration.outputs.value);
			}
			return { value: parts.join(",") };
		},
	});

	const controller = new AbortController();
	const killedStore = createStore();
	const killedRun = run(
		parent,
		{},
		{ runId, store: killedStore, durableBackend: firstBackend, signal: controller.signal, adapters: completeAdapter },
	);
	await firstIterationStarted.promise;
	await firstBackend.flush();
	const persistedSdk = committedState(sdk);
	const killedBoundaries = boundaryStarts(firstBackend, runId);
	controller.abort(new Error("parent killed inside its first nested child"));
	firstIterationGate.resolve();
	await killedRun;

	assert.deepEqual(order, ["effect-0"], "the killed parent must have reached exactly one iteration");

	const resumedBackend = new DbosDurableBackend(persistedSdk, { executorId: "loop-resumed-process" });
	await resumedBackend.hydrateWorkflow(runId);
	const resumedStore = createStore();
	const resumed = await run(
		parent,
		{},
		{ runId, store: resumedStore, durableBackend: resumedBackend, adapters: completeAdapter },
	);

	assert.equal(resumed.status, "completed", resumed.error);
	assert.equal(resumed.result?.value, "effect-0,effect-1,effect-2");
	// The interrupted first iteration re-runs in the new process, then the loop
	// continues in its own order. Order is the loop's order, not a race.
	assert.deepEqual(order, ["effect-0", "effect-0", "effect-1", "effect-2"]);
	assert.deepEqual(calls, { child: 4, tool: 4 }, "only the interrupted iteration may run a second time");

	const resumedBoundaries = boundaryStarts(resumedBackend, runId);
	assert.deepEqual(
		resumedBoundaries.map((boundary) => boundary.name),
		["iteration-0", "iteration-1", "iteration-2"],
	);
	// Per-iteration identity is stable across the kill: the boundary stage id and
	// the child run id each iteration owned before the kill are the ones it owns
	// after it.
	for (const before of killedBoundaries) {
		const after = resumedBoundaries.find((boundary) => boundary.name === before.name);
		assert.ok(after, `${before.name} lost its boundary across the resume`);
		assert.equal(after.stageId, before.stageId, `${before.name} changed boundary identity across the resume`);
		assert.equal(
			after.child.runId,
			before.child.runId,
			`${before.name} changed child run identity across the resume`,
		);
		assert.equal(after.child.parentRunId, runId);
		assert.equal(after.child.rootRunId, runId);
	}
});
