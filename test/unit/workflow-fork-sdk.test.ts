import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@bastani/atomic";
import { afterAll, afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { isForkConfigError, isForkSourceBusyError } from "../../packages/workflows/src/durable/fork-errors.js";
import { hasActiveLiveRun } from "../../packages/workflows/src/durable/run-claims.js";
import {
	forkRun,
	listForkPoints,
	type WorkflowRunEvent,
} from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { hostWorkerBindings } from "../../packages/workflows/src/workers/host-options.js";
import {
	isLocalWorkerOptionsError,
	LocalWorkerOptionsError,
} from "../../packages/workflows/src/workers/local-worker-pool-errors.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { cleanupDiscoveryTempDirs, makeTempDir, writeWorkflowJs } from "./discovery-helpers.js";
import { type AgentSessionAdapter, makeMockSession } from "./stage-runner-helpers.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-run.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/runs/foreground/sdk-run.js")>();
	return { ...actual, run: vi.fn(actual.run) };
});

afterEach(async () => {
	setDurableBackend(undefined);
	await closeMemoryTestBackends();
});

afterAll(cleanupDiscoveryTempDirs);

const complete = { complete: { complete: async (text: string) => text } };

const emittingSessions: AgentSessionAdapter = {
	async create() {
		const mock = makeMockSession({
			async prompt() {
				mock.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
			},
			getLastAssistantText: () => "done",
		});
		return mock.session;
	},
};

const adapters = { complete: complete.complete, agentSession: emittingSessions };

const eventsDefinition = workflow({
	name: "fork-sdk-events",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("plan").complete("plan");
		await ctx.stage("worker").prompt("go");
		return {};
	},
});

async function eventsSource(seed: string) {
	const backend = await createMemoryTestBackend();
	const runId = testRunId(seed);
	const result = await run(eventsDefinition, {}, { runId, durableBackend: backend, store: createStore(), adapters });
	assert.equal(result.status, "completed", result.error);
	return { backend, runId, stageIds: result.stages.map((stage) => stage.id) };
}

async function collect(events: AsyncIterable<WorkflowRunEvent>): Promise<WorkflowRunEvent[]> {
	const collected: WorkflowRunEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

function runSnapshot(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: "live", inputs: {}, status: "running", toolNodes: [], stages: [], startedAt: 1, ...overrides };
}

test("hasActiveLiveRun is false without a store and for ended, quit or unknown runs, and true for an executing run (#4321)", () => {
	const store = createStore();
	store.recordRunStart(runSnapshot("executing"));
	store.recordRunStart(runSnapshot("ended", { status: "completed", endedAt: 2 }));
	store.recordRunStart(runSnapshot("quit", { exitReason: "quit" }));
	assert.equal(hasActiveLiveRun(undefined, "executing"), false);
	assert.equal(hasActiveLiveRun(store, "executing"), true);
	assert.equal(hasActiveLiveRun(store, "ended"), false);
	assert.equal(hasActiveLiveRun(store, "quit"), false);
	assert.equal(hasActiveLiveRun(store, "unknown"), false);
});

test("forkRun refuses a source that is live in the store option or, by default, in the current workflow store (#4321)", async () => {
	const { backend, runId } = await eventsSource("fork-sdk-live");
	const request = { fromStage: "worker", durableBackend: backend, definition: eventsDefinition, adapters };
	const expectBusy = async (options: Parameters<typeof forkRun>[1]) => {
		const error = await forkRun(runId, { ...request, ...options }).then(
			() => assert.fail("fork must fail"),
			(failure: Error) => failure,
		);
		assert.ok(isForkSourceBusyError(error), String(error));
		assert.equal(error.reason, "live-execution");
	};
	const live = createStore();
	live.recordRunStart(runSnapshot(runId));
	await expectBusy({ store: live });
	const current = currentWorkflowStore();
	current.recordRunStart(runSnapshot(runId));
	try {
		await expectBusy({});
	} finally {
		current.removeRun(runId);
	}
	assert.equal((await backend.journal.listRuns()).length, 1);
});

test("forkRun and listForkPoints read the journal option instead of a preset backend (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const definition = workflow({
		name: "fork-sdk-journal",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("plan").complete("plan");
			await ctx.stage("ship").complete("ship");
			return {};
		},
	});
	const runId = testRunId("fork-sdk-journal");
	await run(definition, {}, { runId, durableBackend: backend, store: createStore(), adapters });
	const elsewhere = await createMemoryTestBackend();
	const points = [];
	for await (const point of listForkPoints(runId, { journal: backend.journal, durableBackend: elsewhere }))
		points.push(point.stagePath);
	assert.deepEqual(points, ["plan", "ship"]);
	const forked = await forkRun(runId, {
		fromStage: "ship",
		journal: backend.journal,
		durableBackend: elsewhere,
		definition,
		store: createStore(),
		adapters,
	});
	assert.equal((await forked.result).status, "completed");
	assert.equal((await backend.journal.getRun(forked.runId))?.runId, forked.runId);
	assert.equal(await elsewhere.journal.getRun(forked.runId), undefined);
});

test("forkRun resolves the definition from the registry option, then from the source's project directory (#4321)", async () => {
	const { backend, runId } = await eventsSource("fork-sdk-registry");
	const registered = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		registry: createRegistry().register(eventsDefinition),
		store: createStore(),
		adapters,
	});
	assert.equal((await registered.result).status, "completed");

	const directory = makeTempDir("fork-sdk-discovery");
	mkdirSync(join(directory, ".atomic", "workflows"), { recursive: true });
	writeWorkflowJs(join(directory, ".atomic", "workflows"), "wf.js", "fork discovered", "fork-discovered");
	const discoveredId = testRunId("fork-sdk-discovered");
	await backend.commitWorkflowRegistration({
		workflowId: discoveredId,
		name: "fork-discovered",
		inputs: {},
		status: "completed",
		createdAt: 1,
		invocationCwd: directory,
	});
	const discovered = await forkRun(discoveredId, {
		durableBackend: backend,
		store: createStore(),
		adapters: { agentSession: { create: async () => makeMockSession({ prompt: async () => "done" }).session } },
	});
	assert.equal((await discovered.result).status, "completed");
	assert.equal(backend.getWorkflow(discovered.runId)?.invocationCwd, directory);
});

test("forkRun events carry stage session events to the iterator and the caller's callback (#4321)", async () => {
	const { backend, runId } = await eventsSource("fork-sdk-session-events");
	const callbacks: Array<{ runId: string; stageId: string; type: string }> = [];
	const forked = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		definition: eventsDefinition,
		store: createStore(),
		adapters,
		onStageSessionEvent: (id, stageId, event) => callbacks.push({ runId: id, stageId, type: event.type }),
	});
	const events = await collect(forked.events);
	const result = await forked.result;
	const sessionEvents = events.filter((event) => event.type === "stage_session_event");
	assert.ok(sessionEvents.length > 0);
	const worker = result.stages.find((stage) => stage.name === "worker")!;
	for (const event of sessionEvents) {
		assert.equal(event.type, "stage_session_event");
		assert.equal(event.runId, forked.runId);
		assert.equal(event.stageId, worker.id);
	}
	assert.deepEqual(
		sessionEvents.map((event) => (event.type === "stage_session_event" ? event.event.type : undefined)),
		callbacks.map((callback) => callback.type),
	);
	assert.ok(callbacks.every((callback) => callback.runId === forked.runId && callback.stageId === worker.id));
	const withoutCallback = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		definition: eventsDefinition,
		store: createStore(),
		adapters,
	});
	const forwarded = await collect(withoutCallback.events);
	assert.ok(forwarded.some((event) => event.type === "stage_session_event"));
});

test("a fork nobody reads keeps no stage session events while the caller's own callback still gets every one (#4321)", async () => {
	const { backend, runId } = await eventsSource("fork-sdk-unread-events");
	const emitted = 2000;
	const chattySessions: AgentSessionAdapter = {
		async create() {
			const mock = makeMockSession({
				async prompt() {
					for (let index = 0; index < emitted; index++)
						mock.emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "read", args: {} });
				},
				getLastAssistantText: () => "done",
			});
			return mock.session;
		},
	};
	let received = 0;
	const forked = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		definition: eventsDefinition,
		store: createStore(),
		adapters: { complete: complete.complete, agentSession: chattySessions },
		onStageSessionEvent: () => {
			received++;
		},
	});
	assert.equal((await forked.result).status, "completed");
	assert.equal(received, emitted);
	const late = await collect(forked.events);
	assert.deepEqual(
		late.map((event) => event.type),
		["run_start", "stage_start", "stage_end", "run_end"],
		"only lifecycle events wait for a reader",
	);
});

test("a pooled fork refuses options bound to this process before writing, and installs no stage callbacks (#4321)", async () => {
	const { backend, runId } = await eventsSource("fork-sdk-pooled");
	const localWorkers = { count: 1, definitions: [] };
	const refused = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		definition: eventsDefinition,
		localWorkers,
		registry: createRegistry(),
		onStageEnd: () => undefined,
	}).catch((error: Error) => error);
	assert.ok(isForkConfigError(refused), String(refused));
	assert.deepEqual(refused.issues, [
		{ field: "localWorkers", expected: "localWorkers without options bound to this process (registry, onStageEnd)" },
	]);
	assert.equal((await backend.journal.listRuns()).length, 1, "nothing was written");
	const everyBound = [
		"adapters",
		"persistence",
		"mcp",
		"overlay",
		"models",
		"registry",
		"toolAdmissionBoundary",
		"onStageStart",
		"onStageEnd",
		"onStageSession",
		"onStageSessionEvent",
		"confirmStageReadiness",
		"rootBudget",
	];
	const everyBoundOption = Object.fromEntries(everyBound.map((key) => [key, {}]));
	const allRefused = await forkRun(
		runId,
		Object.assign(
			{ fromStage: "worker", durableBackend: backend, definition: eventsDefinition, localWorkers },
			everyBoundOption,
		),
	).catch((error: Error) => error);
	assert.ok(isForkConfigError(allRefused), String(allRefused));
	assert.equal(allRefused.expected, `localWorkers without options bound to this process (${everyBound.join(", ")})`);
	let captured: Parameters<typeof run>[2];
	vi.mocked(run).mockImplementationOnce(async (_definition, _inputs, options) => {
		captured = options;
		return { status: "completed", stages: [] } as never;
	});
	const pooled = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		definition: eventsDefinition,
		localWorkers,
	});
	await pooled.result;
	assert.deepEqual(captured?.localWorkers, localWorkers);
	assert.equal(typeof captured?.onRunStart, "function");
	assert.equal(typeof captured?.onRunEnd, "function");
	assert.deepEqual(
		[captured?.onStageStart, captured?.onStageEnd, captured?.onStageSessionEvent],
		[undefined, undefined, undefined],
	);
	vi.mocked(run).mockImplementationOnce(async (_definition, _inputs, options) => {
		captured = options;
		return { status: "completed", stages: [] } as never;
	});
	const hosted = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		definition: eventsDefinition,
		localWorkers,
		registry: createRegistry(),
		[hostWorkerBindings]: true,
	});
	await hosted.result;
	assert.equal(typeof captured?.onStageStart, "function", "a host that binds its workers keeps the stage events");
});

test("forkRun rejects invalid worker timing before reading or writing its source (#4321)", async () => {
	for (const options of [{ heartbeatMs: 0 }, { leaseMs: 1 }, { leaseMs: 2_000, heartbeatMs: 1_001 }]) {
		const backend = await createMemoryTestBackend();
		const runId = testRunId(`fork-invalid-timing-${JSON.stringify(options)}`);
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: eventsDefinition.name,
			inputs: {},
			status: "completed",
			createdAt: 1,
		});
		const read = vi.spyOn(backend.journal, "getRun");
		const write = vi.spyOn(backend.journal, "createRunWithEvents");
		const error = await forkRun(runId, {
			durableBackend: backend,
			definition: eventsDefinition,
			localWorkers: { count: 2, definitions: [], ...options },
		}).then(
			async (forked) => {
				await forked.result.catch(() => undefined);
				return forked;
			},
			(failure: Error) => failure,
		);
		assert.ok(error instanceof LocalWorkerOptionsError);
		assert.ok(isLocalWorkerOptionsError(error));
		const option = options.leaseMs === 1 ? "leaseMs" : "heartbeatMs";
		assert.equal(error.code, option === "leaseMs" ? "invalid-lease" : "invalid-heartbeat");
		assert.equal(error.source, "sdk");
		assert.equal(error.field, `localWorkers.${option}`);
		assert.equal(error.retryable, false);
		assert.ok(error.hint.includes(`Set localWorkers.${option}`));
		assert.equal(read.mock.calls.length, 0);
		assert.equal(write.mock.calls.length, 0);
		vi.restoreAllMocks();
	}
});

test("forkRun validates inherited worker timing before copying and accepts a valid explicit override (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const runId = testRunId("fork-invalid-saved-timing");
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: eventsDefinition.name,
		inputs: {},
		status: "completed",
		createdAt: 1,
		resources: { localWorkers: { count: 2, definitions: [], heartbeatMs: 0 }, definitions: [] },
	});
	const write = vi.spyOn(backend.journal, "createRunWithEvents");
	const request = { durableBackend: backend, definition: eventsDefinition };
	const error = await forkRun(runId, request).then(
		async (forked) => {
			await forked.result.catch(() => undefined);
			return forked;
		},
		(failure: Error) => failure,
	);
	assert.ok(error instanceof LocalWorkerOptionsError);
	assert.ok(isLocalWorkerOptionsError(error));
	assert.equal(error.code, "invalid-heartbeat");
	assert.equal(error.field, "localWorkers.heartbeatMs");
	assert.equal(error.source, "sdk");
	assert.equal(error.retryable, false);
	assert.equal(write.mock.calls.length, 0);
	assert.equal((await backend.journal.listRuns()).length, 1);
	const localWorkers = { count: 2, definitions: [], leaseMs: 4_000, heartbeatMs: 1_000 };
	vi.mocked(run).mockImplementationOnce(async () => ({ status: "completed", stages: [] }) as never);
	const forked = await forkRun(runId, { ...request, localWorkers });
	assert.equal((await forked.result).status, "completed");
	assert.equal(write.mock.calls.length, 1);
});

test("a fork of a source that saved local workers is pooled: it refuses process-bound options before writing and installs no stage callbacks (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const savedId = testRunId("fork-sdk-saved-workers");
	await backend.commitWorkflowRegistration({
		workflowId: savedId,
		name: eventsDefinition.name,
		inputs: {},
		status: "completed",
		createdAt: 1,
		resources: { localWorkers: { count: 2, definitions: [] }, definitions: [] },
	});
	const request = { durableBackend: backend, definition: eventsDefinition };
	const refused = await forkRun(savedId, {
		...request,
		registry: createRegistry(),
		onStageEnd: () => undefined,
	}).catch((error: Error) => error);
	assert.ok(isForkConfigError(refused), String(refused));
	assert.equal(refused.code, "invalid-option");
	assert.equal(refused.source, "sdk");
	assert.equal(refused.field, "localWorkers");
	assert.deepEqual(refused.issues, [
		{ field: "localWorkers", expected: "localWorkers without options bound to this process (registry, onStageEnd)" },
	]);
	assert.equal((await backend.journal.listRuns()).length, 1, "nothing was written");

	let captured: Parameters<typeof run>[2];
	vi.mocked(run).mockImplementationOnce(async (_definition, _inputs, options) => {
		captured = options;
		return { status: "completed", stages: [] } as never;
	});
	const pooled = await forkRun(savedId, request);
	await pooled.result;
	assert.equal(captured?.localWorkers, undefined, "the saved workers are restored by run(), not passed again");
	assert.equal(typeof captured?.onRunStart, "function");
	assert.equal(typeof captured?.onRunEnd, "function");
	assert.deepEqual(
		[captured?.onStageStart, captured?.onStageEnd, captured?.onStageSessionEvent],
		[undefined, undefined, undefined],
		"a pooled fork installs no stage callbacks",
	);
	assert.equal((await backend.journal.listRuns()).length, 2, "the allowed fork was written once");

	vi.mocked(run).mockImplementationOnce(async (_definition, _inputs, options) => {
		captured = options;
		return { status: "completed", stages: [] } as never;
	});
	const hosted = await forkRun(savedId, { ...request, registry: createRegistry(), [hostWorkerBindings]: true });
	await hosted.result;
	assert.equal(typeof captured?.onStageStart, "function", "a host that binds its workers keeps the stage events");
});

test("forkRun events can be read after the run ended, without an unhandled rejection, and ignore later notifications (#4321)", async () => {
	const { backend, runId } = await eventsSource("fork-sdk-late-events");
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		let captured: Parameters<typeof run>[2];
		vi.mocked(run).mockImplementationOnce(async (...args) => {
			captured = args[2];
			const actual = await vi.importActual<typeof import("../../packages/workflows/src/runs/foreground/sdk-run.js")>(
				"../../packages/workflows/src/runs/foreground/sdk-run.js",
			);
			return actual.run(...args);
		});
		const forked = await forkRun(runId, {
			fromStage: "worker",
			durableBackend: backend,
			definition: eventsDefinition,
			store: createStore(),
			adapters,
		});
		await forked.result;
		await new Promise<void>((resolve) => setImmediate(resolve));
		captured?.onStageSessionEvent?.(forked.runId, "late-stage", { type: "agent_start" } as AgentSessionEvent);
		const events = await collect(forked.events);
		assert.equal(events[0]?.type, "run_start");
		assert.equal(events.at(-1)?.type, "run_end");
		assert.ok(!events.some((event) => event.type === "stage_session_event" && event.stageId === "late-stage"));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a run that rejects ends the events iterator with the same error and rejects the result (#4321)", async () => {
	const { backend, runId } = await eventsSource("fork-sdk-rejected");
	const failure = new Error("run exploded");
	vi.mocked(run).mockImplementationOnce(() => Promise.reject(failure));
	const forked = await forkRun(runId, {
		fromStage: "worker",
		durableBackend: backend,
		definition: eventsDefinition,
		store: createStore(),
		adapters,
	});
	await assert.rejects(forked.result, (error: Error) => error === failure);
	await assert.rejects(collect(forked.events), (error: Error) => error === failure);
});

test("forkRun and listForkPoints name the sdk as the source of an invalid option (#4321)", async () => {
	const backend = await createMemoryTestBackend();
	const forkError = await forkRun("", { durableBackend: backend }).catch((error: Error) => error);
	assert.ok(isForkConfigError(forkError), String(forkError));
	assert.equal(forkError.source, "sdk");
	assert.equal(forkError.field, "runId");
	assert.match(forkError.message, /sdk option runId/);
	const pointsError = await collect(listForkPoints("", { durableBackend: backend }) as never).catch(
		(error: Error) => error,
	);
	assert.ok(isForkConfigError(pointsError), String(pointsError));
	assert.equal(pointsError.source, "sdk");
	assert.match(pointsError.message, /sdk option runId/);
});
