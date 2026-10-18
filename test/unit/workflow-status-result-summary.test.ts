import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const OUTPUTS = { answer: "forty-two", count: 3 };
const TOOL_CALLS = 12;

afterEach(() => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
});

function session(backend: DurableWorkflowBackend, sessionId: string, failAfterTools = false) {
	setDurableBackend(backend);
	const store = createStore();
	const jobs = createJobTracker();
	const definition = workflow({
		name: "result-summary",
		description: "",
		inputs: {},
		outputs: { answer: Type.String(), count: Type.Number() },
		run: async (ctx) => {
			for (let index = 0; index < TOOL_CALLS; index++) {
				await ctx.tool(`step-${index}`, { index }, async () => `output ${index} ${"x".repeat(200)}`);
			}
			if (failAfterTools) await ctx.tool("explode", {}, async () => Promise.reject(new Error("boom")));
			return OUTPUTS;
		},
	});
	const runtime = createExtensionRuntime({ registry: createRegistry().register(definition), store, jobs });
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => {},
		{ ...captureWorkflowOwnerResources(), store, jobs },
	);
	const ctx: PiExecuteContext = { sessionId, cwd: process.cwd() };
	return { execute, ctx };
}

async function finishedRun(backend: DurableWorkflowBackend, failAfterTools = false) {
	const owner = session(backend, "owner", failAfterTools);
	const started = await owner.execute({ action: "run", workflow: "result-summary", inputs: {} }, owner.ctx);
	assert.equal(started.action, "run");
	const runId = started.runId;
	await vi.waitFor(() => {
		const status = backend.getWorkflow(runId)?.status;
		assert.ok(status === "completed" || status === "failed", String(status));
	});
	return { owner, runId };
}

function detailOf(result: WorkflowToolResult) {
	assert.equal(result.action, "statusDetail");
	assert.ok("detail" in result, JSON.stringify(result));
	return result.detail;
}

function summaryOf(result: WorkflowToolResult) {
	assert.equal(result.action, "statusSummary");
	assert.ok("summary" in result, JSON.stringify(result));
	return result.summary;
}

test("status from another session includes the final outputs of a finished run (#3744)", async () => {
	const backend = await createMemoryTestBackend();
	const { runId } = await finishedRun(backend);
	const reader = session(backend, "reader");

	const result = await reader.execute({ action: "status", runId }, reader.ctx, undefined, undefined, "sdk");

	const detail = detailOf(result);
	assert.equal(detail.status, "completed");
	assert.deepEqual(detail.result, OUTPUTS);
	assert.equal(detail.tools.length, TOOL_CALLS);
});

test("status summary keeps status, outputs and blockers without the stage history (#3744)", async () => {
	const backend = await createMemoryTestBackend();
	const { runId } = await finishedRun(backend);
	const reader = session(backend, "reader");

	const full = await reader.execute({ action: "status", runId }, reader.ctx, undefined, undefined, "sdk");
	const compact = await reader.execute(
		{ action: "status", runId, summary: true },
		reader.ctx,
		undefined,
		undefined,
		"sdk",
	);

	const summary = summaryOf(compact);
	assert.equal(summary.runId, runId);
	assert.equal(summary.name, "result-summary");
	assert.equal(summary.status, "completed");
	assert.deepEqual(summary.result, OUTPUTS);
	assert.deepEqual(summary.blockers, []);
	const content = renderWorkflowToolContent(compact, { action: "status", runId, summary: true });
	assert.equal("stages" in summary || "tools" in summary || "inputs" in summary, false);
	assert.equal(content.includes("step-0"), false);
	assert.ok(content.length < renderWorkflowToolContent(full, { action: "status", runId }).length / 2);
});

test("status summary of a failed run reports the failing tool as a blocker (#3744)", async () => {
	const backend = await createMemoryTestBackend();
	const { owner, runId } = await finishedRun(backend, true);
	const reader = session(backend, "reader");

	for (const [label, execute, ctx, access] of [
		["same session", owner.execute, owner.ctx, undefined],
		["other session", reader.execute, reader.ctx, "sdk"],
	] as const) {
		const summary = summaryOf(
			await execute({ action: "status", runId, summary: true }, ctx, undefined, undefined, access),
		);
		assert.equal(summary.status, "failed", label);
		assert.deepEqual(
			summary.blockers.map(({ kind, node, name, message }) => ({ kind, node, name, message })),
			[{ kind: "failed", node: "tool", name: "explode", message: "boom" }],
			label,
		);
	}
});

test("status without summary still returns the full detail for the owning session (#3744)", async () => {
	const backend = await createMemoryTestBackend();
	const { owner, runId } = await finishedRun(backend);

	const detail = detailOf(await owner.execute({ action: "status", runId }, owner.ctx));

	assert.equal(detail.status, "completed");
	assert.deepEqual(detail.result, OUTPUTS);
	assert.equal(detail.tools.length, TOOL_CALLS);
});
