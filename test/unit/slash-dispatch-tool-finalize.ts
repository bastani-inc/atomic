// @ts-nocheck
import { describe, test } from "vitest";
import { testRunId } from "../helpers/run-id.js";
import type { ExtensionRuntime } from "./slash-dispatch-utils.js";
import {
	assert,
	createExtensionRuntime,
	createRegistry,
	installSlashDispatchTestHooks,
	makeExecuteWorkflowTool,
	makeInflightRun,
	store,
	WORKFLOW_STAGE_SUBAGENT_GUARD_ENV,
} from "./slash-dispatch-utils.js";

installSlashDispatchTestHooks();

describe("tool run-control actions", () => {
	function makeToolHandler() {
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
	test.sequential("makeExecuteWorkflowTool resume surfaces workflow_not_found for failed resumable run without registry definition", async () => {
		const runId = testRunId(`resume-tool-failed-${Date.now()}`);
		store.recordRunStart(makeInflightRun(runId));
		store.recordStageStart(runId, {
			id: "stage-a",
			name: "stage-a",
			status: "failed",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStageEnd(runId, {
			id: "stage-a",
			name: "stage-a",
			status: "failed",
			parentIds: [],
			toolEvents: [],
			error: "boom",
		});
		store.recordRunEnd(runId, "failed", undefined, "boom", {
			resumable: true,
			failedStageId: "stage-a",
		});

		const handler = makeToolHandler();

		const result = await handler({ action: "resume", runId }, {} as never);

		assert.equal(result.action, "resume");
		const r = result as {
			action: string;
			status: string;
			runId: string;
			message: string;
		};
		assert.equal(r.status, "noop");
		assert.equal(r.runId, runId);
		assert.match(r.message, /workflow_not_found/);
	});
});
