import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "@bastani/atomic";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	ForkClaimReleaseError,
	ForkCleanupError,
	ForkConfigError,
	ForkCopyFailedError,
	ForkSessionNotFoundError,
	ForkSourceBusyError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { durableForkPoints, durableForkTarget, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import type { RunJournalSeedEvent } from "../../packages/workflows/src/durable/journal/types.js";
import { claimsOf, pendingForks } from "../../packages/workflows/src/durable/run-claims.js";
import type {
	DurableCheckpoint,
	DurableStageCheckpoint,
	DurableToolCheckpoint,
	DurableWorkflowHandle,
} from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createGraphStageActions } from "../../packages/workflows/src/extension/workflow-graph-stage-actions.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

const opened = vi.hoisted(() => ({
	store: undefined as SessionStore | undefined,
	/** Session stores by the directory they are selected for; any other directory gets `store`. */
	byCwd: new Map<string, SessionStore>(),
	stores: [] as { cwd: string | undefined; closes: number }[],
}));

vi.mock("../../packages/workflows/src/shared/stage-session-store.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../packages/workflows/src/shared/stage-session-store.js")>();
	return {
		...original,
		stageSessionStore: async (options: { cwd?: string }) => {
			const entry = { cwd: options.cwd, closes: 0 };
			opened.stores.push(entry);
			return new Proxy(opened.byCwd.get(options.cwd ?? "") ?? opened.store!, {
				get(target, property) {
					if (property === "close")
						return async () => {
							entry.closes++;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});

afterEach(async () => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
	opened.stores.length = 0;
	opened.store = undefined;
	opened.byCwd.clear();
	await closeMemoryTestBackends();
});

const definition = workflow({ name: "copy-source", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
const request = (runId: string) => ({ source: "sdk" as const, runId, carryMessages: "before" as const, definition });

function stage(
	runId: string,
	checkpointId: string,
	name: string,
	replayKey: string,
	extra: Partial<DurableStageCheckpoint> = {},
): DurableStageCheckpoint {
	return { kind: "stage", workflowId: runId, checkpointId, name, replayKey, completedAt: 1, ...extra };
}

function tool(runId: string, checkpointId: string, extra: Partial<DurableToolCheckpoint> = {}): DurableToolCheckpoint {
	return {
		kind: "tool",
		workflowId: runId,
		checkpointId,
		name: checkpointId,
		argsHash: checkpointId,
		output: checkpointId,
		completedAt: 1,
		...extra,
	};
}

function ui(runId: string, checkpointId: string): DurableCheckpoint {
	return {
		kind: "ui",
		workflowId: runId,
		checkpointId,
		promptKind: "input",
		message: "plain",
		promptHash: checkpointId,
		response: "answer",
		completedAt: 1,
	};
}

async function register(backend: MemoryJournalBackend, runId: string, extra: object = {}) {
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: definition.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		invocationCwd: "/source",
		...extra,
	});
}

async function commit(backend: MemoryJournalBackend, checkpoints: readonly DurableCheckpoint[]) {
	for (const checkpoint of checkpoints) await backend.commitCheckpoint(checkpoint);
}

function captureSeeds(backend: MemoryJournalBackend): RunJournalSeedEvent[][] {
	const seeds: RunJournalSeedEvent[][] = [];
	const create = backend.journal.createRunWithEvents.bind(backend.journal);
	vi.spyOn(backend.journal, "createRunWithEvents").mockImplementation(async (header, seed) => {
		seeds.push([...seed]);
		return create(header, seed);
	});
	return seeds;
}

const checkpointPayloads = (seed: readonly RunJournalSeedEvent[]) =>
	seed
		.filter((entry) => entry.event.type === "CheckpointRecorded")
		.map((entry) => entry.event.payload as unknown as DurableCheckpoint);

const handlePayload = (seed: readonly RunJournalSeedEvent[]) =>
	seed[0]!.event.payload as unknown as DurableWorkflowHandle;

async function copiedIds(backend: MemoryJournalBackend, runId: string, options: object): Promise<string[]> {
	const fork = await forkDurableRun(backend, { ...request(runId), ...options });
	return backend.listCheckpoints(fork.runId).map((checkpoint) => checkpoint.checkpointId);
}

async function pointPaths(backend: MemoryJournalBackend, runId: string): Promise<string[]> {
	const paths: string[] = [];
	for await (const point of durableForkPoints(backend, runId)) paths.push(point.stagePath);
	return paths;
}

function boundary(
	runId: string,
	key: string,
	name: string,
	childRunId: string,
	extra: Partial<DurableStageCheckpoint> = {},
) {
	return stage(runId, `boundary-start:${key}`, name, key, {
		topology: {
			version: 1,
			stageId: `${name}-id`,
			parentIds: [],
			boundary: {
				version: 1,
				event: "start",
				status: "running",
				replayScope: key,
				alias: name,
				workflow: name,
				invocationFingerprint: "fp",
				child: {
					runId: childRunId,
					runName: name,
					parentRunId: runId,
					parentStageId: `${name}-id`,
					rootRunId: runId,
				},
			},
		},
		...extra,
	});
}

function boundaryEnd(
	runId: string,
	key: string,
	name: string,
	childRunId: string,
	output: DurableStageCheckpoint["output"],
): DurableStageCheckpoint {
	const start = boundary(runId, key, name, childRunId);
	return {
		...start,
		checkpointId: `boundary-end:${key}`,
		output,
		topology: {
			...start.topology!,
			boundary: { ...start.topology!.boundary!, event: "terminal", status: "completed" },
		},
	};
}

test("a fork keeps the checkpoints that completed before the fork point and the prompt answers it was told to carry (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("select-cut");
	await register(backend, sourceId);
	await commit(backend, [
		tool(sourceId, "tool:t1"),
		ui(sourceId, "ui:before"),
		stage(sourceId, "stage-session:x", "x", "stage:x:1"),
		stage(sourceId, "stage:b", "b", "stage:b:1", { output: "b" }),
		stage(sourceId, "stage-session:a", "a", "stage:a:1"),
		stage(sourceId, "stage:b2", "b2", "stage:b2:1", { output: "b2" }),
		ui(sourceId, "ui:after"),
		tool(sourceId, "tool:t2"),
		stage(sourceId, "stage:a", "a", "stage:a:1", { output: "a" }),
		stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x" }),
		tool(sourceId, "run-result:1", { name: "__run_result__" }),
	]);
	const fromA = { fromStage: "a" };
	assert.deepEqual(await copiedIds(backend, sourceId, fromA), ["tool:t1", "ui:before", "stage:b"]);
	assert.deepEqual(await copiedIds(backend, sourceId, { ...fromA, carryMessages: "all" }), [
		"tool:t1",
		"ui:before",
		"stage:b",
		"ui:after",
	]);
	assert.equal((await copiedIds(backend, sourceId, {})).length, 11, "a whole-run fork copies every checkpoint");
	assert.deepEqual(opened.stores, [], "no session store is opened when no session is copied");
});

function topo(stageId: string, status: string) {
	return { topology: { version: 1, stageId, parentIds: [], status } } as unknown as Partial<DurableStageCheckpoint>;
}

test("a fork from a failed stage reruns it and everything after it from scratch, and replays the stages completed before it (#5224)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("fork-failed");
	await register(backend, sourceId, { status: "failed" });
	await commit(backend, [
		tool(sourceId, "tool:before"),
		stage(sourceId, "stage:plan", "plan", "stage:plan:1", { output: "plan", ...topo("plan-id", "completed") }),
		stage(sourceId, "stage-session:verify", "verify", "stage:verify:1", topo("verify-id", "running")),
		tool(sourceId, "tool:inside", {
			topology: { version: 1, nodeId: "tool:inside", parentIds: [], ordinal: 1, order: 1 },
		}),
		stage(sourceId, "stage-meta:verify", "verify", "stage:verify:1", topo("verify-id", "failed")),
	]);
	assert.deepEqual(await pointPaths(backend, sourceId), ["plan"], "listForkPoints still lists completed stages only");
	assert.deepEqual(
		await copiedIds(backend, sourceId, { fromStage: "verify" }),
		["tool:before", "stage:plan", "stage:verify:1:fork-point-topology"],
		"the failed stage's records and the completed tool step inside it are left out, so both run again; only its place in the graph is kept",
	);
	assert.deepEqual(await durableForkTarget(backend, sourceId, "verify-id"), {
		stagePath: "verify",
		completed: false,
		rerunToolSteps: 1,
	});
	assert.deepEqual(await durableForkTarget(backend, sourceId, "plan-id"), {
		stagePath: "plan",
		completed: true,
		rerunToolSteps: 1,
	});
});

test("the graph fork confirmation counts tool calls once across replay and excludes run metadata (#5234)", async () => {
	const backend = await createMemoryTestBackend();
	const store = createStore();
	const sourceId = testRunId("fork-tool-count");
	let writes = 0;
	const definition = workflow({
		name: "fork-tool-count",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("plan").complete("ok");
			await ctx.tool("write", {}, async () => ++writes);
			await ctx.stage("verify").prompt("verify");
			return {};
		},
	});
	const adapters = {
		complete: { complete: async (text: string) => text },
		prompt: {
			prompt: async () => {
				throw new Error("planned failure");
			},
		},
	};
	await run(definition, {}, { runId: sourceId, store, durableBackend: backend, adapters });
	const plan = store.run(sourceId)!.stages[0]!;
	await run(definition, {}, { runId: sourceId, store: createStore(), durableBackend: backend, adapters });
	assert.equal(writes, 1, "the second attempt replays the tool call");
	assert.deepEqual(await durableForkTarget(backend, sourceId, plan.id), {
		stagePath: "plan",
		completed: true,
		rerunToolSteps: 1,
	});
});

test("a loaded graph fork lookup reads only new journal events and keeps record order across clock changes (#5234)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("fork-lookup-tail");
	await register(backend, sourceId, { status: "failed" });
	await commit(backend, [
		stage(sourceId, "plan", "plan", "plan:1", { output: "ok", completedAt: 100, ...topo("plan-id", "completed") }),
		stage(sourceId, "verify-start", "verify", "verify:1", { completedAt: 5, ...topo("verify-id", "running") }),
		tool(sourceId, "inside", {
			completedAt: 3,
			topology: { version: 1, nodeId: "tool:inside", parentIds: [], ordinal: 1, order: 1 },
		}),
		stage(sourceId, "verify-failed", "verify", "verify:1", { completedAt: 1, ...topo("verify-id", "failed") }),
	]);
	const reads = vi.spyOn(backend.journal, "read");
	assert.deepEqual(await durableForkTarget(backend, sourceId, "verify-id"), {
		stagePath: "verify",
		completed: false,
		rerunToolSteps: 1,
	});
	assert.ok(
		reads.mock.calls.every(([, fromSeq]) => (fromSeq ?? 1) > 1),
		"a loaded lookup never replays the journal from its start",
	);
	await backend.retainCheckpoints(sourceId, { ids: [], prefixes: [] });
	reads.mockClear();
	assert.deepEqual(await durableForkTarget(backend, sourceId, "verify-id"), {
		stagePath: "verify",
		completed: false,
		rerunToolSteps: 1,
	});
	assert.ok(
		reads.mock.calls.some(([, fromSeq]) => (fromSeq ?? 1) === 1),
		"a narrowed view loads the missing records instead of using an incomplete projection",
	);
});

test("a failed nested workflow boundary is a fork target in the graph (#5234)", async () => {
	const backend = await createMemoryTestBackend();
	const store = createStore();
	const sourceId = testRunId("fork-failed-child");
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("verify").prompt("verify");
			return {};
		},
	});
	const parent = workflow({
		name: "parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child, {});
			return {};
		},
	});
	await run(
		parent,
		{},
		{
			runId: sourceId,
			store,
			durableBackend: backend,
			adapters: {
				prompt: {
					prompt: async () => {
						throw new Error("planned failure");
					},
				},
			},
		},
	);
	const failedBoundary = store.run(sourceId)!.stages[0]!;
	assert.equal(failedBoundary.status, "failed");
	const target = await durableForkTarget(backend, sourceId, failedBoundary.id);
	assert.equal(target?.stagePath, "workflow:child");
	assert.equal(target?.completed, false);
	assert.equal(target?.rerunToolSteps, 0);
	const fork = await forkDurableRun(backend, {
		...request(sourceId),
		definition: parent,
		fromStage: target!.stagePath,
	});
	assert.deepEqual(backend.getWorkflow(fork.runId)?.forkedFrom, { runId: sourceId, stagePath: target!.stagePath });
});

test("confirming a fork still targets the failed stage after a same-named sibling completes (#5234)", async () => {
	const backend = await createMemoryTestBackend();
	const store = createStore();
	const sourceId = testRunId("fork-confirm-stage-identity");
	const failed = Promise.withResolvers<void>();
	const waiting = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const definition = workflow({
		name: "fork-confirm-stage-identity",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await Promise.allSettled([
				ctx
					.stage("review")
					.prompt("fail")
					.finally(() => failed.resolve()),
				ctx.stage("review").prompt("wait"),
			]);
			return {};
		},
	});
	const adapters = {
		prompt: {
			prompt: async (text: string) => {
				if (text === "fail") throw new Error("planned failure");
				waiting.resolve();
				await finish.promise;
				return text;
			},
		},
	};
	const running = run(
		definition,
		{},
		{ runId: sourceId, store, durableBackend: backend, adapters, cwd: process.cwd() },
	);
	await Promise.all([failed.promise, waiting.promise]);
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({ definitions: [definition], store, jobs, adapters, cwd: process.cwd() });
	const actions = createGraphStageActions({
		owner: { ...captureWorkflowOwnerResources(), store, jobs },
		runtime: () => runtime,
		context: () => ({ hasUI: true }),
	});
	const selected = store.run(sourceId)!.stages.find((stage) => stage.status === "failed")!;
	const confirmation = await actions.forkTarget!(sourceId, selected.id);
	assert.equal(confirmation.ok, true);
	finish.resolve();
	await running;
	const latest = await durableForkTarget(backend, sourceId, selected.id);
	assert.notEqual(latest?.stagePath, confirmation.stagePath);
	await assert.rejects(
		forkDurableRun(backend, {
			...request(sourceId),
			definition,
			fromStage: confirmation.stagePath,
			expectedStageId: selected.id,
		}),
		{ name: "ForkTargetNotFoundError" },
	);
	const outcome = await actions.fork!(sourceId, selected.id);
	assert.ok(outcome.ok, outcome.message);
	assert.ok(outcome.runId);
	await jobs.get(outcome.runId)?.promise;
	assert.equal(backend.getWorkflow(outcome.runId)?.forkedFrom?.stagePath, latest?.stagePath);
});

test("an unknown fork target lists eligible unfinished stages as well as completed ones (#5234)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("fork-valid-unfinished");
	await register(backend, sourceId, { status: "failed" });
	await commit(backend, [
		stage(sourceId, "plan", "plan", "plan:1", { output: "ok", ...topo("plan", "completed") }),
		stage(sourceId, "verify", "verify", "verify:1", topo("verify", "failed")),
	]);
	await assert.rejects(forkDurableRun(backend, { ...request(sourceId), fromStage: "missing" }), {
		name: "ForkTargetNotFoundError",
		validStagePaths: ["plan", "verify"],
		totalValidStagePaths: 2,
	});
});

test("a fork from a completed stage is unchanged by unfinished-stage targets (#5224)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("fork-completed-same");
	await register(backend, sourceId, { status: "failed" });
	await commit(backend, [
		stage(sourceId, "stage:a", "a", "stage:a:1", { output: "a", ...topo("a-id", "completed") }),
		tool(sourceId, "tool:t"),
		stage(sourceId, "stage:b", "b", "stage:b:1", { output: "b", ...topo("b-id", "completed") }),
		stage(sourceId, "stage-meta:c", "c", "stage:c:1", topo("c-id", "failed")),
	]);
	assert.deepEqual(await copiedIds(backend, sourceId, { fromStage: "b" }), [
		"stage:a",
		"tool:t",
		"stage:b:1:fork-point-topology",
	]);
});

test("a stage still running is not a fork target, and a repeated failed stage name continues the occurrence numbering (#5224)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("fork-running");
	await register(backend, sourceId, { status: "failed" });
	await commit(backend, [
		stage(sourceId, "stage:review", "review", "stage:review:1", { output: "r", ...topo("review-1", "completed") }),
		stage(sourceId, "stage-meta:review2", "review", "stage:review:2", topo("review-2", "failed")),
		stage(sourceId, "stage-session:other", "other", "stage:other:1", topo("other-id", "running")),
	]);
	await assert.rejects(forkDurableRun(backend, { ...request(sourceId), fromStage: "other" }), {
		name: "ForkTargetNotFoundError",
	});
	assert.equal(await durableForkTarget(backend, sourceId, "other-id"), undefined);
	assert.equal((await durableForkTarget(backend, sourceId, "review-2"))?.stagePath, "review#2");
	assert.deepEqual(await copiedIds(backend, sourceId, { fromStage: "review#2" }), [
		"stage:review",
		"stage:review:2:fork-point-topology",
	]);
});

test("a fork keeps the records of a prompt answered before the fork point, and not those of a stage that did not complete (#4879)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("select-prompt-records");
	await register(backend, sourceId);
	const topology = (stageId: string, status: "running" | "completed" | "failed") => ({
		version: 1 as const,
		stageId,
		parentIds: [],
		sourceOrder: 0,
		status,
		occurrenceKey: `${stageId}-occurrence`,
	});
	await commit(backend, [
		stage(sourceId, "stage-active-meta:answered", "input", "prompt:input:answered", {
			topology: topology("answered", "running"),
		}),
		stage(sourceId, "stage-meta:prompt:input:answered", "input", "prompt:input:answered", {
			topology: topology("answered", "completed"),
		}),
		ui(sourceId, "ui:answered"),
		stage(sourceId, "stage-active-meta:unanswered", "input", "prompt:input:unanswered", {
			topology: topology("unanswered", "running"),
		}),
		stage(sourceId, "stage-meta:failed", "failed", "stage:failed:1", { topology: topology("failed", "failed") }),
		stage(sourceId, "stage:a", "a", "stage:a:1", { output: "a" }),
	]);
	assert.deepEqual(await copiedIds(backend, sourceId, { fromStage: "a" }), [
		"stage-active-meta:answered",
		"stage-meta:prompt:input:answered",
		"ui:answered",
	]);
});

test("a fork from a nested workflow stage drops that workflow's start and remaps its recorded child result (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("select-boundary");
	const childId = testRunId("select-boundary-child");
	const otherChild = testRunId("select-boundary-other");
	const key = "workflow:outer:fp:1";
	const childResult = { workflow: "outer", runId: childId, status: "completed", exited: false, outputs: {} };
	const lookalike = { workflow: "w", runId: otherChild, status: "completed", exited: false, outputs: {} };
	await register(backend, sourceId);
	await commit(backend, [
		stage(sourceId, "stage:setup", "setup", "stage:setup:1", { output: "setup" }),
		boundary(sourceId, key, "outer", childId),
		stage(sourceId, `${key}:stage:review`, "review", `${key}:stage:review:1`, { output: "review" }),
		boundaryEnd(sourceId, key, "outer", childId, childResult),
		stage(sourceId, "stage:lookalike", "lookalike", "stage:lookalike:1", { output: lookalike }),
		stage(sourceId, "stage:after", "after", "stage:after:1", { output: "after" }),
	]);
	assert.deepEqual(await pointPaths(backend, sourceId), ["setup", "outer.review", "outer", "lookalike", "after"]);
	const seeds = captureSeeds(backend);
	assert.deepEqual(await copiedIds(backend, sourceId, { fromStage: "outer" }), ["stage:setup"]);
	const fork = await forkDurableRun(backend, { ...request(sourceId), fromStage: "after" });
	const copied = checkpointPayloads(seeds[1]!);
	const start = copied.find((checkpoint) => checkpoint.checkpointId === `boundary-start:${key}`);
	const end = copied.find((checkpoint) => checkpoint.checkpointId === `boundary-end:${key}`);
	const alike = copied.find((checkpoint) => checkpoint.checkpointId === "stage:lookalike");
	assert.ok(start?.kind === "stage" && end?.kind === "stage" && alike?.kind === "stage");
	const newChild = start.topology?.boundary?.child.runId;
	assert.notEqual(newChild, childId);
	assert.deepEqual(end.output, { ...childResult, runId: newChild });
	assert.deepEqual(alike.output, lookalike, "an output that only looks like a child result is not remapped");
	assert.equal(fork.forkedFrom.stagePath, "after");
});

test("nested stage paths name only workflow boundaries, whichever order their checkpoints were recorded in (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const plainId = testRunId("select-plain-keys");
	await register(backend, plainId);
	await commit(backend, [
		stage(plainId, "stage:alpha", "alpha", "k", { output: "alpha" }),
		stage(plainId, "stage:beta", "beta", "k:1", { output: "beta" }),
		stage(plainId, "stage:alpha-again", "alpha", "k", { output: "again" }),
	]);
	assert.deepEqual(await pointPaths(backend, plainId), ["alpha", "beta"]);
	const nestedId = testRunId("select-inner-first");
	await register(backend, nestedId);
	const outer = "workflow:outer:fp:1";
	const inner = `${outer}:workflow:inner:fp:1`;
	await commit(backend, [
		boundary(nestedId, inner, "inner", testRunId("select-inner")),
		boundary(nestedId, outer, "outer", testRunId("select-outer")),
		stage(nestedId, `${inner}:stage:deep`, "deep", `${inner}:stage:deep:1`, { output: "deep" }),
	]);
	assert.deepEqual(await pointPaths(backend, nestedId), ["outer.inner.deep"]);
});

test("fork points treat an output as a session only when it has text and a string session id (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("select-session-shapes");
	await register(backend, sourceId);
	await commit(backend, [
		stage(sourceId, "stage:ghost", "ghost", "stage:ghost:1", { output: { sessionId: "ghost-session" } }),
		stage(sourceId, "stage:numeric", "numeric", "stage:numeric:1", { output: { text: "t", sessionId: 5 } }),
	]);
	const points = [];
	for await (const point of durableForkPoints(backend, sourceId, { sourceSessionStore: new MemorySessionStore() }))
		points.push(point);
	assert.deepEqual(points, [
		{ stagePath: "ghost", completedAt: 1 },
		{ stagePath: "numeric", completedAt: 1 },
	]);
});

test("a unique 8-character run id prefix names the source for forks and fork points (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("select-prefix");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x" })]);
	assert.deepEqual(await pointPaths(backend, sourceId.slice(0, 8)), ["x"]);
	const fork = await forkDurableRun(backend, request(sourceId.slice(0, 8)));
	assert.deepEqual(fork.forkedFrom, { runId: sourceId });
});

test("a fork opens the source and destination session stores for the run's directories and closes both (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const shared = new MemorySessionStore();
	opened.store = shared;
	const session = await SessionManager.create(shared, "/source");
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const sourceId = testRunId("stores-fork");
	await register(backend, sourceId, { workflowCwd: "/worktree" });
	await commit(backend, [
		stage(sourceId, "stage:saved", "saved", "stage:saved:1", { output: "saved", sessionId: session.getSessionId() }),
	]);
	await forkDurableRun(backend, { ...request(sourceId), cwd: "/destination" });
	assert.deepEqual(opened.stores, [
		{ cwd: "/worktree", closes: 1 },
		{ cwd: "/destination", closes: 1 },
	]);
	opened.stores.length = 0;
	const failure = new Error("store full");
	vi.spyOn(shared, "create").mockRejectedValue(failure);
	const error = await forkDurableRun(backend, { ...request(sourceId), cwd: "/destination" }).catch(
		(problem: Error) => problem,
	);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.deepEqual([error.phase, error.cause], ["sessions", failure]);
	assert.deepEqual(opened.stores, [
		{ cwd: "/worktree", closes: 1 },
		{ cwd: "/destination", closes: 1 },
	]);
});

test("fork points read the store of the workflow directory, then the invocation directory, then the given one (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const shared = new MemorySessionStore();
	opened.store = shared;
	const session = await SessionManager.create(shared, "/source");
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const cases = [
		{ extra: { workflowCwd: "/worktree" }, options: { cwd: "/given" }, expected: "/worktree" },
		{ extra: {}, options: { cwd: "/given" }, expected: "/source" },
		{ extra: { invocationCwd: undefined }, options: { cwd: "/given" }, expected: "/given" },
		{ extra: { invocationCwd: undefined }, options: {}, expected: process.cwd() },
	];
	for (const [index, { extra, options, expected }] of cases.entries()) {
		const sourceId = testRunId(`stores-points-${index}`);
		await register(backend, sourceId, extra);
		await commit(backend, [
			stage(sourceId, "stage:saved", "saved", "stage:saved:1", {
				output: "saved",
				sessionId: session.getSessionId(),
			}),
			stage(sourceId, "stage:again", "again", "stage:again:1", {
				output: "again",
				sessionId: session.getSessionId(),
			}),
		]);
		opened.stores.length = 0;
		const points = [];
		for await (const point of durableForkPoints(backend, sourceId, options)) points.push(point.stagePath);
		assert.deepEqual(points, ["saved", "again"]);
		assert.deepEqual(opened.stores, [{ cwd: expected, closes: 1 }], expected);
	}
});

test("an unreadable session carries its cause, run and stage in the ForkSessionNotFoundError (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const sourceId = testRunId("session-context");
	await register(backend, sourceId);
	await commit(backend, [
		stage(sourceId, "stage:saved", "saved", "stage:saved:1", { output: "saved", sessionId: "lost" }),
	]);
	const failure = Object.assign(new Error("Session not found: lost"), { name: "SessionNotFoundError" });
	vi.spyOn(sessions, "load").mockRejectedValue(failure);
	const points = await (async () => {
		for await (const point of durableForkPoints(backend, sourceId, { sourceSessionStore: sessions })) return point;
	})().catch((problem: Error) => problem);
	assert.ok(points instanceof ForkSessionNotFoundError);
	assert.deepEqual(
		[points.sessionId, points.runId, points.stagePath, points.cause],
		["lost", sourceId, "saved", failure],
	);
	const fork = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
	}).catch((problem: Error) => problem);
	assert.ok(fork instanceof ForkSessionNotFoundError);
	assert.deepEqual([fork.sessionId, fork.runId, fork.stagePath, fork.cause], ["lost", sourceId, undefined, failure]);
});

test("copied checkpoints carry exactly the source's fields under the fork's identity (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const taskSession = session.getSessionId();
	const sourceId = testRunId("raw-checkpoints");
	const lookalike = {
		workflow: "w",
		runId: testRunId("raw-lookalike"),
		status: "completed",
		exited: false,
		outputs: {},
	};
	const topologyOnly = tool(sourceId, "tool:topology", {
		topology: { version: 1, nodeId: "n", ordinal: 1, order: 0, parentIds: [] },
	});
	const withRun = tool(sourceId, "tool:run", {
		topology: {
			version: 1,
			nodeId: "n2",
			ordinal: 2,
			order: 1,
			parentIds: [],
			run: { runId: sourceId, runName: "root", rootRunId: sourceId },
		},
	});
	const ghost = tool(sourceId, "tool:ghost", { output: { text: "t", sessionId: "ghost-session" } });
	const plain = stage(sourceId, "stage:plain", "plain", "stage:plain:1", { output: "plain" });
	const empty = stage(sourceId, "stage:null", "null", "stage:null:1", { output: null });
	const task = stage(sourceId, "stage:task", "task", "stage:task:1", {
		output: { text: "hello", sessionId: taskSession },
	});
	const noText = stage(sourceId, "stage:no-text", "no-text", "stage:no-text:1", {
		output: { sessionId: taskSession, extra: 1 },
	});
	const textOnly = stage(sourceId, "stage:text-only", "text-only", "stage:text-only:1", { output: { text: "just" } });
	const alike = stage(sourceId, "stage:alike", "alike", "stage:alike:1", { output: lookalike });
	await register(backend, sourceId);
	await commit(backend, [topologyOnly, withRun, ghost, plain, empty, task, noText, textOnly, alike]);
	const seeds = captureSeeds(backend);
	const create = vi.spyOn(sessions, "create");
	const fork = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
	});
	assert.equal(create.mock.calls.length, 1, "only the stage checkpoints name a session to copy");
	const copiedSession = create.mock.calls[0]![0].id;
	const forkId = fork.runId;
	assert.deepEqual(checkpointPayloads(seeds[0]!), [
		{ ...topologyOnly, workflowId: forkId },
		{
			...withRun,
			workflowId: forkId,
			topology: { ...withRun.topology, run: { runId: forkId, runName: "root", rootRunId: forkId } },
		},
		{ ...ghost, workflowId: forkId },
		{ ...plain, workflowId: forkId },
		{ ...empty, workflowId: forkId },
		{ ...task, workflowId: forkId, output: { text: "hello", sessionId: copiedSession } },
		{ ...noText, workflowId: forkId },
		{ ...textOnly, workflowId: forkId },
		{ ...alike, workflowId: forkId },
	]);
});

test("copied sessions keep the file of the store they were copied into, only where the source named one (#4321)", async () => {
	const root = mkdtempSync(join(tmpdir(), "fork-files-"));
	const sourceStore = await JsonlSessionStore.open(join(root, "source"), {
		exactDirectory: true,
		scanExisting: false,
	});
	const destination = await JsonlSessionStore.open(join(root, "destination"), {
		exactDirectory: true,
		scanExisting: false,
	});
	try {
		const backend = await createMemoryTestBackend();
		const session = await SessionManager.create(sourceStore, "/source");
		await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
		const sessionId = session.getSessionId();
		const sourceId = testRunId("raw-files");
		const named = stage(sourceId, "stage:named", "named", "stage:named:1", {
			output: "named",
			sessionId,
			sessionFile: "/old/named.jsonl",
		});
		const withFile = stage(sourceId, "stage:with-file", "with-file", "stage:with-file:1", {
			output: { text: "t", sessionId, sessionFile: "/old/with-file.jsonl" },
		});
		const withoutFile = stage(sourceId, "stage:without-file", "without-file", "stage:without-file:1", {
			output: { text: "t", sessionId },
		});
		await register(backend, sourceId);
		await commit(backend, [named, withFile, withoutFile]);
		const seeds = captureSeeds(backend);
		const create = vi.spyOn(destination, "create");
		const fork = await forkDurableRun(backend, {
			...request(sourceId),
			sessionStore: destination,
			sourceSessionStore: sourceStore,
		});
		const copiedId = create.mock.calls[0]![0].id;
		const copiedFile = (await SessionManager.open(destination, copiedId, "/source")).getSessionFile();
		assert.equal(typeof copiedFile, "string");
		assert.deepEqual(checkpointPayloads(seeds[0]!), [
			{ ...named, workflowId: fork.runId, sessionId: copiedId, sessionFile: copiedFile },
			{
				...withFile,
				workflowId: fork.runId,
				sessionFile: copiedFile,
				output: { text: "t", sessionId: copiedId, sessionFile: copiedFile },
			},
			{
				...withoutFile,
				workflowId: fork.runId,
				sessionFile: copiedFile,
				output: { text: "t", sessionId: copiedId },
			},
		]);
	} finally {
		await sourceStore.close();
		await destination.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a fork's handle and result carry only the fields that exist (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("raw-handle");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:s", "s", "stage:s:1", { output: "s" })]);
	const seeds = captureSeeds(backend);
	const whole = await forkDurableRun(backend, request(sourceId));
	const handle = handlePayload(seeds[0]!);
	for (const field of [
		"workflowCwd",
		"repositoryRoot",
		"gitWorktreeRoot",
		"modelOwner",
		"summary",
		"summarizedThrough",
		"sessionFile",
	])
		assert.equal(Object.hasOwn(handle, field), false, field);
	assert.deepEqual(handle.forkedFrom, { runId: sourceId });
	assert.deepEqual(handle.pendingStageMessages, []);
	assert.deepEqual(whole.forkedFrom, { runId: sourceId });
	const staged = await forkDurableRun(backend, { ...request(sourceId), fromStage: "s" });
	assert.deepEqual(handlePayload(seeds[1]!).forkedFrom, { runId: sourceId, stagePath: "s" });
	assert.deepEqual(staged.forkedFrom, { runId: sourceId, stagePath: "s" });
});

function pendingMessage(runId: string, id: string, extra: Partial<PendingStageMessage> = {}): PendingStageMessage {
	return {
		id,
		runId,
		stageKey: `workflow:${runId}/${id}`,
		targetPath: `workflow:${runId}/${id}`,
		from: { id: "sender", name: "sender" },
		message: { id: `${id}-message`, timestamp: 1, content: { text: id } },
		queuedAt: new Date(1).toISOString(),
		admissionOrder: 1,
		status: "queued",
		...extra,
	} as PendingStageMessage;
}

test("copied Intercom messages remap only identities of the source run and its copied sessions (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const sessionId = session.getSessionId();
	const sourceId = testRunId("raw-messages");
	const foreignRoot = "11111111-1111-4111-8111-111111111111";
	const deliveredAt = new Date(2).toISOString();
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:saved", "saved", "stage:saved:1", { output: "saved", sessionId })]);
	const mapped = pendingMessage(sourceId, "mapped", {
		deliveries: [{ runId: sourceId, stageId: "stage-id", sessionId, deliveredAt }],
	});
	const unsessioned = pendingMessage(sourceId, "unsessioned", {
		deliveries: [{ runId: sourceId, stageId: "stage-id", deliveredAt }],
	});
	const foreign = pendingMessage(sourceId, "foreign", {
		stageKey: "plain-stage",
		targetPath: `workflow:${foreignRoot}/stage`,
	});
	const archived = pendingMessage(sourceId, "archived");
	await backend.persistPendingStageMessages(sourceId, [mapped, unsessioned, foreign, archived]);
	await backend.archivePendingStageMessage(sourceId, { ...archived, status: "delivered" });
	const held = await backend.journal.leaseState(sourceId);
	const keyless = pendingMessage(sourceId, "keyless");
	await backend.journal.append({ runId: sourceId, holderId: backend.holderId, epoch: held!.epoch }, {
		type: "MessageSettled",
		payload: { message: keyless },
	} as never);
	const seeds = captureSeeds(backend);
	const create = vi.spyOn(sessions, "create");
	const fork = await forkDurableRun(backend, {
		...request(sourceId),
		carryMessages: "all",
		sessionStore: sessions,
		sourceSessionStore: sessions,
	});
	const copiedSession = create.mock.calls[0]![0].id;
	const forkId = fork.runId;
	const byId = (id: string) => handlePayload(seeds[0]!).pendingStageMessages!.find((message) => message.id === id);
	assert.deepEqual(byId("mapped"), {
		...mapped,
		runId: forkId,
		stageKey: `workflow:${forkId}/mapped`,
		targetPath: `workflow:${forkId}/mapped`,
		deliveries: [{ runId: forkId, stageId: "stage-id", sessionId: copiedSession, deliveredAt }],
	});
	assert.deepEqual(byId("unsessioned"), {
		...unsessioned,
		runId: forkId,
		stageKey: `workflow:${forkId}/unsessioned`,
		targetPath: `workflow:${forkId}/unsessioned`,
		deliveries: [{ runId: forkId, stageId: "stage-id", deliveredAt }],
	});
	assert.deepEqual(byId("foreign"), { ...foreign, runId: forkId });
	const settled = seeds[0]!.filter((seed) => seed.event.type === "MessageSettled");
	const keylessSeed = settled.find(
		(seed) => (seed.event.payload as unknown as { message: PendingStageMessage }).message.id === "keyless",
	);
	assert.ok(keylessSeed !== undefined);
	assert.equal(Object.hasOwn(keylessSeed, "key"), false);
	const keyed = settled.filter((seed) => seed !== keylessSeed);
	assert.equal(keyed.length, 1);
	assert.equal(keyed[0]!.key, JSON.stringify(["MessageSettled", forkId, "archived"]));
});

test("a failed journal copy attaches a failed session cleanup to its error and nothing otherwise (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "x", timestamp: 1 });
	const sourceId = testRunId("cleanup-journal");
	await register(backend, sourceId);
	await commit(backend, [
		stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x", sessionId: session.getSessionId() }),
	]);
	const options = { ...request(sourceId), sessionStore: sessions, sourceSessionStore: sessions };
	const failure = new Error("disk full");
	vi.spyOn(backend.journal, "createRunWithEvents").mockRejectedValue(failure);
	const clean = await forkDurableRun(backend, options).catch((problem: Error) => problem);
	assert.ok(clean instanceof ForkCopyFailedError);
	assert.equal(Object.hasOwn(clean, "cleanupCause"), false);
	const deleteFailure = new Error("delete failed");
	vi.spyOn(sessions, "delete").mockRejectedValue(deleteFailure);
	const dirty = await forkDurableRun(backend, options).catch((problem: Error) => problem);
	assert.ok(dirty instanceof ForkCopyFailedError);
	assert.ok(dirty.cleanupCause instanceof ForkCleanupError);
	assert.deepEqual(
		[dirty.cleanupCause.step, dirty.cleanupCause.forkRunId, dirty.cleanupCause.cause],
		["remove-copied-sessions", dirty.forkRunId, deleteFailure],
	);
	const sessionsFailed = vi.spyOn(sessions, "create").mockRejectedValue(failure);
	const noCleanup = await forkDurableRun(backend, options).catch((problem: Error) => problem);
	assert.ok(noCleanup instanceof ForkCopyFailedError);
	assert.equal(noCleanup.phase, "sessions");
	assert.equal(
		Object.hasOwn(noCleanup, "cleanupCause"),
		false,
		"no session was created, so nothing failed to be removed",
	);
	sessionsFailed.mockRestore();
});

test("an abort after the sessions were copied rejects with its reason and logs a failed removal of the copies once (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "x", timestamp: 1 });
	const sourceId = testRunId("cleanup-abort");
	await register(backend, sourceId);
	await commit(backend, [
		stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x", sessionId: session.getSessionId() }),
	]);
	const controller = new AbortController();
	const reason = new Error("stop");
	const create = sessions.create.bind(sessions);
	vi.spyOn(sessions, "create").mockImplementation(async (header, entries) => {
		const result = await create(header, entries);
		controller.abort(reason);
		return result;
	});
	const deleteFailure = new Error("delete failed");
	const removal = vi.spyOn(sessions, "delete").mockRejectedValue(deleteFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const error = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
		signal: controller.signal,
	}).catch((problem: Error) => problem);
	assert.equal(error, reason);
	assert.equal(removal.mock.calls.length, 1);
	assert.equal((await backend.journal.listRuns()).length, 1);
	assert.equal(warn.mock.calls.length, 1);
	const [warned, ...extra] = warn.mock.calls[0]!;
	assert.ok(warned instanceof ForkCleanupError);
	assert.deepEqual(
		[warned.step, warned.runId, warned.cause, extra],
		["remove-copied-sessions", sourceId, deleteFailure, []],
	);
});

test("a session copy that fails while the signal is aborted is a ForkCopyFailedError unless it is the signal's reason (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "x", timestamp: 1 });
	const sourceId = testRunId("copy-abort-failure");
	await register(backend, sourceId);
	await commit(backend, [
		stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x", sessionId: session.getSessionId() }),
	]);
	const controller = new AbortController();
	const failure = new Error("store full");
	vi.spyOn(sessions, "create").mockImplementation(async () => {
		controller.abort(new Error("stop"));
		throw failure;
	});
	const error = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
		signal: controller.signal,
	}).catch((problem: Error) => problem);
	assert.ok(error instanceof ForkCopyFailedError);
	assert.deepEqual([error.phase, error.cause], ["sessions", failure]);
});

test("a claim release that fails after an abort is logged once and the abort reason is still thrown (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("release-after-abort");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x" })]);
	await backend.releaseWorkflow(sourceId);
	const releaseFailure = new Error("release failed");
	const release = vi.spyOn(backend.journal, "release").mockRejectedValue(releaseFailure);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const reason = new Error("caller cancelled");
	const controller = new AbortController();
	const read = backend.journal.read.bind(backend.journal);
	let reads = 0;
	vi.spyOn(backend.journal, "read").mockImplementation((id, fromSeq) => {
		if (++reads === 2) controller.abort(reason);
		return read(id, fromSeq);
	});
	const error = await forkDurableRun(backend, { ...request(sourceId), signal: controller.signal }).catch(
		(problem: Error) => problem,
	);
	assert.equal(error, reason);
	assert.equal(release.mock.calls.length, 1);
	assert.equal(warn.mock.calls.length, 1);
	const [warned, ...extra] = warn.mock.calls[0]!;
	assert.ok(warned instanceof ForkClaimReleaseError);
	assert.deepEqual([warned.runId, warned.cause, extra], [sourceId, releaseFailure, []]);
});

test("forkDurableRun validates every option itself before reading the journal (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("validate-options");
	await register(backend, sourceId);
	const read = vi.spyOn(backend.journal, "getRun");
	const invalid = await forkDurableRun(backend, {
		...request(sourceId),
		runId: "",
		carryMessages: "later" as never,
	}).catch((problem: Error) => problem);
	assert.ok(invalid instanceof ForkConfigError);
	assert.deepEqual(
		invalid.issues.map((issue) => issue.field),
		["runId", "carryMessages"],
	);
	const numeric = await forkDurableRun(backend, { ...request(sourceId), cwd: 7 as never }).catch(
		(problem: Error) => problem,
	);
	assert.ok(numeric instanceof ForkConfigError);
	assert.deepEqual([numeric.field, numeric.expected], ["cwd", "a directory path"]);
	assert.equal(read.mock.calls.length, 0);
});

test("a session shared by several checkpoints is read once and copied under the checkpoint that has a topology (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sessions = new MemorySessionStore();
	const session = await SessionManager.create(sessions, "/source");
	await session.appendMessage({ role: "user", content: "x", timestamp: 1 });
	const sessionId = session.getSessionId();
	const topology = (stageId: string) => ({ version: 1 as const, stageId, parentIds: [] });
	const headers: { workflow?: { stageId: string; stageName: string } }[] = [];
	for (const [label, first, second] of [
		[
			"keeps",
			stage("", "first", "first", "stage:first:1", { sessionId, topology: topology("first-id") }),
			stage("", "second", "second", "stage:second:1", { sessionId }),
		],
		[
			"replaces",
			stage("", "first", "first", "stage:first:1", { sessionId }),
			stage("", "second", "second", "stage:second:1", { sessionId, topology: topology("second-id") }),
		],
	] as const) {
		const sourceId = testRunId(`shared-session-${label}`);
		await register(backend, sourceId);
		await commit(backend, [
			{ ...first, workflowId: sourceId },
			{ ...second, workflowId: sourceId },
		]);
		const load = vi.spyOn(sessions, "load");
		const create = vi.spyOn(sessions, "create");
		const fork = await forkDurableRun(backend, {
			...request(sourceId),
			sessionStore: sessions,
			sourceSessionStore: sessions,
		});
		assert.equal(load.mock.calls.filter(([id]) => id === sessionId).length, 1, label);
		assert.equal(create.mock.calls.length, 1, label);
		headers.push(create.mock.calls[0]![0] as (typeof headers)[number]);
		assert.equal(create.mock.calls[0]![0].workflow?.runId, fork.runId);
		load.mockRestore();
		create.mockRestore();
	}
	assert.deepEqual(
		headers.map((header) => header.workflow && [header.workflow.stageId, header.workflow.stageName]),
		[
			["first-id", "first"],
			["second-id", "second"],
		],
	);
});

test("a source whose handle records no pending Intercom messages forks into a handle with an empty list (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("raw-no-pending");
	const handle = {
		workflowId: sourceId,
		name: definition.name,
		inputs: {},
		status: "paused",
		createdAt: 1,
		updatedAt: 1,
		invocationCwd: "/source",
		resumable: true,
		completedCheckpoints: 0,
		pendingPrompts: 0,
	};
	await backend.journal.createRunWithEvents(
		{ runId: sourceId, name: definition.name, cwd: "/source", createdAt: 1, status: "paused" },
		[{ event: { type: "RunStarted", payload: handle as never } }],
	);
	const seeds = captureSeeds(backend);
	await forkDurableRun(backend, request(sourceId));
	assert.deepEqual(handlePayload(seeds[0]!).pendingStageMessages, []);
});

test("a fork in progress holds its source against a second fork until it finishes (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const sourceId = testRunId("claim-held");
	await register(backend, sourceId);
	await commit(backend, [stage(sourceId, "stage:x", "x", "stage:x:1", { output: "x" })]);
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const first = forkDurableRun(backend, {
		source: "sdk",
		runId: sourceId,
		carryMessages: "before",
		resolveDefinition: async () => {
			entered();
			await gate;
			return definition;
		},
	});
	await started;
	assert.equal(claimsOf(pendingForks, backend).has(sourceId), true);
	const second = await forkDurableRun(backend, request(sourceId)).catch((problem: Error) => problem);
	assert.ok(second instanceof ForkSourceBusyError);
	assert.equal(second.reason, "fork-in-progress");
	open();
	await first;
	assert.equal(claimsOf(pendingForks, backend).has(sourceId), false);
});

test("a fork of a run with an input worktree copies its sessions into the store a later fork reads, across two generations (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const invocationStore = new MemorySessionStore();
	const worktreeStore = new MemorySessionStore();
	opened.byCwd.set("/source", invocationStore);
	opened.byCwd.set("/source/worktree", worktreeStore);
	opened.byCwd.set("/elsewhere", new MemorySessionStore());
	const session = await SessionManager.create(worktreeStore, "/source/worktree");
	await session.appendMessage({ role: "user", content: "saved", timestamp: 1 });
	const sourceId = testRunId("worktree-generations");
	await register(backend, sourceId, { workflowCwd: "/source/worktree" });
	await commit(backend, [
		stage(sourceId, "stage:saved", "saved", "stage:saved:1", { output: "saved", sessionId: session.getSessionId() }),
	]);
	const sessionIds = async (store: MemorySessionStore) => {
		const ids: string[] = [];
		for await (const summary of store.list({ includeInternal: true })) ids.push(summary.id);
		return ids;
	};

	const first = await forkDurableRun(backend, request(sourceId));
	assert.equal(backend.getWorkflow(first.runId)?.workflowCwd, "/source/worktree", "the worktree is kept");
	assert.equal((await sessionIds(worktreeStore)).length, 2, "the copy is in the store the worktree selects");
	assert.deepEqual(await sessionIds(invocationStore), [], "not in the invocation directory's store");

	const second = await forkDurableRun(backend, request(first.runId));
	assert.equal(backend.getWorkflow(second.runId)?.workflowCwd, "/source/worktree");
	assert.equal((await sessionIds(worktreeStore)).length, 3, "the second generation found and copied the session");
	assert.deepEqual(await sessionIds(invocationStore), []);

	const elsewhere = await forkDurableRun(backend, { ...request(sourceId), cwd: "/elsewhere" });
	assert.equal(backend.getWorkflow(elsewhere.runId)?.workflowCwd, undefined, "a fork in another directory drops it");
	assert.deepEqual(opened.stores.at(-2)?.cwd, "/source/worktree", "its sessions are read from the worktree's store");
	assert.equal(opened.stores.at(-1)?.cwd, "/elsewhere", "and written to the new directory's own store");
});

test("graph stage forkTarget and fork succeed after module reload re-evaluates JournalDurableBackend (#5245)", async () => {
	const backend = await createMemoryTestBackend();
	const store = createStore();
	const sourceId = testRunId("fork-after-reload");
	let failSecond = true;
	const leasedDuringResume: boolean[] = [];
	const buildDefinition = (defineWorkflow: typeof workflow) =>
		defineWorkflow({
			name: "fork-after-reload",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				const runId = ctx.runId;
				assert.ok(runId);
				if (runId !== sourceId) leasedDuringResume.push(backend.hasWorkflowExecution(runId));
				await ctx.stage("plan").prompt("plan");
				await ctx.stage("explode").prompt("explode");
				return {};
			},
		});
	const adapters = {
		prompt: {
			prompt: async (text: string) => {
				if (text === "explode" && failSecond) throw new Error("boom");
				return text;
			},
		},
	};
	const initialResult = await run(
		buildDefinition(workflow),
		{},
		{
			runId: sourceId,
			store,
			durableBackend: backend,
			adapters,
			cwd: process.cwd(),
		},
	);
	assert.equal(initialResult.status, "failed");
	const stages = store.run(sourceId)!.stages;
	const completedStage = stages.find((entry) => entry.name === "plan")!;
	const failedStage = stages.find((entry) => entry.name === "explode")!;
	assert.equal(completedStage.status, "completed");
	assert.equal(failedStage.status, "failed");

	const { JournalDurableBackend: InitialJournalDurableBackend } = await import(
		"../../packages/workflows/src/durable/journal/journal-backend.js"
	);
	vi.resetModules();
	const [
		{ JournalDurableBackend: ReloadedJournalDurableBackend, isJournalDurableBackend },
		{ workflow: reloadedWorkflow },
		{ createExtensionRuntime: createReloadedRuntime },
		{ createGraphStageActions: createReloadedActions },
		{ captureWorkflowOwnerResources: captureReloadedOwner },
		{ createJobTracker: createReloadedJobTracker },
		{ durableForkTarget: reloadedDurableForkTarget, forkDurableRun: reloadedForkDurableRun },
		{ isForkJournalUnsupportedError },
	] = await Promise.all([
		import("../../packages/workflows/src/durable/journal/journal-backend.js"),
		import("../../packages/workflows/src/authoring/workflow.js"),
		import("../../packages/workflows/src/extension/runtime.js"),
		import("../../packages/workflows/src/extension/workflow-graph-stage-actions.js"),
		import("../../packages/workflows/src/extension/workflow-owner-resources.js"),
		import("../../packages/workflows/src/runs/background/job-tracker.js"),
		import("../../packages/workflows/src/durable/fork-run.js"),
		import("../../packages/workflows/src/durable/fork-errors.js"),
	]);
	assert.notEqual(ReloadedJournalDurableBackend, InitialJournalDurableBackend);

	failSecond = false;
	const reloadedDef = buildDefinition(reloadedWorkflow);
	const jobs = createReloadedJobTracker();
	const runtime = createReloadedRuntime({
		definitions: [reloadedDef],
		store,
		jobs,
		adapters,
		cwd: process.cwd(),
	});
	const actions = createReloadedActions({
		owner: { ...captureReloadedOwner(), store, jobs },
		runtime: () => runtime,
		context: () => ({ hasUI: true }),
	});

	const completedTarget = await actions.forkTarget!(sourceId, completedStage.id);
	assert.deepEqual(completedTarget, { ok: true, stagePath: "plan", rerunToolSteps: 0, live: false });
	const failedTarget = await actions.forkTarget!(sourceId, failedStage.id);
	assert.deepEqual(failedTarget, { ok: true, stagePath: "explode", rerunToolSteps: 0, live: false });
	assert.equal(isJournalDurableBackend?.(backend), true);

	const forkedCompleted = await actions.fork!(sourceId, completedStage.id);
	assert.equal(forkedCompleted.ok, true, forkedCompleted.message);
	assert.ok(forkedCompleted.runId);
	await jobs.get(forkedCompleted.runId)?.promise;
	assert.equal(backend.getWorkflow(forkedCompleted.runId)?.status, "completed");
	assert.equal(backend.getWorkflow(forkedCompleted.runId)?.forkedFrom?.stagePath, "plan");

	const forkedFailed = await actions.fork!(sourceId, failedStage.id);
	assert.equal(forkedFailed.ok, true, forkedFailed.message);
	assert.ok(forkedFailed.runId);
	await jobs.get(forkedFailed.runId)?.promise;
	assert.equal(backend.getWorkflow(forkedFailed.runId)?.status, "completed");
	assert.equal(backend.getWorkflow(forkedFailed.runId)?.forkedFrom?.stagePath, "explode");
	assert.equal(leasedDuringResume.length >= 2, true);

	const fakeBackend = {
		getWorkflow: backend.getWorkflow.bind(backend),
		journal: backend.journal,
	} as unknown as typeof backend;
	assert.equal(fakeBackend instanceof ReloadedJournalDurableBackend, false);
	assert.equal(isJournalDurableBackend?.(fakeBackend), false);
	const fakeError = await reloadedDurableForkTarget(fakeBackend, sourceId, completedStage.id).catch(
		(failure: Error) => failure,
	);
	assert.equal(isForkJournalUnsupportedError(fakeError), true);

	const nonAtomicBackend = await createMemoryTestBackend();
	Object.defineProperty(nonAtomicBackend.journal, "createRunWithEvents", { value: undefined });
	const readSpy = vi.spyOn(nonAtomicBackend.journal, "getRun");
	const nonAtomicError = await reloadedForkDurableRun(nonAtomicBackend, {
		source: "cli",
		runId: sourceId,
		carryMessages: "before",
		definition: reloadedDef,
	}).catch((failure: Error) => failure);
	assert.equal(isForkJournalUnsupportedError(nonAtomicError), true);
	assert.equal(readSpy.mock.calls.length, 0);
});
