import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import type { WorkflowStageOrchestrationContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { collectGarbage } from "../helpers/collect-garbage.js";

async function closeStageAfterRefusal(errors: Error[]): Promise<WeakRef<object>> {
	const stage: WorkflowStageOrchestrationContext = {
		kind: "workflow-stage",
		workflowRunId: randomUUID(),
		workflowStageId: "stage",
		workflowStageName: "stage",
		constraints: { disableWorkflowTool: true },
	};
	const harness = await createHarness({
		orchestrationContext: stage,
		sessionManager: await SessionManager.create(new MemorySessionStore(), process.cwd()),
	});
	try {
		const host = harness.session.getAgentTaskHost();
		await harness.session.reload({
			beforeSessionStart: async () => {
				await assert.rejects(
					host.startAgentTask(
						{ kind: "agent", agent: "worker", task: "work" },
						randomUUID() as OperationId,
						() => {
							throw new Error("unexpected admission");
						},
					),
					(error: Error) => {
						assert.match(error.stack ?? "", /Task owner is closed/);
						errors.push(error);
						return true;
					},
				);
			},
		});
		await harness.session.release();
		return new WeakRef(harness.session);
	} finally {
		await harness.cleanup();
		await stage.messageAdmission?.boundary.close();
	}
}

test("saving an ordinary launch refusal during reload does not retain the released stage session (#5629)", async () => {
	const errors: Error[] = [];
	const sessions: WeakRef<object>[] = [];
	for (let i = 0; i < 8; i++) sessions.push(await closeStageAfterRefusal(errors));
	await collectGarbage();
	assert.equal(errors.length, 8);
	for (const error of errors) assert.equal(error.message, "Task owner is closed");
	assert.equal(sessions.filter((session) => session.deref() !== undefined).length, 0);
});
