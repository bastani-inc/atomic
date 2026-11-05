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
	ForkConfigError,
	ForkCopyFailedError,
	ForkSessionNotFoundError,
	ForkSourceBusyError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { durableForkPoints, forkDurableRun } from "../../packages/workflows/src/durable/fork-run.js";
import type { RunJournalSeedEvent } from "../../packages/workflows/src/durable/journal/types.js";
import { claimsOf, pendingForks } from "../../packages/workflows/src/durable/run-claims.js";
import type {
	DurableCheckpoint,
	DurableStageCheckpoint,
	DurableToolCheckpoint,
	DurableWorkflowHandle,
} from "../../packages/workflows/src/durable/types.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import {
	closeMemoryTestBackends,
	createMemoryTestBackend,
	type MemoryJournalBackend,
} from "../helpers/workflow-journal.js";

const opened = vi.hoisted(() => ({
	store: undefined as SessionStore | undefined,
	stores: [] as { cwd: string | undefined; closes: number }[],
}));

vi.mock("../../packages/workflows/src/shared/stage-session-store.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../packages/workflows/src/shared/stage-session-store.js")>();
	return {
		...original,
		stageSessionStore: async (options: { cwd?: string }) => {
			const entry = { cwd: options.cwd, closes: 0 };
			opened.stores.push(entry);
			return new Proxy(opened.store!, {
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
	const failure = new Error("store offline");
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
	assert.equal(dirty.cleanupCause, deleteFailure);
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

test("an abort after the sessions were copied rejects with its reason even when removing the copies fails (#4321)", async () => {
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
	const removal = vi.spyOn(sessions, "delete").mockRejectedValue(new Error("delete failed"));
	const error = await forkDurableRun(backend, {
		...request(sourceId),
		sessionStore: sessions,
		sourceSessionStore: sessions,
		signal: controller.signal,
	}).catch((problem: Error) => problem);
	assert.equal(error, reason);
	assert.equal(removal.mock.calls.length, 1);
	assert.equal((await backend.journal.listRuns()).length, 1);
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
	const [warned, cleanup] = warn.mock.calls[0]!;
	assert.ok(warned instanceof ForkSourceBusyError);
	assert.deepEqual([warned.runId, warned.reason, cleanup], [sourceId, "fork-in-progress", releaseFailure]);
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
