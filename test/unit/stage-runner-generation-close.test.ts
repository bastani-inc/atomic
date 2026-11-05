import assert from "node:assert/strict";
import { TaskCleanupError } from "@bastani/atomic";
import { test } from "vitest";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { WorkflowInfrastructureError } from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { makeMockSession, makeOpts } from "./stage-runner-helpers.js";

test("generation close waits for an in-flight session creation and closes the attached session", async () => {
	const creation = Promise.withResolvers<ReturnType<typeof makeMockSession>["session"]>();
	let closeCalls = 0;
	const context = createStageContext(
		makeOpts({
			adapters: {
				agentSession: {
					async create() {
						return creation.promise;
					},
				},
			},
		}),
	);
	const ensure = context.__ensureSession();
	let closeResolved = false;
	const close = context.__closeGeneration().then(() => {
		closeResolved = true;
	});
	await Promise.resolve();
	assert.equal(closeResolved, false);

	creation.resolve(
		makeMockSession({
			async closeWorkflowStageGeneration() {
				closeCalls += 1;
			},
		}).session,
	);
	await Promise.all([ensure, close]);

	assert.equal(closeCalls, 1);
	assert.equal(closeResolved, true);
});

test("closing a generation that never created a session, or whose adapter cannot close one, resolves (#4338)", async () => {
	await createStageContext(makeOpts()).__closeGeneration();
	const context = createStageContext(
		makeOpts({ adapters: { agentSession: { create: async () => makeMockSession().session } } }),
	);
	await context.__ensureSession();
	await context.__closeGeneration();
});

test("a generation close whose task cleanup was not confirmed fails as a retryable process_cleanup_unconfirmed (#4338)", async () => {
	const cleanup = new TaskCleanupError("stage-close", [
		{
			taskId: "task-1" as TaskId,
			resources: [
				{ resource: "process-group:7", code: "CleanupFailed", message: "Process-group exit was not confirmed" },
			],
		},
	]);
	const other = new Error("close refused");
	for (const [failure, expected] of [
		[cleanup, "infrastructure"],
		[other, "unchanged"],
	] as const) {
		const context = createStageContext(
			makeOpts({
				adapters: {
					agentSession: {
						create: async () =>
							makeMockSession({
								async closeWorkflowStageGeneration() {
									throw failure;
								},
							}).session,
					},
				},
			}),
		);
		await context.__ensureSession();
		await assert.rejects(context.__closeGeneration(), (error) => {
			if (expected === "unchanged") return error === other;
			assert.ok(error instanceof WorkflowInfrastructureError);
			assert.equal(error.code, "process_cleanup_unconfirmed");
			assert.equal(error.cause, cleanup);
			return true;
		});
	}
});
