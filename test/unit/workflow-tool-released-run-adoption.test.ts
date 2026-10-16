import assert from "node:assert/strict";
import { WorkflowRunOwnershipError } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { releasePausedRunsOwnedBy } from "../../packages/workflows/src/durable/sdk-owner-release.js";
import type { PiEventContext, PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { WorkflowInstanceOwnershipError } from "../../packages/workflows/src/extension/workflow-instance-owner.js";
import { createSessionRunControl } from "../../packages/workflows/src/extension/workflow-session-run-control.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const PREVIOUS_SESSION = "previous-session";
const SUCCESSOR_SESSION = "successor-session";
const OTHER_SESSION = "other-session";
const DEAD_EXECUTOR_ID = "atomic-db-00000000-0000-4000-8000-000000000001";
const GENERIC_REFUSAL = "Workflow instance belongs to another caller/session.";

function adoptedElsewhereMessage(runId: string): string {
	return `Workflow ${runId} is now owned by another session; it was already adopted after its previous session was switched away.`;
}

function setup() {
	const definition = workflow({
		name: "session-run-control",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("finish", {}, async () => "done");
			return {};
		},
	});
	const runtime = createExtensionRuntime({ definitions: [definition], store });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => undefined,
	);
	return { runtime, execute };
}

function modelContext(sessionId: string): PiExecuteContext {
	return { sessionId, sessionManager: { getSessionId: () => sessionId }, cwd: process.cwd() } as PiExecuteContext;
}

function sessionContext(sessionId: string): PiEventContext {
	return {
		sessionManager: { getSessionId: () => sessionId },
		cwd: process.cwd(),
		ui: { notify: () => undefined },
		hasUI: false,
	};
}

async function registerRun(
	backend: DurableWorkflowBackend,
	runId: string,
	overrides: Partial<Parameters<DurableWorkflowBackend["commitWorkflowRegistration"]>[0]> = {},
): Promise<void> {
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "session-run-control",
		inputs: {},
		createdAt: 1,
		updatedAt: 1,
		status: "paused",
		completedCheckpoints: 1,
		modelOwner: PREVIOUS_SESSION,
		releasedModelOwner: PREVIOUS_SESSION,
		origin: "agent",
		invocationCwd: process.cwd(),
		...overrides,
	});
}

function recordPredecessorSnapshot(runId: string): void {
	store.recordRunStart({
		id: runId,
		name: "session-run-control",
		inputs: {},
		status: "paused",
		exitReason: "quit",
		resumable: true,
		startedAt: 1,
		toolNodes: [],
		stages: [],
		modelOwner: PREVIOUS_SESSION,
		origin: "agent",
	});
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

beforeEach(async () => {
	store.clear();
	setDurableBackend(await createMemoryTestBackend());
});

afterEach(() => {
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
});

describe("the model-facing workflow tool adopts runs released by a switched-away session (#3569)", () => {
	for (const [label, progress] of [
		["checkpointed", { completedCheckpoints: 1 }],
		["human-input-pending", { completedCheckpoints: 0, pendingPrompts: 1 }],
	] as const) {
		test.sequential(`the successor session's model resumes a released ${label} run and takes ownership (#3569)`, async () => {
			const runId = testRunId(`tool-released-adoption-${label}`);
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			await registerRun(backend, runId, progress);
			const { execute } = setup();
			const result = await execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION));
			assert.equal(result.action, "resume");
			assert.equal("status" in result && result.status, "running");
			assert.equal("code" in result, false);
			await vi.waitFor(() =>
				assert.equal(backend.getWorkflow(runId)?.status, "completed", JSON.stringify(backend.getWorkflow(runId))),
			);
			assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
			assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);
		});
	}

	test.sequential("the successor adopts a released run whose paused snapshot is still in the shared run store (#3569)", async () => {
		const runId = testRunId("tool-released-adoption-shared-store");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		store.recordRunStart({
			id: runId,
			name: "session-run-control",
			inputs: {},
			status: "paused",
			exitReason: "quit",
			resumable: true,
			startedAt: 1,
			toolNodes: [],
			stages: [],
			modelOwner: PREVIOUS_SESSION,
			origin: "agent",
		});
		const { execute } = setup();
		const result = await execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal("status" in result && result.status, "running");
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
		assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);
	});

	test.sequential("the original owner resuming its own released run keeps working (#3569)", async () => {
		const runId = testRunId("tool-released-original-owner");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const { execute } = setup();
		const result = await execute({ action: "resume", runId }, modelContext(PREVIOUS_SESSION));
		assert.equal("status" in result && result.status, "running");
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, PREVIOUS_SESSION);
		assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);
	});

	test.sequential("the model tool refuses unreleased, live-owned, foreign-scope and terminal runs unchanged (#3569)", async () => {
		const cases = [
			{ label: "paused run its owner never released", overrides: { releasedModelOwner: undefined } },
			{ label: "run released by a different owner", overrides: { releasedModelOwner: OTHER_SESSION } },
			{ label: "released run in another project", overrides: { invocationCwd: "/another-project" } },
			{ label: "released nested child", overrides: { rootWorkflowId: testRunId("tool-released-foreign-root") } },
			{ label: "live-owned running run", overrides: { status: "running" as const } },
			{
				label: "crashed owner's running run",
				overrides: {
					status: "running" as const,
					releasedModelOwner: undefined,
					ownerExecutorId: DEAD_EXECUTOR_ID,
					ownerLiveness: "dead" as const,
				},
			},
			{ label: "completed run", overrides: { status: "completed" as const } },
			{ label: "cancelled run", overrides: { status: "cancelled" as const } },
			{ label: "failed non-resumable run", overrides: { status: "failed" as const, resumable: false } },
		];
		for (const [index, { label, overrides }] of cases.entries()) {
			store.clear();
			const runId = testRunId(`tool-released-refusal-${index}`);
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			await registerRun(backend, runId, overrides);
			const before = structuredClone(backend.getWorkflow(runId));
			const { execute } = setup();
			const error = await rejection(execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION)));
			assert.ok(error instanceof WorkflowInstanceOwnershipError, `${label}: ${error.message}`);
			assert.equal(error.message, GENERIC_REFUSAL, label);
			assert.deepEqual(backend.getWorkflow(runId), before, label);
			assert.deepEqual(store.runs(), [], label);
		}
	});

	test.sequential("the model tool still refuses mutating actions on a released run it has not adopted (#3569)", async () => {
		const runId = testRunId("tool-released-mutating-actions");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const before = structuredClone(backend.getWorkflow(runId));
		const { execute } = setup();
		for (const action of ["pause", "quit"] as const) {
			const result = await execute({ action, runId }, modelContext(SUCCESSOR_SESSION));
			assert.equal("code" in result && result.code, "owned_elsewhere", action);
		}
		const answered = await execute(
			{ action: "answer", runId, answer: "yes" } as never,
			modelContext(SUCCESSOR_SESSION),
		);
		assert.equal("status" in answered && answered.status, "noop");
		assert.deepEqual(backend.getWorkflow(runId), before);
	});

	test.sequential("the model tool still refuses status and stages on runs that are not released to the caller (#3569)", async () => {
		const cases = [
			{ label: "paused run its owner never released", overrides: { releasedModelOwner: undefined } },
			{ label: "run released by a different owner", overrides: { releasedModelOwner: OTHER_SESSION } },
			{ label: "released run in another project", overrides: { invocationCwd: "/another-project" } },
			{ label: "live-owned running run", overrides: { status: "running" as const } },
			{ label: "completed run owned by the predecessor", overrides: { status: "completed" as const } },
		];
		for (const [index, { label, overrides }] of cases.entries()) {
			for (const inStore of [false, true]) {
				store.clear();
				const runId = testRunId(`tool-released-inspection-refusal-${index}-${inStore}`);
				const backend = await createMemoryTestBackend();
				setDurableBackend(backend);
				await registerRun(backend, runId, overrides);
				if (inStore) recordPredecessorSnapshot(runId);
				const before = structuredClone(backend.getWorkflow(runId));
				const { execute } = setup();
				for (const action of ["status", "stages"] as const) {
					const error = await rejection(execute({ action, runId }, modelContext(SUCCESSOR_SESSION)));
					assert.ok(error instanceof WorkflowInstanceOwnershipError, `${label} ${action}: ${error.message}`);
					assert.equal(error.message, GENERIC_REFUSAL, `${label} ${action}`);
				}
				assert.deepEqual(backend.getWorkflow(runId), before, label);
			}
		}
	});

	test.sequential("the successor's model inspects a released run's status before adopting it (#3569)", async () => {
		const runId = testRunId("tool-released-status-detail");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const before = structuredClone(backend.getWorkflow(runId));
		const { execute } = setup();
		const result = await execute({ action: "status", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal(result.action, "statusDetail");
		assert.equal("error" in result && result.error, false);
		assert.equal("runId" in result && result.runId, runId);
		assert.equal("detail" in result && result.detail !== undefined, true);
		assert.deepEqual(backend.getWorkflow(runId), before);
	});

	test.sequential("the successor's model inspects a released run whose predecessor snapshot is still in the store (#3569)", async () => {
		const runId = testRunId("tool-released-status-shared-store");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		recordPredecessorSnapshot(runId);
		const before = structuredClone(backend.getWorkflow(runId));
		const { execute } = setup();

		const detail = await execute({ action: "status", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal(detail.action, "statusDetail");
		assert.equal("detail" in detail && detail.detail !== undefined, true);

		const listing = await execute({ action: "status" }, modelContext(SUCCESSOR_SESSION));
		assert.equal(listing.action, "status");
		assert.deepEqual("runs" in listing ? listing.runs.map((run) => run.runId) : [], [runId]);

		const stages = await execute({ action: "stages", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal(stages.action, "stages");
		assert.equal("error" in stages && stages.error !== undefined, false);
		assert.deepEqual(backend.getWorkflow(runId), before);
	});

	test.sequential("the successor's model inspects a released run's stages without a store snapshot (#3569)", async () => {
		const runId = testRunId("tool-released-stages-durable");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const { execute } = setup();
		const stages = await execute({ action: "stages", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal(stages.action, "stages");
		assert.equal("error" in stages && stages.error !== undefined, false);
	});

	test.sequential("once another session adopts a released run, the predecessor's inspection is refused again (#3569)", async () => {
		const runId = testRunId("tool-released-inspection-after-adoption");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		const { execute } = setup();
		const first = await execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal("status" in first && first.status, "running");
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		for (const action of ["status", "stages"] as const) {
			assert.notEqual(
				(await execute({ action, runId }, modelContext(SUCCESSOR_SESSION))).action,
				undefined,
				`adopter ${action}`,
			);
			await assert.rejects(
				execute({ action, runId }, modelContext(OTHER_SESSION)),
				WorkflowInstanceOwnershipError,
				`other session ${action}`,
			);
		}
	});

	test.sequential("a released run adopted by one session tells the second adopter it is now owned elsewhere (#3569)", async () => {
		const runId = testRunId("tool-released-second-adopter");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId, { releasedModelOwner: undefined });
		await releasePausedRunsOwnedBy(backend, PREVIOUS_SESSION);
		assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, PREVIOUS_SESSION);
		const { execute } = setup();
		const first = await execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal("status" in first && first.status, "running");
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));

		const error = await rejection(execute({ action: "resume", runId }, modelContext(OTHER_SESSION)));
		assert.ok(error instanceof WorkflowInstanceOwnershipError, error.message);
		assert.equal(error.message, adoptedElsewhereMessage(runId));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
	});

	test.sequential("the runtime resume guard reports a lost adoption race as owned by another session (#3569)", async () => {
		const runId = testRunId("runtime-released-second-adopter");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId, { releasedModelOwner: undefined });
		await releasePausedRunsOwnedBy(backend, PREVIOUS_SESSION);
		assert.equal(
			await backend.commitWorkflowStatusTransition(
				runId,
				["paused"],
				"paused",
				undefined,
				undefined,
				undefined,
				SUCCESSOR_SESSION,
			),
			true,
		);
		const { runtime } = setup();
		const result = await runtime.resumeDurableWorkflow(runId, { actor: "agent", modelOwner: OTHER_SESSION });
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.reason, "owned_elsewhere");
		assert.equal(!result.ok && result.message, adoptedElsewhereMessage(runId));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
	});
});

describe("SDK session control adopts runs released by a switched-away session (#3569)", () => {
	test.sequential("the SDK adopts a released run whose paused snapshot is still in the shared run store (#3569)", async () => {
		const runId = testRunId("sdk-released-adoption-shared-store");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId);
		store.recordRunStart({
			id: runId,
			name: "session-run-control",
			inputs: {},
			status: "paused",
			exitReason: "quit",
			resumable: true,
			startedAt: 1,
			toolNodes: [],
			stages: [],
			modelOwner: PREVIOUS_SESSION,
			origin: "agent",
		});
		const { execute } = setup();
		const control = createSessionRunControl({
			execute,
			context: () => sessionContext(SUCCESSOR_SESSION),
			store,
		});
		const outcome = await control.resume(runId);
		assert.equal(outcome.status, "running");
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
		assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);
	});

	test.sequential("the SDK's second adopter gets an ownership error naming the adoption (#3569)", async () => {
		const runId = testRunId("sdk-released-second-adopter");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		await registerRun(backend, runId, { releasedModelOwner: undefined });
		await releasePausedRunsOwnedBy(backend, PREVIOUS_SESSION);
		const { execute } = setup();
		const sdk = (sessionId: string) =>
			createSessionRunControl({
				execute,
				context: () => sessionContext(sessionId),
				store,
			});
		assert.equal((await sdk(SUCCESSOR_SESSION).resume(runId)).status, "running");
		await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "completed"));
		const error = await rejection(sdk(OTHER_SESSION).resume(runId));
		assert.ok(error instanceof WorkflowRunOwnershipError, error.message);
		assert.equal(error.message, adoptedElsewhereMessage(runId));
	});
});
