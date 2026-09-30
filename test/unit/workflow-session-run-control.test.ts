import assert from "node:assert/strict";
import {
	WorkflowRunControlError,
	WorkflowRunControlUnavailableError,
	WorkflowRunDatabaseError,
	WorkflowRunNotFoundError,
	WorkflowRunNotResumableError,
	WorkflowRunOwnershipError,
	WorkflowStageAmbiguousError,
	WorkflowStageNotFoundError,
	WorkflowStageResumeUnsupportedError,
} from "@bastani/atomic";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	type DurableWorkflowCatalogEntries,
	type DurableWorkflowHydrationResult,
	InMemoryDurableBackend,
} from "../../packages/workflows/src/durable/backend.js";
import { DbosNotReadyError } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { createRecoverablePostgresPool } from "../../packages/workflows/src/durable/dbos-recoverable-pool.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { PiEventContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createSessionRunControl } from "../../packages/workflows/src/extension/workflow-session-run-control.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import {
	type StageControlHandle,
	type StageControlStatus,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";

const SESSION_ID = "session-a";

class ThrowingHydrationBackend extends InMemoryDurableBackend {
	override async hydrateWorkflow(): Promise<void> {
		throw new DbosNotReadyError();
	}
}

class CatalogScanCountingBackend extends InMemoryDurableBackend {
	catalogScans = 0;
	override async prepareWorkflowCatalog(): Promise<DurableWorkflowCatalogEntries> {
		this.catalogScans += 1;
		return super.prepareWorkflowCatalog();
	}
}

class FailingInspectionBackend extends InMemoryDurableBackend {
	private readonly failure: Error;
	constructor(failure: Error) {
		super();
		this.failure = failure;
	}
	override async hydrateWorkflowForInspection(): Promise<DurableWorkflowHydrationResult> {
		throw this.failure;
	}
}

async function invalidatedPostgresQueryError(): Promise<Error> {
	const borrowed = Object.assign(new Client(), { release: vi.fn() });
	let queryStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		queryStarted = resolve;
	});
	vi.spyOn(borrowed, "query").mockImplementation(() => {
		queryStarted();
	});
	const createPool = (url: string) => {
		const physical = new Pool({ connectionString: url });
		physical.connect = vi.fn(async () => borrowed) as Pool["connect"];
		physical.end = vi.fn(async () => {}) as Pool["end"];
		return physical;
	};
	const { pool, invalidate } = createRecoverablePostgresPool(
		"postgresql://fixture:unused@127.0.0.1:1/isolated?connect_timeout=3&sslmode=disable",
		{ createPool },
	);
	const pending = pool.query("SELECT 1");
	await started;
	invalidate();
	try {
		await pending;
	} catch (error) {
		await pool.end();
		assert.ok(error instanceof Error, "expected an Error rejection");
		return error;
	}
	await pool.end();
	throw new assert.AssertionError({ message: "expected the invalidated query to reject" });
}

function sessionContext(sessionId: string): PiEventContext {
	return { sessionManager: { getSessionId: () => sessionId }, ui: { notify: () => undefined }, hasUI: false };
}

function setup(sessionId: string = SESSION_ID) {
	const definition = workflow({
		name: "session-run-control",
		description: "",
		inputs: {},
		outputs: {},
		run: () => ({}),
	});
	const execute = makeExecuteWorkflowTool(
		createExtensionRuntime({ definitions: [definition], store }),
		() => undefined,
		() => undefined,
	);
	return {
		execute,
		control: createSessionRunControl({ execute, context: () => sessionContext(sessionId), store }),
	};
}

function toolContext(sessionId: string = SESSION_ID): never {
	return { sessionId, sessionManager: { getSessionId: () => sessionId } } as never;
}

function run(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id,
		name: "reviewer",
		inputs: {},
		status: "running",
		startedAt: 1,
		stages: [],
		modelOwner: SESSION_ID,
		origin: "agent",
		...overrides,
	};
}

function stageHandle(input: {
	readonly runId: string;
	readonly stageId: string;
	readonly status: () => StageControlStatus;
	readonly pause: () => Promise<void>;
	readonly resume: () => Promise<undefined>;
}): StageControlHandle {
	return {
		runId: input.runId,
		stageId: input.stageId,
		stageName: input.stageId,
		get status() {
			return input.status();
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		pause: input.pause,
		resume: input.resume,
		subscribe: () => () => {},
	};
}

function startPausableRun(runId: string): void {
	let controlStatus: StageControlStatus = "running";
	store.recordRunStart(run(runId));
	store.recordStageStart(runId, {
		id: "review",
		name: "review",
		status: "running",
		parentIds: [],
		toolEvents: [],
	});
	stageControlRegistry.register(
		stageHandle({
			runId,
			stageId: "review",
			status: () => controlStatus,
			pause: async () => {
				controlStatus = "paused";
			},
			resume: async () => undefined,
		}),
	);
}

function startUncontrollableRun(runId: string): void {
	store.recordRunStart(run(runId));
}

function withoutClock<T extends { readonly elapsedMs: number }>(summaries: readonly T[]) {
	return summaries.map((summary) => ({ ...summary, elapsedMs: 0, phaseAgeMs: 0 }));
}

async function rejection(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation;
	} catch (error) {
		assert.ok(error instanceof Error, "expected an Error rejection");
		return error;
	}
	throw new assert.AssertionError({ message: "expected the operation to reject" });
}

beforeEach(() => {
	store.clear();
	setDurableBackend(new InMemoryDurableBackend());
});

afterEach(() => {
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
});

describe("session workflow run control", () => {
	test.sequential("lists runs with the status action's data and filters by status (#3377)", async () => {
		const runId = testRunId("session-run-control-list");
		store.recordRunStart(
			run(runId, {
				stages: [
					{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [], attachable: true },
				],
			}),
		);
		store.recordStagePendingPrompt(runId, "review", {
			id: "question",
			kind: "input",
			message: "Proceed?",
			createdAt: 1,
		});
		const { execute, control } = setup();

		const listed = await control.listRuns();
		const status = await execute({ action: "status" }, { sessionId: SESSION_ID });
		assert.equal(status.action, "status");
		if (status.action !== "status") throw new Error("expected status listing");
		assert.deepEqual(withoutClock(listed), withoutClock(status.runs));
		assert.equal(listed.length, 1);
		assert.equal(listed[0]?.runId, runId);
		assert.equal(listed[0]?.name, "reviewer");
		assert.equal(listed[0]?.status, "running");
		assert.equal(listed[0]?.activeStages.length, 1);
		assert.equal(listed[0]?.awaitingInputCount, 1);
		assert.equal(listed[0]?.awaitingInput[0]?.promptId, "question");
		assert.equal(listed[0]?.awaitingInput[0]?.message, "Proceed?");

		assert.equal((await control.listRuns({ status: "awaiting_input" })).length, 1);
		assert.equal((await control.listRuns({ status: "completed" })).length, 0);

		const detail = await control.getRun(runId);
		assert.equal(detail.runId, runId);
		assert.equal(detail.stages.length, 1);
		const stages = await control.getStages(runId);
		assert.equal(stages.length, 1);
		assert.equal(stages[0]?.id, "review");
		assert.equal((await control.getStages(runId, { status: "completed" })).length, 0);
	});

	test.sequential("rejects unknown and malformed run ids with WorkflowRunNotFoundError (#3377)", async () => {
		const { control } = setup();
		const unknown = testRunId("session-run-control-unknown");
		for (const target of [unknown, "not-a-run-id"]) {
			for (const operation of [
				() => control.getRun(target),
				() => control.getStages(target),
				() => control.pause(target),
				() => control.quit(target),
				() => control.resume(target),
			]) {
				const error = await rejection(operation());
				assert.ok(error instanceof WorkflowRunNotFoundError, error.message);
				assert.equal(error.code, "WORKFLOW_RUN_NOT_FOUND");
			}
		}
		const error = await rejection(control.resume(unknown));
		assert.ok(error instanceof WorkflowRunNotFoundError, error.message);
		assert.equal(error.runId, unknown);
	});

	test.sequential("rejects runs owned by another session with WorkflowRunOwnershipError (#3377)", async () => {
		const runId = testRunId("session-run-control-foreign-session");
		store.recordRunStart(run(runId, { modelOwner: "session-b" }));
		const { control } = setup();

		for (const operation of [
			() => control.listRuns(),
			() => control.getRun(runId),
			() => control.getStages(runId),
			() => control.pause(runId),
			() => control.quit(runId),
			() => control.resume(runId),
		]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunOwnershipError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_OWNED_ELSEWHERE");
			assert.match(error.message, /another caller\/session/);
		}
	});

	test.sequential("refuses to resume a run executing in another live process as WorkflowRunOwnershipError (#3377)", async () => {
		const runId = testRunId("session-run-control-foreign-process");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: runId,
			name: "session-run-control",
			inputs: {},
			createdAt: 1,
			status: "running",
			completedCheckpoints: 3,
			ownerExecutorId: "atomic-other-process",
		});
		const { control } = setup();

		const error = await rejection(control.resume(runId));

		assert.ok(error instanceof WorkflowRunOwnershipError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_OWNED_ELSEWHERE");
		assert.equal(error.runId, runId);
		assert.match(error.message, /actively running in another Atomic session/);
	});

	test.sequential("rejects pause and quit of a run executing in another live process as WorkflowRunOwnershipError (#3377)", async () => {
		const runId = testRunId("session-run-control-foreign-process-control");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: runId,
			name: "session-run-control",
			inputs: {},
			createdAt: 1,
			status: "running",
			completedCheckpoints: 3,
			ownerExecutorId: "atomic-other-process",
		});
		const { control } = setup();

		for (const operation of [() => control.pause(runId), () => control.quit(runId)]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunOwnershipError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_OWNED_ELSEWHERE");
			assert.equal(error.runId, runId);
		}
		assert.equal((await control.pause({ all: true })).status, "noop");
		assert.equal((await control.quit({ all: true })).status, "noop");
	});

	test.sequential("rejects pause and quit of a durable run owned by another session as WorkflowRunOwnershipError (#3377)", async () => {
		const runId = testRunId("session-run-control-foreign-session-durable");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: runId,
			name: "session-run-control",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 3,
			modelOwner: "session-b",
			origin: "agent",
		});
		const { control } = setup();

		for (const operation of [() => control.pause(runId), () => control.quit(runId)]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunOwnershipError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_OWNED_ELSEWHERE");
			assert.equal(error.runId, runId);
		}
	});

	test.sequential("rejects unknown and foreign run prefixes without scanning the durable catalog (#3377)", async () => {
		const foreignId = testRunId("session-run-control-prefix-foreign");
		const backend = new CatalogScanCountingBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: foreignId,
			name: "session-run-control",
			inputs: {},
			createdAt: 1,
			status: "running",
			completedCheckpoints: 3,
			ownerExecutorId: "atomic-other-process",
		});
		const { control } = setup();

		for (const target of ["deadbeef", foreignId.slice(0, 8), testRunId("session-run-control-prefix-unknown")]) {
			for (const operation of [
				() => control.getRun(target),
				() => control.getStages(target),
				() => control.pause(target),
				() => control.quit(target),
			]) {
				const error = await rejection(operation());
				assert.ok(error instanceof WorkflowRunNotFoundError, error.message);
				assert.equal(error.code, "WORKFLOW_RUN_NOT_FOUND");
			}
		}

		assert.equal(backend.catalogScans, 0);
	});

	test.sequential("resolves a session-owned run by its 8-character prefix (#3377)", async () => {
		const runId = testRunId("session-run-control-owned-prefix");
		store.recordRunStart(
			run(runId, {
				stages: [
					{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [], attachable: true },
				],
			}),
		);
		const { control } = setup();
		const prefix = runId.slice(0, 8);

		assert.equal((await control.getRun(prefix)).runId, runId);
		assert.deepEqual(
			(await control.getStages(prefix)).map((stage) => stage.id),
			["review"],
		);
		assert.equal((await control.getRun(prefix.toUpperCase())).runId, runId);
	});

	test.sequential("reports non-resumable runs as WorkflowRunNotResumableError (#3377)", async () => {
		const completedId = testRunId("session-run-control-completed");
		store.recordRunStart(run(completedId));
		store.recordRunEnd(completedId, "completed");
		const noProgressId = testRunId("session-run-control-no-progress");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: noProgressId,
			name: "session-run-control",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		const { control } = setup();

		for (const runId of [completedId, noProgressId]) {
			const error = await rejection(control.resume(runId));
			assert.ok(error instanceof WorkflowRunNotResumableError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_NOT_RESUMABLE");
			assert.equal(error.runId, runId);
		}
	});

	test.sequential("reports database problems as WorkflowRunDatabaseError (#3377)", async () => {
		const hydrationId = testRunId("session-run-control-database-hydration");
		setDurableBackend(new ThrowingHydrationBackend());
		const { control } = setup();

		const hydration = await rejection(control.resume(hydrationId));
		assert.ok(hydration instanceof WorkflowRunDatabaseError, hydration.message);
		assert.equal(hydration.code, "WORKFLOW_RUN_DATABASE");
		assert.equal(hydration.runId, hydrationId);
		assert.match(hydration.message, /DBOS workflow durability is not ready/);

		const runId = testRunId("session-run-control-database-owner");
		store.recordRunStart(run(runId));
		setDurableBackend(undefined);
		const thrown = await rejection(control.pause(runId));
		assert.ok(thrown instanceof WorkflowRunDatabaseError, thrown.message);
		assert.ok(thrown.cause instanceof DbosNotReadyError);
	});

	test.sequential("reports a reset Postgres connection as WorkflowRunDatabaseError (#3377)", async () => {
		const failure = await invalidatedPostgresQueryError();
		setDurableBackend(new FailingInspectionBackend(failure));
		const { control } = setup();
		const runId = testRunId("session-run-control-database-reset");

		for (const operation of [() => control.getRun(runId), () => control.getStages(runId)]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunDatabaseError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_DATABASE");
			assert.equal(error.runId, runId);
			assert.equal(error.cause, failure);
		}
		for (const operation of [() => control.pause(runId), () => control.quit(runId)]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunDatabaseError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_DATABASE");
			assert.equal(error.runId, runId);
			assert.match(error.message, new RegExp(failure.message));
		}
	});

	test.sequential("returns acknowledged noop outcomes instead of throwing for benign no-ops (#3377)", async () => {
		const endedId = testRunId("session-run-control-ended");
		store.recordRunStart(run(endedId));
		store.recordRunEnd(endedId, "completed");
		const { control } = setup();

		const paused = await control.pause(endedId);
		assert.equal(paused.action, "pause");
		assert.equal(paused.runId, endedId);
		assert.equal(paused.status, "noop");
		assert.match(paused.message, /already ended/);

		const quit = await control.quit(endedId);
		assert.equal(quit.action, "quit");
		assert.equal(quit.status, "noop");

		const all = await control.pause({ all: true });
		assert.equal(all.runId, "--all");
		assert.equal(all.status, "noop");
		assert.equal((await control.quit({ all: true })).status, "noop");
	});

	test.sequential("acknowledges a live stage pause and a resume that completes the run (#3377)", async () => {
		const runId = testRunId("session-run-control-live-stage");
		const stageId = "review";
		let controlStatus: StageControlStatus = "running";
		store.recordRunStart(run(runId));
		store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
		stageControlRegistry.register(
			stageHandle({
				runId,
				stageId,
				status: () => controlStatus,
				pause: async () => {
					controlStatus = "paused";
				},
				resume: async () => {
					controlStatus = "completed";
					const stage = store.runs().find((candidate) => candidate.id === runId)?.stages[0];
					assert.ok(stage);
					store.recordStageEnd(runId, {
						...stage,
						status: "completed",
						endedAt: 3,
						durationMs: 2,
						result: "answer",
					});
					store.recordRunEnd(runId, "completed", { answer: "answer" });
					return undefined;
				},
			}),
		);
		const { control } = setup();

		const paused = await control.pause(runId, { stageId });
		assert.equal(paused.action, "pause");
		assert.equal(paused.status, "paused");
		assert.equal((await control.getRun(runId)).status, "paused");
		assert.deepEqual(
			(await control.listRuns({ status: "paused" })).map((summary) => summary.runId),
			[runId],
		);

		const resumed = await control.resume(runId, { message: "carry on" });
		assert.equal(resumed.action, "resume");
		assert.equal(resumed.runId, runId);
		assert.equal(resumed.status, "ok");
		assert.match(resumed.message, /completed/i);
		assert.equal((await control.getRun(runId)).status, "completed");
	});

	test.sequential("rejects a stage that does not exist with WorkflowStageNotFoundError (#3377)", async () => {
		const runId = testRunId("session-run-control-stage-missing");
		store.recordRunStart(run(runId));
		const { control } = setup();

		for (const operation of [
			() => control.pause(runId, { stageId: "missing-stage" }),
			() => control.resume(runId, { stageId: "missing-stage", message: "continue" }),
		]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowStageNotFoundError, error.message);
			assert.equal(error.code, "WORKFLOW_STAGE_NOT_FOUND");
			assert.equal(error.runId, runId);
			assert.match(error.message, /Stage not found in run .*missing-stage/);
		}
	});

	test.sequential("rejects an ambiguous stage with WorkflowStageAmbiguousError (#3377)", async () => {
		const runId = testRunId("session-run-control-stage-ambiguous");
		store.recordRunStart(run(runId));
		for (const id of ["review-a", "review-b"]) {
			store.recordStageStart(runId, { id, name: "review", status: "running", parentIds: [], toolEvents: [] });
		}
		const { control } = setup();

		for (const operation of [
			() => control.pause(runId, { stageId: "review" }),
			() => control.resume(runId, { stageId: "review" }),
		]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowStageAmbiguousError, error.message);
			assert.equal(error.code, "WORKFLOW_STAGE_AMBIGUOUS");
			assert.equal(error.runId, runId);
			assert.match(error.message, /Ambiguous stage identifier "review"/);
		}
	});

	test.sequential("rejects a pause of a stage with no control handle as WorkflowStageNotFoundError (#3377)", async () => {
		const runId = testRunId("session-run-control-stage-unregistered");
		store.recordRunStart(run(runId));
		store.recordStageStart(runId, { id: "review", name: "review", status: "running", parentIds: [], toolEvents: [] });
		const { control } = setup();

		const error = await rejection(control.pause(runId, { stageId: "review" }));

		assert.ok(error instanceof WorkflowStageNotFoundError, error.message);
		assert.equal(error.runId, runId);
	});

	test.sequential("rejects a stage-scoped resume of a durable run with WorkflowStageResumeUnsupportedError (#3377)", async () => {
		const runId = testRunId("session-run-control-stage-durable-resume");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: runId,
			name: "session-run-control",
			inputs: {},
			createdAt: 1,
			status: "paused",
			completedCheckpoints: 3,
		});
		const { control } = setup();

		const error = await rejection(control.resume(runId, { stageId: "review" }));

		assert.ok(error instanceof WorkflowStageResumeUnsupportedError, error.message);
		assert.equal(error.code, "WORKFLOW_STAGE_RESUME_UNSUPPORTED");
		assert.equal(error.runId, runId);
		assert.match(error.message, /Stage-scoped resume is not supported for durable workflow/);
	});

	test.sequential("resolves pausing an already paused run as an uncoded noop (#3377)", async () => {
		const runId = testRunId("session-run-control-already-paused");
		const stageId = "review";
		let controlStatus: StageControlStatus = "running";
		store.recordRunStart(run(runId));
		store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
		stageControlRegistry.register(
			stageHandle({
				runId,
				stageId,
				status: () => controlStatus,
				pause: async () => {
					controlStatus = "paused";
				},
				resume: async () => undefined,
			}),
		);
		const { execute, control } = setup();
		assert.equal((await control.pause(runId)).status, "paused");

		const again = await control.pause(runId);
		assert.equal(again.status, "noop");
		assert.equal(again.runId, runId);
		const raw = await execute({ action: "pause", runId }, toolContext());
		assert.equal(raw.action, "pause");
		assert.equal("code" in raw, false);
	});

	test.sequential("reports a batch pause that stopped only some runs as partial with the failed run ids (#3377)", async () => {
		const pausedId = testRunId("session-run-control-batch-paused");
		const failedId = testRunId("session-run-control-batch-failed");
		let pausedStatus: StageControlStatus = "running";
		for (const runId of [pausedId, failedId]) {
			store.recordRunStart(run(runId));
			store.recordStageStart(runId, {
				id: "review",
				name: "review",
				status: "running",
				parentIds: [],
				toolEvents: [],
			});
		}
		stageControlRegistry.register(
			stageHandle({
				runId: pausedId,
				stageId: "review",
				status: () => pausedStatus,
				pause: async () => {
					pausedStatus = "paused";
				},
				resume: async () => undefined,
			}),
		);
		stageControlRegistry.register(
			stageHandle({
				runId: failedId,
				stageId: "review",
				status: () => "running",
				pause: async () => {
					throw new Error("stage refused to pause");
				},
				resume: async () => undefined,
			}),
		);
		const { control } = setup();

		const outcome = await control.pause({ all: true });

		assert.equal(outcome.action, "pause");
		assert.equal(outcome.runId, "--all");
		assert.equal(outcome.status, "partial");
		assert.deepEqual(outcome.failedRuns, [
			{
				runId: failedId,
				reason: "pause_failed",
				message: "stage refused to pause",
			},
		]);
		assert.match(
			outcome.message,
			new RegExp(`Paused 1 run\\(s\\); failed to pause 1 run\\(s\\).*${failedId}: pause_failed`),
		);
		assert.equal((await control.getRun(pausedId)).status, "paused");
	});

	test.sequential("rejects a batch pause that stopped no run with the failed run ids (#3377)", async () => {
		const failedId = testRunId("session-run-control-batch-none");
		store.recordRunStart(run(failedId));
		store.recordStageStart(failedId, {
			id: "review",
			name: "review",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		stageControlRegistry.register(
			stageHandle({
				runId: failedId,
				stageId: "review",
				status: () => "running",
				pause: async () => {
					throw new Error("stage refused to pause");
				},
				resume: async () => undefined,
			}),
		);
		const { control } = setup();

		const error = await rejection(control.pause({ all: true }));

		assert.ok(error instanceof WorkflowRunControlError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_CONTROL_FAILED");
		assert.deepEqual(
			error.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[failedId, "pause_failed"]],
		);
		assert.match(error.message, new RegExp(failedId));
	});

	test.sequential("rejects a batch pause of running runs with no controllable stage while they stay running (#3377)", async () => {
		const idleId = testRunId("session-run-control-batch-idle");
		startUncontrollableRun(idleId);
		const { control } = setup();

		const error = await rejection(control.pause({ all: true }));

		assert.ok(error instanceof WorkflowRunControlError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_CONTROL_FAILED");
		assert.deepEqual(
			error.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[idleId, "no_active_stages"]],
		);
		assert.equal((await control.getRun(idleId)).status, "running");
	});

	test.sequential("reports a batch pause as partial when another run has no controllable stage (#3377)", async () => {
		const pausedId = testRunId("session-run-control-batch-mixed-ok");
		const idleId = testRunId("session-run-control-batch-mixed-idle");
		startPausableRun(pausedId);
		startUncontrollableRun(idleId);
		const { control } = setup();

		const outcome = await control.pause({ all: true });

		assert.equal(outcome.status, "partial");
		assert.deepEqual(
			outcome.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[idleId, "no_active_stages"]],
		);
		assert.equal((await control.getRun(pausedId)).status, "paused");
		assert.equal((await control.getRun(idleId)).status, "running");
	});

	test.sequential("counts a run that is already paused as stopped in a later batch pause (#3377)", async () => {
		const alreadyPausedId = testRunId("session-run-control-batch-already-paused");
		const runningId = testRunId("session-run-control-batch-newly-running");
		startPausableRun(alreadyPausedId);
		const { execute, control } = setup();
		assert.equal((await control.pause(alreadyPausedId)).status, "paused");
		startPausableRun(runningId);

		const outcome = await control.pause({ all: true });

		assert.equal(outcome.status, "paused");
		assert.equal(outcome.failedRuns, undefined);
		assert.equal((await control.getRun(runningId)).status, "paused");
		const raw = await execute({ action: "pause", all: true }, toolContext());
		assert.equal("code" in raw, false);
		assert.equal("failedRuns" in raw, false);
	});

	test.sequential("rejects a batch pause that stopped nothing when an already paused run sits beside a run with no controllable stage (#3377)", async () => {
		const pausedId = testRunId("session-run-control-batch-paused-idle-ok");
		const idleId = testRunId("session-run-control-batch-paused-idle-stuck");
		startPausableRun(pausedId);
		const { execute, control } = setup();
		assert.equal((await control.pause(pausedId)).status, "paused");
		startUncontrollableRun(idleId);

		const error = await rejection(control.pause({ all: true }));

		assert.ok(error instanceof WorkflowRunControlError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_CONTROL_FAILED");
		assert.deepEqual(
			error.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[idleId, "no_active_stages"]],
		);
		assert.equal((await control.getRun(idleId)).status, "running");
		assert.equal((await control.getRun(pausedId)).status, "paused");
		const raw = await execute({ action: "pause", all: true }, toolContext());
		assert.equal("status" in raw ? raw.status : undefined, "noop");
		assert.equal("code" in raw ? raw.code : undefined, "control_failed");
		assert.deepEqual(
			"failedRuns" in raw ? raw.failedRuns?.map((failed) => [failed.runId, failed.reason]) : undefined,
			[[idleId, "no_active_stages"]],
		);
	});

	test.sequential("rejects a batch pause that stopped nothing when an already paused run sits beside a run whose pause throws (#3377)", async () => {
		const pausedId = testRunId("session-run-control-batch-paused-refusing-ok");
		const refusingId = testRunId("session-run-control-batch-paused-refusing-stuck");
		startPausableRun(pausedId);
		const { control } = setup();
		assert.equal((await control.pause(pausedId)).status, "paused");
		store.recordRunStart(run(refusingId));
		store.recordStageStart(refusingId, {
			id: "review",
			name: "review",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		stageControlRegistry.register(
			stageHandle({
				runId: refusingId,
				stageId: "review",
				status: () => "running",
				pause: async () => {
					throw new Error("stage refused to pause");
				},
				resume: async () => undefined,
			}),
		);

		const error = await rejection(control.pause({ all: true }));

		assert.ok(error instanceof WorkflowRunControlError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_CONTROL_FAILED");
		assert.deepEqual(
			error.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[refusingId, "pause_failed"]],
		);
	});

	test.sequential("resolves a repeated batch pause as a benign noop without failed runs (#3377)", async () => {
		startPausableRun(testRunId("session-run-control-batch-repeat-a"));
		startPausableRun(testRunId("session-run-control-batch-repeat-b"));
		const { execute, control } = setup();
		assert.equal((await control.pause({ all: true })).status, "paused");

		const again = await control.pause({ all: true });

		assert.equal(again.status, "noop");
		assert.equal(again.failedRuns, undefined);
		assert.match(again.message, /already paused/);
		const raw = await execute({ action: "pause", all: true }, toolContext());
		assert.equal("code" in raw, false);
		assert.equal("failedRuns" in raw, false);
	});

	test.sequential("reports a batch quit that stopped only some runs as partial with the failed run ids (#3377)", async () => {
		const quitId = testRunId("session-run-control-batch-quit-ok");
		const failedId = testRunId("session-run-control-batch-quit-failed");
		let quitStatus: StageControlStatus = "running";
		for (const runId of [quitId, failedId]) {
			store.recordRunStart(run(runId));
			store.recordStageStart(runId, {
				id: "review",
				name: "review",
				status: "running",
				parentIds: [],
				toolEvents: [],
			});
		}
		stageControlRegistry.register(
			stageHandle({
				runId: quitId,
				stageId: "review",
				status: () => quitStatus,
				pause: async () => {
					quitStatus = "paused";
				},
				resume: async () => undefined,
			}),
		);
		stageControlRegistry.register(
			stageHandle({
				runId: failedId,
				stageId: "review",
				status: () => "running",
				pause: async () => {
					throw new Error("stage refused to pause");
				},
				resume: async () => undefined,
			}),
		);
		const { control } = setup();

		const outcome = await control.quit({ all: true });

		assert.equal(outcome.action, "quit");
		assert.equal(outcome.status, "partial");
		assert.deepEqual(
			outcome.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[failedId, "pause_failed"]],
		);
		assert.match(outcome.message, new RegExp(`failed to quit 1 run\\(s\\).*${failedId}: pause_failed`));
	});

	test.sequential("rejects a batch quit that stopped no run with the failed run ids (#3377)", async () => {
		const failedId = testRunId("session-run-control-batch-quit-none");
		store.recordRunStart(run(failedId));
		store.recordStageStart(failedId, {
			id: "review",
			name: "review",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		stageControlRegistry.register(
			stageHandle({
				runId: failedId,
				stageId: "review",
				status: () => "running",
				pause: async () => {
					throw new Error("stage refused to pause");
				},
				resume: async () => undefined,
			}),
		);
		const { control } = setup();

		const error = await rejection(control.quit({ all: true }));

		assert.ok(error instanceof WorkflowRunControlError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_CONTROL_FAILED");
		assert.deepEqual(
			error.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[failedId, "pause_failed"]],
		);
	});

	test.sequential("rejects a batch quit of running runs with no controllable stage while they stay running (#3377)", async () => {
		const idleId = testRunId("session-run-control-batch-quit-idle");
		startUncontrollableRun(idleId);
		const { control } = setup();

		const error = await rejection(control.quit({ all: true }));

		assert.ok(error instanceof WorkflowRunControlError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_CONTROL_FAILED");
		assert.deepEqual(
			error.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[idleId, "no_active_stages"]],
		);
		assert.equal((await control.getRun(idleId)).status, "running");
	});

	test.sequential("reports a batch quit as partial when another run has no controllable stage (#3377)", async () => {
		const quitId = testRunId("session-run-control-batch-quit-mixed-ok");
		const idleId = testRunId("session-run-control-batch-quit-mixed-idle");
		startPausableRun(quitId);
		startUncontrollableRun(idleId);
		const { control } = setup();

		const outcome = await control.quit({ all: true });

		assert.equal(outcome.status, "partial");
		assert.deepEqual(
			outcome.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[idleId, "no_active_stages"]],
		);
	});

	test.sequential("resolves a batch quit of runs that were already quit without failed runs (#3377)", async () => {
		const quitId = testRunId("session-run-control-batch-quit-repeat");
		startPausableRun(quitId);
		const { control } = setup();
		assert.equal((await control.quit(quitId)).status, "paused");

		const again = await control.quit({ all: true });

		assert.notEqual(again.status, "partial");
		assert.equal(again.failedRuns, undefined);
	});

	test.sequential("reports a batch quit as partial when it quits an already paused run beside a run with no controllable stage (#3377)", async () => {
		const pausedId = testRunId("session-run-control-batch-quit-paused-ok");
		const idleId = testRunId("session-run-control-batch-quit-paused-idle");
		startPausableRun(pausedId);
		const { control } = setup();
		assert.equal((await control.pause(pausedId)).status, "paused");
		startUncontrollableRun(idleId);

		const outcome = await control.quit({ all: true });

		assert.equal(outcome.status, "partial");
		assert.deepEqual(
			outcome.failedRuns?.map((failed) => [failed.runId, failed.reason]),
			[[idleId, "no_active_stages"]],
		);
		assert.equal((await control.getRun(pausedId)).status, "paused");
		assert.equal((await control.getRun(idleId)).status, "running");
	});

	test.sequential("returns a structured database_unavailable result when durable inspection fails for an unknown run (#3377)", async () => {
		const runId = testRunId("session-run-control-inspection-outage");
		setDurableBackend(new FailingInspectionBackend(new DbosNotReadyError()));
		const { execute } = setup();

		for (const action of ["pause", "quit"] as const) {
			const result = await execute({ action, runId }, toolContext());
			assert.equal(result.action, action);
			assert.equal("runId" in result ? result.runId : undefined, runId);
			assert.equal("status" in result ? result.status : undefined, "noop");
			assert.equal("code" in result ? result.code : undefined, "database_unavailable");
			assert.match("message" in result ? result.message : "", new RegExp(`Failed to ${action} run ${runId}`));
		}
	});

	test.sequential("returns a structured database_unavailable result when durable inspection throws a plain error (#3377)", async () => {
		const runId = testRunId("session-run-control-inspection-plain-error");
		setDurableBackend(new FailingInspectionBackend(new Error("connect ECONNREFUSED 127.0.0.1:5432")));
		const { execute, control } = setup();

		for (const action of ["pause", "quit"] as const) {
			const result = await execute({ action, runId }, toolContext());
			assert.equal(result.action, action);
			assert.equal("runId" in result ? result.runId : undefined, runId);
			assert.equal("status" in result ? result.status : undefined, "noop");
			assert.equal("code" in result ? result.code : undefined, "database_unavailable");
			assert.match(
				"message" in result ? result.message : "",
				new RegExp(`Failed to ${action} run ${runId}: connect ECONNREFUSED 127\\.0\\.0\\.1:5432`),
			);
		}
		for (const operation of [() => control.pause(runId), () => control.quit(runId)]) {
			const error = await rejection(operation());
			assert.ok(error instanceof WorkflowRunDatabaseError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_DATABASE");
			assert.equal(error.runId, runId);
			assert.match(error.message, /connect ECONNREFUSED 127\.0\.0\.1:5432/);
		}
	});

	test.sequential("still reports the foreign owner when durable inspection succeeds (#3377)", async () => {
		const runId = testRunId("session-run-control-inspection-healthy");
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		backend.registerWorkflow({
			workflowId: runId,
			name: "session-run-control",
			inputs: {},
			createdAt: 1,
			status: "running",
			completedCheckpoints: 3,
			ownerExecutorId: "atomic-other-process",
		});
		const { execute } = setup();

		for (const action of ["pause", "quit"] as const) {
			const result = await execute({ action, runId }, toolContext());
			assert.equal("status" in result ? result.status : undefined, "noop");
			assert.equal("code" in result ? result.code : undefined, "owned_elsewhere");
		}
	});

	test.sequential("rejects with WorkflowRunControlUnavailableError before the session starts (#3377)", async () => {
		const { execute } = setup();
		const control = createSessionRunControl({ execute, context: () => undefined, store });

		for (const operation of [() => control.listRuns(), () => control.getRun("deadbeef")]) {
			const error = await rejection(operation());

			assert.ok(error instanceof WorkflowRunControlUnavailableError, error.message);
			assert.equal(error.code, "WORKFLOW_RUN_CONTROL_UNAVAILABLE");
		}
	});
});
