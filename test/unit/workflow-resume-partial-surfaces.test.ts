import assert from "node:assert/strict";
import { type AgentSession, WORKFLOW_STAGE_SUBAGENT_GUARD_ENV } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test } from "vitest";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import {
	type StageControlHandle,
	type StageControlStatus,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import {
	createMemoryTestBackend,
	type MemoryJournalBackend as InMemoryDurableBackend,
} from "../helpers/workflow-journal.js";

async function seedPartialRun(runId: string): Promise<InMemoryDurableBackend> {
	const backend = await createMemoryTestBackend();
	setDurableBackend(backend);
	store.recordRunStart({
		id: runId,
		name: "partial",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	for (const stageId of ["resume-ok", "resume-fail"]) {
		store.recordStageStart(runId, { id: stageId, name: stageId, status: "running", parentIds: [], toolEvents: [] });
		store.recordStagePaused(runId, stageId);
	}
	store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "partial",
		inputs: {},
		createdAt: 1,
		status: "paused",
	});
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId: runId,
		checkpointId: "progress",
		name: "progress",
		argsHash: "progress",
		output: "done",
		completedAt: 2,
	});
	registerHandle(runId, "resume-ok", async (setStatus) => {
		setStatus("running");
		store.recordStageResumed(runId, "resume-ok");
		store.recordRunResumed(runId);
	});
	registerHandle(runId, "resume-fail", async () => {
		throw new Error("surface resume failed");
	});
	return backend;
}

function registerHandle(
	runId: string,
	stageId: string,
	resume: (setStatus: (status: StageControlStatus) => void) => Promise<void>,
): void {
	let status: StageControlStatus = "paused";
	const handle: StageControlHandle = {
		runId,
		stageId,
		stageName: stageId,
		get status() {
			return status;
		},
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {
			status = "paused";
		},
		async resume() {
			await resume((next) => {
				status = next;
			});
		},
		subscribe: () => () => {},
	};
	stageControlRegistry.register(handle);
}

beforeEach(() => {
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
});

afterEach(() => {
	delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
	stageControlRegistry.clear();
	toolControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
});

describe("partial resume command surfaces", () => {
	for (const parentAcknowledged of [false, true]) {
		test.sequential(`runtime resume failure reports only acknowledged progress: ${parentAcknowledged} (#3670)`, async () => {
			const runId = testRunId("runtime-resume-progress");
			const childRunId = testRunId("runtime-resume-child");
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			store.recordRunStart({
				id: runId,
				name: "parent",
				inputs: {},
				status: "paused",
				toolNodes: [],
				stages: [
					{
						id: "child",
						name: "child",
						status: "awaiting_input",
						parentIds: [],
						toolEvents: [],
						workflowChildRun: { alias: "child", workflow: "child", runId: childRunId },
					},
				],
				startedAt: 1,
			});
			store.recordRunStart({
				id: childRunId,
				name: "child",
				inputs: {},
				status: "paused",
				toolNodes: [],
				stages: [],
				parentRunId: runId,
				parentStageId: "child",
				startedAt: 1,
			});
			let parentCalls = 0;
			let childCalls = 0;
			toolControlRegistry.registerRun(runId, {
				paused: true,
				async pause() {},
				async quit() {},
				async resume() {
					parentCalls += 1;
					if (!parentAcknowledged) throw new Error("parent resume refused");
					store.recordRunResumed(runId);
				},
			});
			toolControlRegistry.registerRun(childRunId, {
				paused: true,
				async pause() {},
				async quit() {},
				async resume() {
					childCalls += 1;
					throw new Error("child resume refused");
				},
			});
			const runtime = createExtensionRuntime({ definitions: [], store });
			const execute = makeExecuteWorkflowTool(
				runtime,
				() => undefined,
				() => undefined,
			);

			const result = await execute({ action: "resume", runId }, {} as never);

			assert.equal(parentCalls, 1);
			assert.equal(childCalls, parentAcknowledged ? 1 : 0);
			assert.equal(result.action, "resume");
			assert.equal(result.status, parentAcknowledged ? "partial" : "noop");
			assert.equal(result.code, parentAcknowledged ? undefined : "control_failed");
			assert.match(result.message, parentAcknowledged ? /child resume refused/ : /parent resume refused/);
			assert.equal(store.runs().find((run) => run.id === runId)?.status, parentAcknowledged ? "running" : "paused");
			assert.equal(store.runs().find((run) => run.id === childRunId)?.status, "paused");
		});
	}

	test.sequential("failed targeted resume ignores an unchanged running sibling (#3670)", async () => {
		const runId = testRunId("targeted-resume-no-progress");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		store.recordRunStart({
			id: runId,
			name: "targeted",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		for (const stageId of ["target", "sibling"]) {
			store.recordStageStart(runId, {
				id: stageId,
				name: stageId,
				status: "running",
				parentIds: [],
				toolEvents: [],
			});
		}
		store.recordStagePaused(runId, "target");
		await backend.registerWorkflow({
			workflowId: runId,
			name: "targeted",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		let resumeCalls = 0;
		registerHandle(runId, "target", async () => {
			resumeCalls += 1;
			throw new Error("delivery refused before release");
		});
		const runtime = createExtensionRuntime({ definitions: [], store });
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => undefined,
		);

		const result = await execute({ action: "resume", runId, stageId: "target" }, {} as never);

		assert.equal(resumeCalls, 1);
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(run?.stages.find((stage) => stage.id === "target")?.status, "paused");
		assert.equal(run?.stages.find((stage) => stage.id === "sibling")?.status, "running");
		assert.equal(result.action, "resume");
		assert.equal(result.status, "noop");
		assert.equal(result.code, "control_failed");
		assert.match(result.message, /delivery refused before release/);
		assert.doesNotMatch(result.message, /partially resumed/i);
	});

	test.sequential("workflow tool preserves result identity and reports partial failure", async () => {
		const runId = testRunId("tool-partial-resume");
		const backend = await seedPartialRun(runId);
		const runtime = createExtensionRuntime({ definitions: [], store });
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => undefined,
		);

		const result = await execute({ action: "resume", runId }, {} as never);

		assert.deepEqual(Object.keys(result).sort(), ["action", "message", "runId", "status"]);
		assert.equal(result.action, "resume");
		assert.equal(result.runId, runId);
		assert.equal(result.status, "partial");
		assert.match(result.message, /partially resumed/i);
		assert.match(result.message, new RegExp(`${runId}/resume-fail.*surface resume failed`));
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
		assert.equal(backend.getWorkflow(runId)?.status, "running");
	});

	test.sequential("workflow tool reports durable resume failure as partial when a stage is running", async () => {
		async function createThrowRunningBackend() {
			const backend = Object.assign(await createMemoryTestBackend(), {});
			const basetransitionWorkflowStatus = backend.commitWorkflowStatusTransition.bind(backend);
			return Object.assign(backend, {
				async commitWorkflowStatusTransition(
					...args: Parameters<InMemoryDurableBackend["commitWorkflowStatusTransition"]>
				): Promise<boolean> {
					if (args[2] === "running") throw new Error("durable running write failed");
					return await basetransitionWorkflowStatus(...args);
				},
			});
		}
		const runId = testRunId("tool-durable-resume-failure");
		const backend = await createThrowRunningBackend();
		setDurableBackend(backend);
		store.recordRunStart({
			id: runId,
			name: "partial",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart(runId, { id: "only", name: "only", status: "running", parentIds: [], toolEvents: [] });
		store.recordStagePaused(runId, "only");
		store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "partial",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		await backend.commitCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "progress",
			name: "progress",
			argsHash: "progress",
			output: "done",
			completedAt: 2,
		});
		registerHandle(runId, "only", async (setStatus) => {
			setStatus("running");
			store.recordStageResumed(runId, "only");
			store.recordRunResumed(runId);
		});
		const runtime = createExtensionRuntime({ definitions: [], store });
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => undefined,
		);

		const result = await execute({ action: "resume", runId }, {} as never);

		assert.deepEqual(Object.keys(result).sort(), ["action", "message", "runId", "status"]);
		assert.equal(result.action, "resume");
		assert.equal(result.status, "partial");
		assert.match(result.message, /durable running write failed/);
		assert.equal(store.runs().find((run) => run.id === runId)?.stages[0]?.status, "running");
	});

	test.sequential("workflow tool retries transient durable reconciliation on a later resume request", async () => {
		async function createTransientRunningBackend() {
			const backend = Object.assign(await createMemoryTestBackend(), { runningAttempts: 0 });
			const basetransitionWorkflowStatus = backend.commitWorkflowStatusTransition.bind(backend);
			return Object.assign(backend, {
				async commitWorkflowStatusTransition(
					...args: Parameters<InMemoryDurableBackend["commitWorkflowStatusTransition"]>
				): Promise<boolean> {
					if (args[2] === "running" && ++backend.runningAttempts === 1)
						throw new Error("transient public durable failure");
					return await basetransitionWorkflowStatus(...args);
				},
			});
		}
		const runId = testRunId("tool-durable-resume-retry");
		const backend = await createTransientRunningBackend();
		setDurableBackend(backend);
		store.recordRunStart({
			id: runId,
			name: "partial",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart(runId, { id: "only", name: "only", status: "running", parentIds: [], toolEvents: [] });
		store.recordStagePaused(runId, "only");
		store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "partial",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		await backend.commitCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "progress",
			name: "progress",
			argsHash: "progress",
			output: "done",
			completedAt: 2,
		});
		registerHandle(runId, "only", async (setStatus) => {
			setStatus("running");
			store.recordStageResumed(runId, "only");
			store.recordRunResumed(runId);
		});
		const runtime = createExtensionRuntime({ definitions: [], store });
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => undefined,
		);

		const first = await execute({ action: "resume", runId }, {} as never);
		assert.equal(first.action, "resume");
		assert.equal(first.runId, runId);
		assert.equal(first.status, "partial");
		assert.match(first.message, /transient public durable failure/);
		assert.equal(backend.getWorkflow(runId)?.status, "paused");

		const second = await execute({ action: "resume", runId }, {} as never);
		assert.equal(second.action, "resume");
		assert.equal(second.runId, runId);
		assert.equal(second.status, "ok");
		assert.equal(backend.runningAttempts, 2);
		assert.equal(backend.getWorkflow(runId)?.status, "running");
	});

	test.sequential("no-target slash selector reports resume rejection through the reporter", async () => {
		const runId = testRunId("slash-picker-resume-failure");
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		store.recordRunStart({
			id: runId,
			name: "picker",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart(runId, { id: "only", name: "only", status: "running", parentIds: [], toolEvents: [] });
		store.recordStagePaused(runId, "only");
		store.recordRunPaused(runId, undefined, { resumable: true, exitReason: "quit" });
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "picker",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		await backend.commitCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "progress",
			name: "progress",
			argsHash: "progress",
			output: "done",
			completedAt: 2,
		});
		registerHandle(runId, "only", async () => {
			throw new Error("picker resume rejected");
		});
		const runtime = createExtensionRuntime({ definitions: [], store });
		const info: string[] = [];
		const errors: string[] = [];
		// Host session-picker seam: auto-select the first (live) row shortly
		// after open, mirroring a user hitting Enter on the seeded top row.
		const hostSessionPicker = (request: { sessions: Array<{ path: string }> }) => ({
			result: new Promise<string | undefined>((resolve) => {
				setTimeout(() => resolve(request.sessions[0]?.path), 10);
			}),
			update: () => undefined,
			error: () => undefined,
			close: () => undefined,
		});

		await handleRunControlCommand(
			"resume",
			[],
			{ hasUI: true, ui: { notify: () => undefined, custom: () => undefined, hostSessionPicker } } as never,
			{ info: (message) => info.push(message), error: (message) => errors.push(message) },
			{
				pi: {},
				overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
			},
		);

		assert.deepEqual(info, []);
		assert.match(errors.join("\n"), /Failed to resume run.*picker resume rejected/);
	});

	test.sequential("slash resume reports the same partial failure instead of success or noop", async () => {
		const runId = testRunId("slash-partial-resume");
		const backend = await seedPartialRun(runId);
		const runtime = createExtensionRuntime({ definitions: [], store });
		const info: string[] = [];
		const errors: string[] = [];

		await handleRunControlCommand(
			"resume",
			[runId],
			{ hasUI: false, ui: { notify: () => undefined } },
			{ info: (message) => info.push(message), error: (message) => errors.push(message) },
			{
				pi: {},
				overlay: { open: () => undefined, toggle: () => undefined, close: () => undefined },
				runtimeForContext: () => runtime,
				ensureWorkflowResourcesLoaded: () => undefined,
			},
		);

		assert.deepEqual(info, []);
		assert.match(errors.join("\n"), /partially resumed/i);
		assert.match(errors.join("\n"), new RegExp(`${runId}/resume-fail.*surface resume failed`));
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
		assert.equal(backend.getWorkflow(runId)?.status, "running");
	});
});
