// @ts-nocheck
import { describe, test } from "vitest";
import { getDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { testRunId } from "../helpers/run-id.js";
import type { ExtensionRuntime } from "./slash-dispatch-utils.js";
import {
	assert,
	createExtensionRuntime,
	createRegistry,
	installSlashDispatchTestHooks,
	jobTracker,
	makeExecuteWorkflowTool,
	store,
	Type,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
	workflow,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("tool run-control actions", () => {
	function _makeToolHandler() {
		const registry = createRegistry([]);
		const runtime = createExtensionRuntime({ registry });
		return makeExecuteWorkflowTool(runtime, () => undefined);
	}

	function _makeDispatchTrackingWorkflowHandler(): {
		handler: ReturnType<typeof makeExecuteWorkflowTool>;
		wasDispatched: () => boolean;
	} {
		let dispatched = false;
		const runtime = {
			dispatch: async () => {
				dispatched = true;
				return {
					action: "run",
					runId: "unexpected",
					status: "running",
					stages: [],
				};
			},
		} as unknown as ExtensionRuntime;

		return {
			handler: makeExecuteWorkflowTool(runtime, () => undefined),
			wasDispatched: () => dispatched,
		};
	}

	function _restoreWorkflowStageGuard(previousGuard: string | undefined): void {
		if (previousGuard === undefined) {
			delete process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV];
			return;
		}
		process.env[WORKFLOW_STAGE_SUBAGENT_GUARD_ENV] = previousGuard;
	}

	function _assertWorkflowToolBlocked(result: WorkflowToolResult, wasDispatched: () => boolean): void {
		assert.equal(wasDispatched(), false);
		assert.match((result as { error?: string }).error ?? "", /workflows cannot invoke workflows/);
	}
	// #3106: resume retains one instance and replays completed checkpoints without effects.
	test("makeExecuteWorkflowTool resumes the same failed resumable workflow", async () => {
		const sourceRunId = testRunId(`resume-tool-source-${Date.now()}`);
		const def = workflow({
			name: "tool-resume-wf",
			description: "",
			inputs: {},
			outputs: {
				first: Type.Optional(Type.Any()),
				second: Type.Optional(Type.Any()),
			},
			run: async (ctx) => {
				const first = await ctx.stage("first").prompt("first");
				const second = await ctx.stage("second").prompt(`second:${first}`);
				return { first, second };
			},
		});

		store.recordRunStart({
			id: sourceRunId,
			name: def.name,
			inputs: {},
			status: "running",
			startedAt: Date.now(),
			toolNodes: [],
			stages: [],
		});
		store.recordStageStart(sourceRunId, {
			id: "old-first",
			name: "first",
			replayKey: "stage:first:1",
			status: "completed",
			parentIds: [],
			toolEvents: [],
			result: "first-old",
		});
		store.recordStageEnd(sourceRunId, {
			id: "old-first",
			name: "first",
			replayKey: "stage:first:1",
			status: "completed",
			parentIds: [],
			toolEvents: [],
			result: "first-old",
		});
		store.recordStageStart(sourceRunId, {
			id: "old-second",
			name: "second",
			replayKey: "stage:second:1",
			status: "failed",
			parentIds: ["old-first"],
			toolEvents: [],
			error: "rate limit",
		});
		store.recordStageEnd(sourceRunId, {
			id: "old-second",
			name: "second",
			replayKey: "stage:second:1",
			status: "failed",
			parentIds: ["old-first"],
			toolEvents: [],
			error: "rate limit",
		});
		store.recordRunEnd(sourceRunId, "failed", undefined, "rate limit", {
			resumable: true,
			failedStageId: "old-second",
			failureKind: "rate_limit",
		});
		getDurableBackend().registerWorkflow({
			workflowId: sourceRunId,
			name: def.name,
			inputs: {},
			createdAt: Date.now(),
			status: "failed",
			resumable: true,
		});

		const calls: string[] = [];
		const runtime = createExtensionRuntime({
			registry: createRegistry([def]),
			store,
			adapters: {
				prompt: {
					prompt: async (text) => {
						calls.push(text);
						return "second-new";
					},
				},
			},
		});
		const handler = makeExecuteWorkflowTool(runtime, () => undefined);

		const result = await handler({ action: "resume", runId: sourceRunId }, {} as never);

		assert.equal(result.action, "resume");
		const r = result as {
			action: string;
			status: string;
			runId: string;
			message: string;
		};
		assert.equal(r.status, "running");
		assert.equal(r.runId, sourceRunId);
		assert.match(r.message, /Resuming durable workflow.*completed checkpoints will be replayed/);
		await jobTracker.get(r.runId)?.promise;
		assert.deepEqual(calls, ["second:first-old"]);
		const continued = store.runs().find((run) => run.id === r.runId)!;
		assert.equal(continued.status, "completed");
		assert.equal(continued.resumedFromRunId, sourceRunId);
		assert.equal(continued.stages[0]!.replayed, true);
		assert.equal(store.runs().filter((run) => run.id === sourceRunId).length, 1);
		assert.equal(getDurableBackend().getWorkflow(sourceRunId)?.status, "completed");
	});
});
