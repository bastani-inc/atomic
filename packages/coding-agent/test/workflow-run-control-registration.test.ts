import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.js";
import type { ExtensionAPI } from "../src/core/extensions/index.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import {
	type SessionWorkflows,
	WorkflowRunControlError,
	type WorkflowRunControlOutcome,
	WorkflowRunControlUnavailableError,
} from "../src/core/extensions/workflow-run-control.js";
import { SessionWorkflowsHandle } from "../src/core/extensions/workflow-run-control-hub.js";

const RUN_ID = "11111111-2222-4333-8444-555555555555";

function outcome(action: WorkflowRunControlOutcome["action"], label: string): WorkflowRunControlOutcome {
	return { action, runId: RUN_ID, status: "ok", message: label };
}

function recordingControl(label: string, calls: string[]): SessionWorkflows {
	return {
		async listRuns(filter) {
			calls.push(`${label}:listRuns:${filter?.status ?? "-"}`);
			return [];
		},
		async getRun(runId) {
			calls.push(`${label}:getRun:${runId}`);
			return { runId, name: label, status: "running", startedAt: 1, inputs: {}, stages: [] };
		},
		async getStages(runId, filter) {
			calls.push(`${label}:getStages:${runId}:${filter?.status ?? "-"}`);
			return [];
		},
		async pause(target: string | { readonly all: true }, options?: { readonly stageId?: string }) {
			calls.push(`${label}:pause:${typeof target === "string" ? target : "all"}:${options?.stageId ?? "-"}`);
			return outcome("pause", label);
		},
		async quit(target) {
			calls.push(`${label}:quit:${typeof target === "string" ? target : "all"}`);
			return outcome("quit", label);
		},
		async resume(runId, options) {
			calls.push(`${label}:resume:${runId}:${options?.stageId ?? "-"}:${options?.message ?? "-"}`);
			return outcome("resume", label);
		},
	};
}

async function setup(register: (api: ExtensionAPI) => void) {
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		register,
		process.cwd(),
		createEventBus(),
		runtime,
		"<run-control-registrar>",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);
	return { runner, handle: new SessionWorkflowsHandle(() => runner.getWorkflowRunControl()) };
}

test("session workflows delegate every method to the registered control (#3377)", async () => {
	const calls: string[] = [];
	const { runner, handle } = await setup((pi) => {
		pi.registerWorkflowRunControl(recordingControl("ext", calls));
	});

	await handle.listRuns({ status: "paused" });
	await handle.getRun(RUN_ID);
	await handle.getStages(RUN_ID, { status: "running" });
	await handle.pause(RUN_ID, { stageId: "review" });
	await handle.pause({ all: true });
	await handle.quit(RUN_ID);
	await handle.quit({ all: true });
	const resumed = await handle.resume(RUN_ID, { stageId: "review", message: "continue" });

	assert.deepEqual(calls, [
		"ext:listRuns:paused",
		`ext:getRun:${RUN_ID}`,
		`ext:getStages:${RUN_ID}:running`,
		`ext:pause:${RUN_ID}:review`,
		"ext:pause:all:-",
		`ext:quit:${RUN_ID}`,
		"ext:quit:all",
		`ext:resume:${RUN_ID}:review:continue`,
	]);
	assert.deepEqual(resumed, outcome("resume", "ext"));
	runner.invalidate();
});

test("session workflows reject with a typed error until a control is registered (#3377)", async () => {
	const { runner, handle } = await setup(() => {});
	const operations: Array<() => Promise<unknown>> = [
		() => handle.listRuns(),
		() => handle.getRun(RUN_ID),
		() => handle.getStages(RUN_ID),
		() => handle.pause(RUN_ID),
		() => handle.pause({ all: true }),
		() => handle.quit(RUN_ID),
		() => handle.resume(RUN_ID),
	];
	for (const operation of operations) {
		await assert.rejects(operation, (error: Error) => {
			assert.ok(error instanceof WorkflowRunControlUnavailableError);
			assert.ok(error instanceof WorkflowRunControlError);
			assert.equal(error.code, "WORKFLOW_RUN_CONTROL_UNAVAILABLE");
			return true;
		});
	}
	runner.invalidate();
});

test("a newer registration replaces the control and a stale disposal cannot remove it (#3377)", async () => {
	const calls: string[] = [];
	let first!: ReturnType<ExtensionAPI["registerWorkflowRunControl"]>;
	let second!: ReturnType<ExtensionAPI["registerWorkflowRunControl"]>;
	const { runner, handle } = await setup((pi) => {
		first = pi.registerWorkflowRunControl(recordingControl("first", calls));
		second = pi.registerWorkflowRunControl(recordingControl("second", calls));
	});

	await handle.getRun(RUN_ID);
	first.dispose();
	await handle.getRun(RUN_ID);
	second.dispose();
	await assert.rejects(handle.getRun(RUN_ID), WorkflowRunControlUnavailableError);

	assert.deepEqual(calls, [`second:getRun:${RUN_ID}`, `second:getRun:${RUN_ID}`]);
	runner.invalidate();
});

test("invalidating the extension generation revokes the registered control (#3377)", async () => {
	const calls: string[] = [];
	const { runner, handle } = await setup((pi) => {
		pi.registerWorkflowRunControl(recordingControl("ext", calls));
	});
	await handle.listRuns();

	runner.invalidate();

	await assert.rejects(handle.listRuns(), WorkflowRunControlUnavailableError);
	assert.deepEqual(calls, ["ext:listRuns:-"]);
});
