import assert from "node:assert/strict";
import {
	WorkflowRunControlUnavailableError,
	WorkflowRunDatabaseError,
	WorkflowRunNotFoundError,
	WorkflowRunNotResumableError,
	WorkflowRunOwnershipError,
} from "@bastani/atomic";
import { afterEach, beforeEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosNotReadyError } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
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
		control: createSessionRunControl({ execute, context: () => sessionContext(sessionId) }),
	};
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

	test.sequential("forwards stage and message options to the workflow tool (#3377)", async () => {
		const runId = testRunId("session-run-control-options");
		store.recordRunStart(run(runId));
		const { control } = setup();

		const pause = await control.pause(runId, { stageId: "missing-stage" });
		assert.equal(pause.status, "noop");
		assert.match(pause.message, /Stage not found in run .*missing-stage/);
		const resume = await control.resume(runId, { stageId: "missing-stage", message: "continue" });
		assert.equal(resume.status, "noop");
		assert.match(resume.message, /Stage not found in run .*missing-stage/);
	});

	test.sequential("rejects with WorkflowRunControlUnavailableError before the session starts (#3377)", async () => {
		const { execute } = setup();
		const control = createSessionRunControl({ execute, context: () => undefined });

		const error = await rejection(control.listRuns());

		assert.ok(error instanceof WorkflowRunControlUnavailableError, error.message);
		assert.equal(error.code, "WORKFLOW_RUN_CONTROL_UNAVAILABLE");
	});
});
